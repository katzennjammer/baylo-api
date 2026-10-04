import { NextRequest, NextResponse } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { releaseTradeFee } from "@/lib/trade-fee-release"
import pusher from "@/lib/pusher"
import { parseBody, tradeActionSchema } from "@/lib/validation"
import { legacyParticipantRefusal, resolveTradeParticipant } from "@/lib/trade-participant"

// PATCH /api/trades/[id]
// body: { action: "cancel" | "hide" }
// cancel: sets status CANCELLED, frees items if IN_TRADE, notifies other party
// hide:   RETIRED in schema v2 -> 410. Per-party hiding (Trade.hiddenBySender /
//         hiddenByReceiver) was only reachable from the web dashboard, never
//         from the app, and no row on live ever had it set; the columns are
//         dropped by 20261004000002_schema_v2_drop_trade_hidden. Still parsed so
//         an old client gets a clear 410 rather than a 400.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await resolveSession()
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const { id: tradeId } = await params
    const parsed = await parseBody(req, tradeActionSchema)
    if (!parsed.ok) return parsed.response
    const { action } = parsed.data
    if (action === "hide") {
      return NextResponse.json({ error: "Hiding trades is no longer supported" }, { status: 410 })
    }

    const trade = await prisma.trade.findUnique({
      where: { id: tradeId },
      include: {
        sender:        { select: { id: true, name: true } },
        receiver:      { select: { id: true, name: true } },
        offeredItem:   { select: { id: true, title: true, status: true } },
        requestedItem: { select: { id: true, title: true, status: true } },
      },
    })

    // A deal still in its offer phase is not a trade yet (schema v2).
    if (!trade || trade.status === null || trade.offeredItemId === null) {
      return NextResponse.json({ error: "Trade not found" }, { status: 404 })
    }

    // Either side: the person, or the shop they are acting as. Cancelling a
    // shop's trade is the shop's. See @/lib/trade-participant.
    const who = await resolveTradeParticipant(session.user.id, req.headers, trade)
    if (!who.ok) return legacyParticipantRefusal(who)
    const isSender = who.isSender
    const myId = who.participantId

    // ── cancel ────────────────────────────────────────────────────────────────
    if (action === "cancel") {
      const cancellable = ["PENDING", "ACCEPTED", "CONFIRMING"] as const
      if (!(cancellable as readonly string[]).includes(trade.status)) {
        return NextResponse.json({ error: "Trade cannot be cancelled in its current state" }, { status: 400 })
      }

      const otherId   = isSender ? trade.receiverId : trade.senderId
      const otherName = isSender ? trade.receiver.name : trade.sender.name
      const itemIds   = [trade.offeredItemId, trade.requestedItemId]

      /*
       * The status, the items and the BRIDGING FEE, together.
       *
       * The fee is the reason this became a transaction. A cancelled trade
       * whose refund was lost leaves Leaves in escrow that no later path will
       * ever look for: completion is the only other thing that closes a hold,
       * and this trade will never complete. The conditional status write also
       * stops two taps producing two refunds -- though releaseBridgeFee()
       * refuses a second one anyway.
       */
      const refund = await prisma.$transaction(async (tx) => {
        const moved = await tx.trade.updateMany({
          where: { id: tradeId, status: { in: [...cancellable] } },
          data: { status: "CANCELLED" },
        })
        if (moved.count !== 1) return undefined

        // Free items back to AVAILABLE only if they were locked for this trade
        // (IN_TRADE), and only if neither has already been marked TRADED.
        await tx.item.updateMany({
          where: { id: { in: itemIds }, status: "IN_TRADE" },
          data: { status: "AVAILABLE" },
        })

        return releaseTradeFee(tx, trade, "cancelled")
      })

      if (refund === undefined) {
        return NextResponse.json({ error: "Trade cannot be cancelled in its current state" }, { status: 409 })
      }

      await prisma.notification.create({
        data: {
          userId:  otherId,
          type:    "TRADE_CANCELLED",
          message: `${isSender ? trade.sender.name : trade.receiver.name} cancelled the trade for "${trade.requestedItem.title}".`,
          link:    "/dashboard/trades",
          actorId: myId,
        },
      })

      await pusher.trigger(`private-user-${otherId}`, "trade-status-changed", {
        tradeId,
        newStatus: "CANCELLED",
        itemIds,
      })
      // Also notify the canceller's own channel so other tabs update
      await pusher.trigger(`private-user-${myId}`, "trade-status-changed", {
        tradeId,
        newStatus: "CANCELLED",
        itemIds,
      })

      void otherName
      return NextResponse.json({ ok: true, releasedLeaves: refund?.amount ?? 0 })
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
