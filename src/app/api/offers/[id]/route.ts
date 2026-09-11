import { NextRequest, NextResponse } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import pusher from "@/lib/pusher"
import { availableLeaves } from "@/lib/leaves"
import { expireStaleOffers } from "@/lib/offers"
import { offerActionSchema, parseBody } from "@/lib/validation"
import { enforceAcceptTrade, loadStanding } from "@/lib/reputation-gate"
import { DPA } from "@/lib/reputation-config"
import {
  COMMITTING_STATUSES,
  netValueTo,
  offerAsTradeSides,
  parseOfferedItemIds,
} from "@/lib/contracts"

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await resolveSession()
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const { id: offerId } = await params

    // Sweep before reading the row, so an offer that aged out is seen as EXPIRED
    // rather than accepted three days late. Scoped to nothing — the id is not a
    // sender or a post, and one row's worth of sweep is what this costs.
    await expireStaleOffers(prisma)

    const parsed = await parseBody(req, offerActionSchema)
    if (!parsed.ok) return parsed.response
    const { action } = parsed.data

    const offer = await prisma.offer.findUnique({
      where: { id: offerId },
      include: {
        post: { select: { id: true, title: true, valueLeaves: true } },
        sender: { select: { id: true, name: true } },
        receiver: { select: { id: true, name: true } },
        // A promise proposed alongside this offer, if there is one. At most one
        // is ever in a COMMITTING status — the one-at-a-time rule — so this is
        // a findFirst in list clothing.
        contracts: {
          where: { status: { in: [...COMMITTING_STATUSES] } },
          select: { id: true, amountLeaves: true, deadline: true, debtorId: true, status: true },
          take: 1,
        },
      },
    })
    if (!offer) return NextResponse.json({ error: "Offer not found" }, { status: 404 })
    if (offer.receiverId !== session.user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }
    if (offer.status !== "PENDING") {
      return NextResponse.json({ error: "Offer already resolved" }, { status: 400 })
    }
    // Guard: a user must not trade with themselves
    if (offer.senderId === offer.receiverId) {
      return NextResponse.json({ error: "Cannot trade with yourself" }, { status: 400 })
    }

    // ── Reputation gate, ACCEPT path ──
    //
    // The accepter is acquiring the offered items, so the premium bracket gate
    // and the tier value ceiling apply to those. The defaulted-trader block does
    // not: accepting is the one move a defaulter must keep, because Leaves
    // arriving this way are what pays their debt down.
    //
    // offeredItems is a JSON blob written by the client. Only well-formed
    // string ids are passed on; enforceAcceptTrade() looks them up in Item and
    // an id that matches nothing simply caps nothing, which is the same
    // treatment an unvalued item gets.
    if (action === "accept") {
      let offeredIds: string[] = []
      try {
        const raw: unknown = JSON.parse(offer.offeredItems)
        if (Array.isArray(raw)) {
          offeredIds = raw
            .filter((x): x is { id?: unknown } => !!x && typeof x === "object")
            .map((x) => x.id)
            .filter((id): id is string => typeof id === "string" && id.length > 0)
        }
      } catch {
        offeredIds = []
      }
      if (offeredIds.length > 0) {
        const gate = await enforceAcceptTrade(session.user.id, offeredIds)
        if (gate.response) return gate.response
      }
    }

    // Re-check with the SAME rule used when the offer was created: total minus
    // leaves already committed to the sender's other still-pending offers. This
    // offer is excluded from that sum so it is not counted against itself.
    if (action === "accept" && offer.offeredLeaves && offer.offeredLeaves > 0) {
      // The SENDER's other offers, not the accepter's: it is the sender's balance
      // this is measured against, and one of their other offers may have lapsed.
      await expireStaleOffers(prisma, { senderId: offer.senderId })
      const available = await availableLeaves(prisma, offer.senderId, { excludeOfferId: offerId })
      if (offer.offeredLeaves > available) {
        return NextResponse.json(
          { error: `Cannot accept — the sender now has only ${available} Leaves available but this offer requires ${offer.offeredLeaves}` },
          { status: 400 },
        )
      }
    }

    /*
     * ── THE PROMISE, IF THERE IS ONE ──────────────────────────────────────────
     *
     * A DPA proposed alongside this offer is accepted BY accepting the offer.
     * The creditor read the debtor's record on the preview screen and is now
     * saying yes to the whole arrangement; splitting consent into two taps would
     * leave a window in which the trade exists and the promise does not, and the
     * settlement gate would block the trade until the second tap arrived.
     *
     * So every check /api/v1/contracts/[id]/accept would have run, runs here,
     * BEFORE anything is written. The debtor's standing can have moved since
     * they proposed — a default swept in, another contract accepted, an item
     * revalued — and the creditor must not be able to accept an arrangement the
     * server would then refuse to honour.
     */
    const pendingContract = offer.contracts[0] ?? null

    if (action === "accept" && pendingContract) {
      const debtor = await loadStanding(pendingContract.debtorId)

      if (debtor.completedTrades < DPA.minCompletedTradesToOwe) {
        return NextResponse.json(
          {
            error: `This offer includes a promise, and ${offer.sender?.name ?? "the sender"} now has ${debtor.completedTrades} completed trades — a debtor needs ${DPA.minCompletedTradesToOwe}. Accepting without the promise is not possible; ask them to send a new offer.`,
            code: "DPA_MIN_COMPLETED_TRADES",
          },
          { status: 409 },
        )
      }
      if (!debtor.limits.mayProposeDpa) {
        return NextResponse.json(
          {
            error: `This offer includes a promise, and ${offer.sender?.name ?? "the sender"} is now a ${debtor.tier} and can no longer hold one.`,
            code: "TIER_MAY_NOT_PROPOSE",
          },
          { status: 409 },
        )
      }

      // Other open contracts, this one excluded — it is PENDING_ACCEPT and so is
      // already counted in openContracts/committedDebt by loadStanding().
      const otherOpen = await prisma.deferredContract.count({
        where: {
          debtorId: pendingContract.debtorId,
          status: { in: [...COMMITTING_STATUSES] },
          id: { not: pendingContract.id },
        },
      })
      if (otherOpen >= DPA.maxConcurrentAsDebtor) {
        return NextResponse.json(
          {
            error: "The sender has taken on another deferred agreement since making this offer.",
            code: "DPA_ONE_AT_A_TIME",
          },
          { status: 409 },
        )
      }

      const ceiling = debtor.limits.maxOutstandingDebtLeaves
      const otherCommitted = Math.max(0, debtor.committedDebt - pendingContract.amountLeaves)
      if (otherCommitted + pendingContract.amountLeaves > ceiling) {
        return NextResponse.json(
          {
            error: `Accepting would put the sender at ${otherCommitted + pendingContract.amountLeaves} Leaves owed, over the ${ceiling} their tier allows.`,
            code: "TIER_DEBT_CEILING",
          },
          { status: 409 },
        )
      }

      // The value difference, re-derived: an item's valueLeaves may have been
      // edited between the offer being sent and this moment.
      const itemIds = parseOfferedItemIds(offer.offeredItems)
      const offeredRows = itemIds.length
        ? await prisma.item.findMany({
            where: { id: { in: itemIds } },
            select: { id: true, valueLeaves: true },
          })
        : []
      const net = netValueTo(
        offerAsTradeSides({
          senderId: offer.senderId,
          receiverId: offer.receiverId,
          offeredLeaves: offer.offeredLeaves,
          post: offer.post,
          offeredItems: offeredRows,
        }),
        pendingContract.debtorId,
      )
      if (net === null || pendingContract.amountLeaves > net) {
        return NextResponse.json(
          {
            error: `The value difference is now ${net ?? "undefined"} Leaves, which no longer covers the ${pendingContract.amountLeaves} promised. Ask for a new offer.`,
            code: "DPA_AMOUNT_EXCEEDS_DIFFERENCE",
          },
          { status: 409 },
        )
      }
    }

    const newStatus = action === "accept" ? "ACCEPTED" : "DECLINED"
    await prisma.offer.update({ where: { id: offerId }, data: { status: newStatus } })

    /*
     * A DECLINED offer takes its promise with it.
     *
     * DECLINED, not DEFAULTED: nobody broke anything. The debtor proposed, the
     * creditor said no, and the row stays as the durable fact that somebody
     * looked at these numbers and refused — which is the same reasoning
     * /contracts/[id]/decline gives for not deleting it. Critically it also
     * FREES THE DEBTOR'S ONE CONTRACT SLOT immediately; leaving it PENDING_ACCEPT
     * would lock them out of proposing to anyone else for good.
     */
    if (action === "decline" && pendingContract) {
      await prisma.deferredContract.updateMany({
        where: { id: pendingContract.id, status: "PENDING_ACCEPT" },
        data: { status: "DECLINED" },
      })
    }

    // Create an active TradeRequest so both users see it in "Active Trades"
    let tradeRecord: { id: string; offeredItemTitle: string; requestedItemTitle: string } | null = null
    if (action === "accept") {
      try {
        const items: { id: string; title?: string }[] = JSON.parse(offer.offeredItems)
        const isItemSwap   = items.length > 0
        const offeredItemId = isItemSwap ? items[0].id : offer.postId

        const [offeredItem, requestedItem] = await Promise.all([
          prisma.item.findUnique({ where: { id: offeredItemId   }, select: { title: true } }),
          prisma.item.findUnique({ where: { id: offer.postId    }, select: { title: true } }),
        ])

        const trade = await prisma.tradeRequest.create({
          data: {
            senderId:       offer.senderId,
            receiverId:     offer.receiverId,
            offeredItemId,
            requestedItemId: offer.postId,
            status:         "ACCEPTED",
            message:        offer.message,
            // Record the Leaves ON the trade, from the exact offer being
            // accepted right here. Settlement reads this column and never
            // re-derives the amount, because the reverse lookup
            // (senderId + postId + ACCEPTED) is not unique — one sender/post
            // pair already holds two accepted offers for different amounts.
            // At this point there is no ambiguity to inherit: this is the
            // offer, so this is the amount.
            offeredLeaves:  offer.offeredLeaves ?? null,
          },
        })
        /*
         * ── THE PROMISE MOVES TO THE TRADE, AND BECOMES ACTIVE ──────────────
         *
         * `tradeId` is filled in and `offerId` is KEPT. Every downstream piece
         * of machinery is trade-keyed — the settlement gate reads
         * `{ tradeId, status: "PENDING_ACCEPT" }`, the deadline sweep and
         * auto-payment both work off the contract row, and the creditor's
         * preview prefers the trade once there is one — so re-pointing is what
         * makes an offer-borne contract indistinguishable from a trade-borne one
         * from here on. The offer stays as provenance.
         *
         * ACTIVE in the SAME statement, conditional on PENDING_ACCEPT. Two taps
         * on Accept produce one ACTIVE contract and one no-op rather than two
         * acceptances, which is the same guard /contracts/[id]/accept uses.
         *
         * NOT INSIDE A TRANSACTION WITH THE TRADE CREATE, and that is worth
         * being honest about rather than quiet: this whole handler is a sequence
         * of separate writes already (the offer update, the trade create, the
         * notification, the message), and wrapping only these two would suggest
         * a guarantee the rest of the path does not have. The failure mode if
         * this write is lost is a trade whose promise is still PENDING_ACCEPT —
         * which the settlement gate then blocks, loudly, rather than letting the
         * swap complete with an unrecorded debt. That is the safe direction.
         */
        if (pendingContract) {
          await prisma.deferredContract.updateMany({
            where: { id: pendingContract.id, status: "PENDING_ACCEPT" },
            data: { tradeId: trade.id, status: "ACTIVE", acceptedAt: new Date() },
          })
        }

        tradeRecord = {
          id: trade.id,
          offeredItemTitle:   isItemSwap
            ? (offeredItem?.title ?? "Item")
            : `${offer.offeredLeaves ?? 0} Leaves`,
          requestedItemTitle: requestedItem?.title ?? offer.post.title,
        }
      } catch (e) {
        console.error("[offers/accept] failed to create TradeRequest:", e)
      }
    }

    // Notify sender — link uses ?partner= format so NotifPanel opens the chat dock
    await prisma.notification.create({
      data: {
        userId: offer.senderId,
        type: action === "accept" ? "TRADE_ACCEPTED" : "TRADE_REJECTED",
        message: action === "accept"
          ? `accepted your offer on "${offer.post.title}"`
          : `declined your offer on "${offer.post.title}"`,
        link: `/dashboard/messages?partner=${session.user.id}`,
        actorId: session.user.id,
        /*
         * The structured target, which this route was not writing.
         *
         * An ACCEPT has a real trade to point at — `tradeRecord` was created a
         * few lines up — so this writes the FINE-GRAINED ('trade', <tradeId>)
         * pair rather than the coarse pre-v1 ('trade', null) that every existing
         * row in this table carries. That is the vocabulary the schema note
         * describes as "v1 and later", and this is the first route to produce it
         * for a trade.
         *
         * `tradeRecord` is null only if the TradeRequest create threw — the
         * catch above logs and continues rather than failing the accept. There
         * is then no trade to open, and the conversation is the truthful target.
         *
         * A DECLINE never has one: nothing was created, and the thread is where
         * the conversation about it continues.
         */
        ...(tradeRecord
          ? { entityType: "trade", entityId: tradeRecord.id }
          : { entityType: "conversation", entityId: session.user.id }),
      },
    })

    // Send status update as a follow-up message in their chat
    const actorName = offer.receiver?.name ?? "They"
    const systemMsg = await prisma.message.create({
      data: {
        senderId: session.user.id,
        receiverId: offer.senderId,
        content: JSON.stringify({
          type: "offer_update",
          offerId,
          status: newStatus,
          actorName,
        }),
      },
    })

    // Tell the sender their offer was resolved (updates OfferCard + appends system msg)
    pusher.trigger(`private-user-${offer.senderId}`, "offer-updated", {
      offerId,
      status: newStatus,
      actorName,
      systemMessage: {
        id: systemMsg.id,
        content: systemMsg.content,
        senderId: systemMsg.senderId,
        receiverId: systemMsg.receiverId,
        createdAt: systemMsg.createdAt.toISOString(),
      },
      ...(tradeRecord && {
        tradeId: tradeRecord.id,
        offeredItemTitle: tradeRecord.offeredItemTitle,
        requestedItemTitle: tradeRecord.requestedItemTitle,
        senderName: offer.sender?.name ?? "",
        receiverName: actorName,
        receiverId: offer.receiverId,
      }),
    }).catch(() => {})

    return NextResponse.json({
      status: newStatus,
      ...(tradeRecord && {
        tradeId: tradeRecord.id,
        offeredItemTitle: tradeRecord.offeredItemTitle,
        requestedItemTitle: tradeRecord.requestedItemTitle,
        senderId: offer.senderId,
        senderName: offer.sender?.name ?? "",
        receiverId: offer.receiverId,
        receiverName: actorName,
      }),
    })
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
