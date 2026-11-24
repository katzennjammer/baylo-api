import { NextRequest, NextResponse } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { notifyUser } from "@/lib/realtime"
import { createMessageSchema, parseBody } from "@/lib/validation"
import { blockDirection, enforceNotBlocked } from "@/lib/blocking"
import { legacyOrgRefusal, resolveInbox } from "@/lib/inbox"
import { clearedAt } from "@/lib/chat-prefs"

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

    // "Delete chat" hides what came before it, for this account only.
    const me = await prisma.user.findUnique({ where: { id: inboxId }, select: { clearedChats: true } })
    const cleared = clearedAt(me?.clearedChats, partnerId)

    const messages = await prisma.message.findMany({
      where: {
        OR: [
          { senderId: inboxId, receiverId: partnerId },
          { senderId: partnerId, receiverId: inboxId },
        ],
        ...(cleared ? { createdAt: { gt: cleared } } : {}),
      },
      orderBy: { createdAt: "asc" },
      // The message a reply answers, enough to quote it and jump to it.
      include: { replyTo: { select: { id: true, content: true, senderId: true } } },
    })

    await prisma.message.updateMany({
      where: { senderId: partnerId, receiverId: inboxId, read: false },
      data: { read: true },
    })
    // An offer notification for this conversation is read too: opening the
    // chat IS reading it. Scoped to the messages link, so a comment on a
    // listing (also NEW_MESSAGE, linked to the item) is left alone.
    await prisma.notification.updateMany({
      where: {
        userId: inboxId,
        actorId: partnerId,
        type: "NEW_MESSAGE",
        read: false,
        link: { startsWith: "/dashboard/messages" },
      },
      data: { read: true },
    })

    return NextResponse.json(messages)
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

/**
 * DELETE /api/messages?partnerId= -- hiding a conversation. GONE since schema
 * v2: the hidden-conversations feature was removed with its table
 * (ConversationHide). 410 rather than 404 so a shipped client that still
 * offers "hide" gets an answer it can show instead of a broken URL.
 */
export async function DELETE() {
  return NextResponse.json(
    { error: "Hiding conversations is no longer available.", code: "GONE" },
    { status: 410 },
  )
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
    const { receiverId, content, tradeId, replyToId } = parsed.data

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

    // A message may only be filed under a trade between these same two parties;
    // otherwise anyone could post into a stranger's trade thread.
    if (tradeId) {
      const pair = [senderId, receiverId]
      const trade = await prisma.trade.count({
        where: { id: tradeId, senderId: { in: pair }, receiverId: { in: pair } },
      })
      if (trade === 0) return NextResponse.json({ error: "Trade not found" }, { status: 404 })
    }

    // A reply must answer a message in THIS chat, not someone else's.
    if (replyToId) {
      const pair = [senderId, receiverId]
      const original = await prisma.message.count({
        where: { id: replyToId, senderId: { in: pair }, receiverId: { in: pair } },
      })
      if (original === 0) return NextResponse.json({ error: "The message you replied to is gone" }, { status: 404 })
    }

    const message = await prisma.$transaction(async (tx) => {
      return tx.message.create({
        data: {
          senderId,
          receiverId,
          content,
          tradeId: tradeId || null,
          replyToId: replyToId || null,
        },
        include: { replyTo: { select: { id: true, content: true, senderId: true } } },
      })
    })

    await prisma.notification.updateMany({
      where: {
        userId: receiverId,
        actorId: senderId,
        type: "NEW_MESSAGE",
        message: "sent you a message",
        read: false,
      },
      data: { read: true },
    })

    // ONE unread "sent you a message" row per sender: the older ones were just
    // marked read above. Creating it is what sends the PUSH -- the Prisma hook
    // in @/lib/prisma calls @/lib/push on every notification.create -- and
    // without it a chat reached the phone only while the app was open
    // (Pusher). The bell still hides these rows (excludeDirectMessageNotifications
    // in @/lib/inbox), a muted chat is still filtered in @/lib/push, and the
    // push text is "<name> sent you a message", never the message body.
    await prisma.notification.create({
      data: {
        userId: receiverId,
        actorId: senderId,
        type: "NEW_MESSAGE",
        message: "sent you a message",
        link: `/dashboard/messages?partner=${encodeURIComponent(senderId)}`,
        entityType: "conversation",
        entityId: senderId,
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
      replyToId: message.replyToId,
      replyTo: message.replyTo,
      senderName: shop ? shop.name ?? inbox.acting.organization?.name ?? "" : session.user.name ?? "",
      senderAvatar: shop ? shop.avatar ?? null : session.user.image ?? null,
    }
    // The message is saved. A 500 here made the phone keep the draft and a
    // second tap saved it twice. See @/lib/realtime.
    await notifyUser(receiverId, "new-message", payload)

    return NextResponse.json(message, { status: 201 })
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
