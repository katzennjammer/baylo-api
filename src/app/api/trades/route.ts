import { NextRequest, NextResponse } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import pusher from "@/lib/pusher"
import { ITEM_PUBLIC_SELECT, preciseAccessItemIds, shapeItem } from "@/lib/item-visibility"
import { parseBody, createTradeSchema, tradeStatusSchema } from "@/lib/validation"
import { enforceInitiateTrade, enforceAcceptTrade } from "@/lib/reputation-gate"
import { assessOffer, refusalStatus } from "@/lib/offer-check"
import { releaseTradeFee, TRADE_FEE_SELECT } from "@/lib/trade-fee-release"
import { enforceNotBlocked } from "@/lib/blocking"

export async function GET() {
  try {
    const session = await resolveSession()
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    // `offeredItem: true` returned every Item column, which is how a merely
    // PENDING counterparty received the other party's exact pickup coordinates.
    // The pickup columns are resolved through the same rule as every other read
    // path, so a PENDING trade sees the coarse point and an ACCEPTED one does not.
    const trades = await prisma.tradeRequest.findMany({
      where: { OR: [{ senderId: session.user.id }, { receiverId: session.user.id }] },
      include: {
        offeredItem: { select: ITEM_PUBLIC_SELECT },
        requestedItem: { select: ITEM_PUBLIC_SELECT },
        sender: { select: { id: true, name: true, avatar: true } },
        receiver: { select: { id: true, name: true, avatar: true } },
      },
      orderBy: { createdAt: "desc" },
    })

    const viewerId = session.user.id
    const access = await preciseAccessItemIds(
      viewerId,
      trades.flatMap((t) => [t.offeredItemId, t.requestedItemId]),
    )

    return NextResponse.json(
      trades.map((t) => ({
        ...t,
        offeredItem: shapeItem(t.offeredItem, viewerId, access),
        requestedItem: shapeItem(t.requestedItem, viewerId, access),
      })),
    )
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await resolveSession()
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const parsed = await parseBody(req, createTradeSchema)
    if (!parsed.ok) return parsed.response
    const { offeredItemId, requestedItemId, message } = parsed.data

    const offeredItem = await prisma.item.findUnique({ where: { id: offeredItemId } })
    const requestedItem = await prisma.item.findUnique({ where: { id: requestedItemId } })

    if (!offeredItem || !requestedItem) {
      return NextResponse.json({ error: "Item not found" }, { status: 404 })
    }

    if (offeredItem.userId !== session.user.id) {
      return NextResponse.json({ error: "You can only offer your own items" }, { status: 403 })
    }

    if (requestedItem.userId === session.user.id) {
      return NextResponse.json({ error: "Cannot trade with yourself" }, { status: 400 })
    }

    if (requestedItem.status !== "AVAILABLE") {
      return NextResponse.json({ error: "Item is not available for trade" }, { status: 400 })
    }

    // A moderator takedown is not a status, so it needs its own check -- see
    // the note on Item.moderationHiddenAt for why it is not folded into
    // ItemStatus. Same 400 as an unavailable item: a would-be trader has no
    // business learning that a specific listing was removed by us.
    if (requestedItem.moderationHiddenAt) {
      return NextResponse.json({ error: "Item is not available for trade" }, { status: 400 })
    }

    // Neither party can initiate a trade with the other once a block exists in
    // either direction. This runs BEFORE the reputation gates, because "you
    // cannot contact this person" is a more fundamental refusal than "your tier
    // does not allow this item" and the caller should not be told the second
    // when the first applies.
    const blocked = await enforceNotBlocked(
      session.user.id,
      requestedItem.userId,
      "start a trade with this person",
    )
    if (blocked) return blocked

    // ── Reputation gates ──
    //
    // INITIATING. Two checks: an unfulfilled deferred agreement blocks starting
    // a trade at all, and the caller's tier caps the value of what they may
    // trade FOR -- requestedItem, the one they would receive, never
    // offeredItem, which is already theirs.
    //
    // Server-side and here rather than in the wizard. The listing page will
    // also hide the button, and that hiding is a courtesy: this check is what
    // makes the limit real, and it must keep holding for a caller who never
    // loaded the page.
    /*
     * ── THE BRACKET RULE APPLIES HERE TOO, AND A BRIDGE CANNOT BE SENT ──────
     *
     * This route is the WEB direct-trade path: it proposes a swap without an
     * Offer row. The same pair rule binds it -- same bracket, or one below --
     * because a rule that only bound /api/offers would be avoided by sending
     * the request that skips it.
     *
     * A BRIDGE IS REFUSED rather than charged. The fee needs consent, and
     * consent needs the sheet that states the amount, the balance before and
     * after, and the policy; this route has no such surface and inventing a
     * silent charge on a path the user reached from a different screen is
     * exactly what the consent record exists to prevent. Same-bracket trades
     * go through unchanged, which is every trade this route has ever created.
     */
    const pair = await assessOffer(prisma, {
      proposerId: session.user.id,
      offeredItemId,
      targetItemId: requestedItemId,
    })
    if (!pair.ok) {
      return NextResponse.json(
        { error: pair.message, code: pair.code, offeredBracket: pair.offeredBracket, targetBracket: pair.targetBracket },
        { status: refusalStatus(pair.code) },
      )
    }
    if (pair.fee > 0) {
      return NextResponse.json(
        {
          error: `Offering a Bracket ${pair.offeredBracket} item for a Bracket ${pair.targetBracket} item costs ${pair.fee} Leaves. Send it as an offer so you can agree to the bridging fee first.`,
          code: "BRIDGE_NEEDS_OFFER",
          fee: pair.fee,
        },
        { status: 400 },
      )
    }

    const gate = await enforceInitiateTrade(session.user.id, [requestedItemId])
    if (gate.response) return gate.response

    const existing = await prisma.tradeRequest.findFirst({
      where: {
        senderId: session.user.id,
        requestedItemId,
        status: "PENDING",
      },
    })

    if (existing) {
      return NextResponse.json({ error: "You already have a pending request for this item" }, { status: 409 })
    }

    const sender = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { name: true, avatar: true },
    })

    const { trade, chatMessage } = await prisma.$transaction(async (tx) => {
      const createdTrade = await tx.tradeRequest.create({
        data: {
          senderId: session.user.id,
          receiverId: requestedItem.userId,
          offeredItemId,
          requestedItemId,
          message: message || null,
        },
      })

      // A direct trade request is also the first message in the conversation.
      // Keep the trade and its readable proposal card atomic: the inbox must
      // never receive a trade whose conversation row was not saved.
      const createdMessage = await tx.message.create({
        data: {
          senderId: session.user.id,
          receiverId: requestedItem.userId,
          tradeId: createdTrade.id,
          content: JSON.stringify({
            type: "offer",
            tradeId: createdTrade.id,
            postItem: { title: requestedItem.title },
            offeredItems: [{ id: offeredItem.id, title: offeredItem.title }],
            offeredLeaves: null,
            userMessage: message?.trim() || null,
            senderName: sender?.name ?? "Someone",
            senderId: session.user.id,
            status: "PENDING",
          }),
        },
      })

      await tx.notification.create({
        data: {
          userId: requestedItem.userId,
          type: "TRADE_REQUEST",
          message: `wants to trade for your item "${requestedItem.title}"`,
          link: `/dashboard/trades`,
          actorId: session.user.id,
        },
      })

      return { trade: createdTrade, chatMessage: createdMessage }
    })

    const pusherPayload = {
      id: chatMessage.id,
      content: chatMessage.content,
      senderId: chatMessage.senderId,
      receiverId: chatMessage.receiverId,
      createdAt: chatMessage.createdAt.toISOString(),
      senderName: sender?.name ?? "",
      senderAvatar: sender?.avatar ?? null,
    }
    pusher.trigger(`private-user-${requestedItem.userId}`, "new-message", pusherPayload).catch(() => {})

    return NextResponse.json(trade, { status: 201 })
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const session = await resolveSession()
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const myId = session.user.id

    const parsed = await parseBody(req, tradeStatusSchema)
    if (!parsed.ok) return parsed.response
    const { tradeId, status } = parsed.data

    const trade = await prisma.tradeRequest.findUnique({
      where: { id: tradeId },
      include: {
        requestedItem: { select: { id: true, title: true, status: true } },
        offeredItem:   { select: { id: true, title: true, status: true } },
        sender:        { select: { id: true, name: true } },
        receiver:      { select: { id: true, name: true } },
      },
    })

    if (!trade) return NextResponse.json({ error: "Trade not found" }, { status: 404 })
    if (trade.receiverId !== myId) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

    if (status === "ACCEPTED") {
      // ── Reputation gate, ACCEPT path ──
      //
      // The premium bracket gate and the value ceiling apply -- the receiver is
      // acquiring offeredItem -- but the defaulted-trader block deliberately
      // does NOT. Accepting is how
      // a defaulter earns their way out; see enforceCanInitiateTrade().
      const gate = await enforceAcceptTrade(myId, [trade.offeredItemId])
      if (gate.response) return gate.response

      // Server-side guard: items must not be TRADED before we commit them
      if (trade.offeredItem.status === "TRADED" || trade.requestedItem.status === "TRADED") {
        return NextResponse.json({ error: "Item is no longer available" }, { status: 409 })
      }

      const itemIds = [trade.offeredItemId, trade.requestedItemId]

      // Everything in one transaction: accept this trade + auto-decline competing pending trades
      await prisma.$transaction(async (tx) => {
        // Double-check inside transaction
        const freshItems = await tx.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, status: true } })
        if (freshItems.some((i) => i.status === "TRADED")) throw new Error("item_traded")

        // Accept this trade and lock items
        await tx.tradeRequest.update({ where: { id: tradeId }, data: { status: "ACCEPTED" } })
        await tx.item.updateMany({ where: { id: { in: itemIds } }, data: { status: "IN_TRADE" } })

        // Find all other PENDING trades that involve either of these items
        const rivals = await tx.tradeRequest.findMany({
          where: {
            id: { not: tradeId },
            status: "PENDING",
            OR: [
              { offeredItemId:   { in: itemIds } },
              { requestedItemId: { in: itemIds } },
            ],
          },
          select: { ...TRADE_FEE_SELECT, requestedItem: { select: { title: true } } },
        })

        if (rivals.length > 0) {
          await tx.tradeRequest.updateMany({
            where: { id: { in: rivals.map((r) => r.id) } },
            data: { status: "REJECTED" },
          })

          // Each rival that carried a bridging fee returns it to whoever paid.
          // A trade auto-declined because the item went elsewhere is not one
          // anybody walked away from, and holding their Leaves for it would be
          // the least defensible refund this system could withhold.
          for (const rival of rivals) {
            await releaseTradeFee(tx, rival, "rejected")
          }

          // Notify each sender that their trade was auto-declined
          for (const rival of rivals) {
            await tx.notification.create({
              data: {
                userId:  rival.senderId,
                type:    "TRADE_REJECTED",
                message: `Your trade offer was auto-declined — the item is no longer available.`,
                link:    "/dashboard/trades",
                actorId: myId,
              },
            })
          }
        }
      })

      // Notify the original sender that their trade was accepted (outside TX — non-critical)
      await prisma.notification.create({
        data: {
          userId:  trade.senderId,
          type:    "TRADE_ACCEPTED",
          message: `accepted your trade request for "${trade.requestedItem.title}"`,
          link:    `/dashboard/trades`,
          actorId: myId,
        },
      })

      // Pusher: notify accepted sender + each rival's sender in real-time
      const rivals2 = await prisma.tradeRequest.findMany({
        where: {
          id: { not: tradeId },
          status: "REJECTED",
          OR: [
            { offeredItemId:   { in: [trade.offeredItemId, trade.requestedItemId] } },
            { requestedItemId: { in: [trade.offeredItemId, trade.requestedItemId] } },
          ],
          // only the ones we just declined (updatedAt was just now) — find all recent rejections
        },
        select: { id: true, senderId: true },
        orderBy: { updatedAt: "desc" },
        take: 50,
      })

      const pusherPromises: Promise<unknown>[] = [
        pusher.trigger(`private-user-${trade.senderId}`, "trade-status-changed", {
          tradeId,
          newStatus: "ACCEPTED",
          itemIds: [trade.offeredItemId, trade.requestedItemId],
        }),
      ]
      for (const rival of rivals2) {
        pusherPromises.push(
          pusher.trigger(`private-user-${rival.senderId}`, "trade-status-changed", {
            tradeId:   rival.id,
            newStatus: "REJECTED",
            reason:    "item_unavailable",
            itemIds:   [trade.offeredItemId, trade.requestedItemId],
          })
        )
      }
      await Promise.allSettled(pusherPromises)

      return NextResponse.json({ status: "ACCEPTED" })
    }

    if (status === "REJECTED") {
      // The status and the refund together; see releaseTradeFee().
      const rejected = await prisma.tradeRequest.findUnique({
        where: { id: tradeId },
        select: TRADE_FEE_SELECT,
      })
      await prisma.$transaction(async (tx) => {
        await tx.tradeRequest.update({ where: { id: tradeId }, data: { status: "REJECTED" } })
        if (rejected) await releaseTradeFee(tx, rejected, "rejected")
      })
      await prisma.notification.create({
        data: {
          userId:  trade.senderId,
          type:    "TRADE_REJECTED",
          message: `declined your trade request for "${trade.requestedItem.title}"`,
          link:    `/dashboard/trades`,
          actorId: myId,
        },
      })
      await pusher.trigger(`private-user-${trade.senderId}`, "trade-status-changed", {
        tradeId,
        newStatus: "REJECTED",
        itemIds:   [trade.offeredItemId, trade.requestedItemId],
      })
      return NextResponse.json({ status: "REJECTED" })
    }

    return NextResponse.json({ error: "Invalid status" }, { status: 400 })
  } catch (err) {
    if (err instanceof Error && err.message === "item_traded") {
      return NextResponse.json({ error: "Item is no longer available" }, { status: 409 })
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
