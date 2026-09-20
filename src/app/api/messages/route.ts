import { NextRequest, NextResponse } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import pusher from "@/lib/pusher"
import { createMessageSchema, parseBody } from "@/lib/validation"
import { blockDirection, enforceNotBlocked } from "@/lib/blocking"

export async function GET(req: NextRequest) {
  try {
    const session = await resolveSession()
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

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
    const direction = await blockDirection(session.user.id, partnerId)
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
      where: { viewerId_partnerId: { viewerId: session.user.id, partnerId } },
      select: { id: true },
    })
    if (hidden) return NextResponse.json([])

    const messages = await prisma.message.findMany({
      where: {
        OR: [
          { senderId: session.user.id, receiverId: partnerId },
          { senderId: partnerId, receiverId: session.user.id },
        ],
      },
      orderBy: { createdAt: "asc" },
    })

    await prisma.message.updateMany({
      where: { senderId: partnerId, receiverId: session.user.id, read: false },
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

    const partnerId = new URL(req.url).searchParams.get("partnerId")
    if (!partnerId) return NextResponse.json({ error: "partnerId required" }, { status: 400 })

    const hidden = await prisma.conversationHide.upsert({
      where: { viewerId_partnerId: { viewerId: session.user.id, partnerId } },
      create: { viewerId: session.user.id, partnerId },
      update: { hiddenAt: new Date() },
      select: { hiddenAt: true },
    })

    await prisma.notification.deleteMany({
      where: { userId: session.user.id, actorId: partnerId, type: "NEW_MESSAGE" },
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

    const parsed = await parseBody(req, createMessageSchema)
    if (!parsed.ok) return parsed.response
    const { receiverId, content, tradeId } = parsed.data

    // Blocked users cannot message each other -- in either direction, and
    // regardless of whether a trade between them is in progress. See the note
    // above blockConsequences() in @/lib/blocking for why the trade stays alive
    // while the channel closes: the block shuts new contact, it does not rewind
    // an obligation, and a block that stayed porous "just for this trade" would
    // reopen exactly the channel the user blocked to close.
    const blocked = await enforceNotBlocked(session.user.id, receiverId, "message this person")
    if (blocked) return blocked

    const message = await prisma.$transaction(async (tx) => {
      // A new message reopens the conversation for both people, including the
      // recipient who hid it earlier. Message rows themselves are immutable
      // history and are never deleted by the hide action.
      await tx.conversationHide.deleteMany({
        where: {
          OR: [
            { viewerId: session.user.id, partnerId: receiverId },
            { viewerId: receiverId, partnerId: session.user.id },
          ],
        },
      })
      return tx.message.create({
        data: {
          senderId: session.user.id,
          receiverId,
          content,
          tradeId: tradeId || null,
        },
      })
    })

    await prisma.notification.deleteMany({
      where: { userId: receiverId, actorId: session.user.id, type: "NEW_MESSAGE", read: false },
    })
    await prisma.notification.create({
      data: {
        userId: receiverId,
        type: "NEW_MESSAGE",
        message: "sent you a message",
        link: `/dashboard/messages?partner=${session.user.id}`,
        actorId: session.user.id,
      },
    })

    // Push to receiver's private channel
    const payload = {
      id: message.id,
      content: message.content,
      senderId: message.senderId,
      receiverId: message.receiverId,
      createdAt: message.createdAt.toISOString(),
      senderName: session.user.name ?? "",
      senderAvatar: session.user.image ?? null,
    }
    pusher.trigger(`private-user-${receiverId}`, "new-message", payload).catch(() => {})

    return NextResponse.json(message, { status: 201 })
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
