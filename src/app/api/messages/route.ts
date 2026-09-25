import { NextRequest, NextResponse } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import pusher from "@/lib/pusher"
import { createMessageSchema, parseBody } from "@/lib/validation"
import { blockDirection, enforceNotBlocked } from "@/lib/blocking"
import { legacyOrgRefusal, resolveInbox } from "@/lib/inbox"

// Every handler here reads and writes as `inboxId`: the person, or -- acting
// as a shop -- the shop's backing row. See @/lib/inbox for why a shop's inbox
// is shared by its members and why a dead context is a 403 and not a fallback.

export async function GET(req: NextRequest) {
  try {
    const session = await resolveSession()
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const inbox = await resolveInbox(session.user.id, req.headers)
    if (!inbox.ok) return legacyOrgRefusal(inbox.message)
    const { inboxId } = inbox

    const partnerId = new URL(req.url).searchParams.get("partnerId")
    if (!partnerId) return NextResponse.json({ error: "partnerId required" }, { status: 400 })

    // HIDDEN, NOT DELETED. The rows stay in the table -- a moderator reading a
    // harassment report needs the conversation that caused it, and deleting
    // history on block would destroy evidence at the request of either party,
    // including the harasser. What changes is that neither side can open it.
    //
    // Note the `read` flag is NOT flipped below on this path: marking a blocked
    // thread as read would let the block silently clear the other party's
    // unread badge, which is state the blocker no longer gets to touch.
    const direction = await blockDirection(inboxId, partnerId)
    if (direction !== "none") {
      return NextResponse.json(
        {
          error: "This conversation is unavailable.",
          code: "BLOCKED",
          // The blocker is told they can undo it; the blocked party is told
          // nothing that distinguishes their case from the other. Same status,
          // same error text, one extra boolean that is only ever true for the
          // person who already knows.
          youBlocked: direction === "byViewer" || direction === "mutual",
        },
        { status: 403 },
      )
    }

    const hidden = await prisma.conversationHide.findUnique({
      where: { viewerId_partnerId: { viewerId: inboxId, partnerId } },
      select: { id: true },
    })
    if (hidden) return NextResponse.json([])

    const messages = await prisma.message.findMany({
      where: {
        OR: [
          { senderId: inboxId, receiverId: partnerId },
          { senderId: partnerId, receiverId: inboxId },
        ],
      },
      orderBy: { createdAt: "asc" },
    })

    await prisma.message.updateMany({
      where: { senderId: partnerId, receiverId: inboxId, read: false },
      data: { read: true },
    })

    return NextResponse.json(messages)
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await resolveSession()
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const inbox = await resolveInbox(session.user.id, req.headers)
    if (!inbox.ok) return legacyOrgRefusal(inbox.message)
    const { inboxId } = inbox

    const partnerId = new URL(req.url).searchParams.get("partnerId")
    if (!partnerId) return NextResponse.json({ error: "partnerId required" }, { status: 400 })

    // Acting as a shop this hides the thread for every member: one inbox.
    const hidden = await prisma.conversationHide.upsert({
      where: { viewerId_partnerId: { viewerId: inboxId, partnerId } },
      create: { viewerId: inboxId, partnerId },
      update: { hiddenAt: new Date() },
      select: { hiddenAt: true },
    })

    await prisma.notification.deleteMany({
      where: { userId: inboxId, actorId: partnerId, type: "NEW_MESSAGE" },
    })

    return NextResponse.json({ ok: true, hiddenAt: hidden.hiddenAt.toISOString() })
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await resolveSession()
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const inbox = await resolveInbox(session.user.id, req.headers)
    if (!inbox.ok) return legacyOrgRefusal(inbox.message)
    // The AUTHOR on the wire: the shop's backing row when acting as it, so the
    // customer sees the shop's name and logo rather than the staff member's.
    const senderId = inbox.inboxId

    const parsed = await parseBody(req, createMessageSchema)
    if (!parsed.ok) return parsed.response
    const { receiverId, content, tradeId } = parsed.data

    // Reachable only as a shop: a staff member acting as the shop and opening
    // the shop's own storefront. A thread with oneself has no other side.
    if (receiverId === senderId) {
      return NextResponse.json({ error: "You cannot message yourself" }, { status: 400 })
    }

    // Blocked users cannot message each other -- in either direction, and
    // regardless of whether a trade between them is in progress. See the note
    // above blockConsequences() in @/lib/blocking for why the trade stays alive
    // while the channel closes: the block shuts new contact, it does not rewind
    // an obligation, and a block that stayed porous "just for this trade" would
    // reopen exactly the channel the user blocked to close.
    const blocked = await enforceNotBlocked(senderId, receiverId, "message this person")
    if (blocked) return blocked

    const message = await prisma.$transaction(async (tx) => {
      // A new message reopens the conversation for both people, including the
      // recipient who hid it earlier. Message rows themselves are immutable
      // history and are never deleted by the hide action.
      await tx.conversationHide.deleteMany({
        where: {
          OR: [
            { viewerId: senderId, partnerId: receiverId },
            { viewerId: receiverId, partnerId: senderId },
          ],
        },
      })
      return tx.message.create({
        data: {
          senderId,
          receiverId,
          content,
          tradeId: tradeId || null,
        },
      })
    })

    await prisma.notification.deleteMany({
      where: { userId: receiverId, actorId: senderId, type: "NEW_MESSAGE", read: false },
    })
    await prisma.notification.create({
      data: {
        userId: receiverId,
        type: "NEW_MESSAGE",
        message: "sent you a message",
        link: `/dashboard/messages?partner=${senderId}`,
        actorId: senderId,
      },
    })

    // The backing row carries the shop's name and its logo in `avatar`; the
    // session carries the person's. Only the shop case costs a read.
    const shop = inbox.acting.organization
      ? await prisma.user.findUnique({ where: { id: senderId }, select: { name: true, avatar: true } })
      : null

    // Push to receiver's private channel
    const payload = {
      id: message.id,
      content: message.content,
      senderId: message.senderId,
      receiverId: message.receiverId,
      createdAt: message.createdAt.toISOString(),
      senderName: shop ? shop.name ?? inbox.acting.organization?.name ?? "" : session.user.name ?? "",
      senderAvatar: shop ? shop.avatar ?? null : session.user.image ?? null,
    }
    pusher.trigger(`private-user-${receiverId}`, "new-message", payload).catch(() => {})

    return NextResponse.json(message, { status: 201 })
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
