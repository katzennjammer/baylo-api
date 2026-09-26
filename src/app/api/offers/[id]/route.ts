import { NextRequest, NextResponse } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import pusher from "@/lib/pusher"
import { expireStaleOffers, parseOfferedItemIds } from "@/lib/offers"
import { offerActionSchema, parseBody } from "@/lib/validation"
import { enforceAcceptTrade } from "@/lib/reputation-gate"
import { assessOffer, refusalStatus } from "@/lib/offer-check"
import { holdBridgeFee, releaseBridgeFee } from "@/lib/bridge-fee"
import { TRADING_POLICY_VERSION } from "@/lib/trade-rules"
import { createSystemMessage } from "@/lib/system-message"
import {
  isShopMemberPair, legacyParticipantRefusal, resolveTradeParticipant, shopMemberSelfTradeRefusal,
} from "@/lib/trade-participant"

/**
 * PATCH /api/offers/[id] — the RECEIVER accepts or declines.
 *
 * ── THE RULES ARE RE-CHECKED HERE, NOT TRUSTED FROM THE OFFER ───────────────
 *
 * An offer records the two brackets it was judged on and the fee it paid. This
 * route does not take those on trust: it re-derives both brackets from the
 * items as they are NOW and refuses if they have moved. An owner can relist,
 * an admin can approve a value review, a revaluation can land — and accepting
 * under rules neither party agreed to is worse than asking for a fresh offer.
 * (The edit path refuses to move a value while an offer is pending, which
 * makes this a narrow case rather than an ordinary one. It is checked anyway:
 * "narrow" is not "impossible", and this is where currency moves.)
 *
 * The premium gate and the tier cap run against what the ACCEPTER receives.
 *
 * ── THE RECEIVER MAY BE THE ONE WHO PAYS ────────────────────────────────────
 *
 * The side handing over the LOWER-bracket item pays. When the proposer offered
 * something smaller, they paid at propose and this route only moves the hold
 * onto the trade. When the proposer offered something BIGGER — equally legal —
 * the receiver is the one moving up, and accepting is the moment they commit.
 * So an up-bridge accept:
 *
 *   demands consent IN THIS REQUEST (`consent.accepted` plus the current
 *   policy version), because this tap is where they agree to be charged;
 *   holds the fee off their balance in the accept transaction, refusing with
 *   need-vs-have if they cannot cover it;
 *   records `consentAt` / `policyVersion` on the offer — the columns belong to
 *   whoever paid, and on this path that is them.
 *
 * ── WHAT THE FEE DOES AT EACH OUTCOME ───────────────────────────────────────
 *
 *   accept    held (by whichever side owes it) and recorded on the
 *             TradeRequest as `bridgeFeeLeaves` + `bridgeFeePaidBySender`.
 *             Nothing is PAID yet: it reaches the counterparty at completion,
 *             and a trade that never completes returns it.
 *   decline   a proposer-paid hold is released; an up-bridge never held
 *             anything, so there is nothing to return.
 *
 * ── WHAT LEFT ON 16 SEP 2026 ────────────────────────────────────────────────
 *
 * Roughly a third of this handler: every deferred-agreement check (the
 * debtor's tier, their open-contract count, their debt ceiling, the value
 * difference the promise had to fit inside), the contract status transitions,
 * and the sender-balance re-check for `offeredLeaves`. Offers do not carry
 * Leaves any more and there are no promises to accept alongside them.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await resolveSession()
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const { id: offerId } = await params

    // Sweep before reading the row, so an offer that aged out is seen as
    // EXPIRED rather than accepted three days late — and its fee is already
    // back with the proposer by the time this reads the status.
    await expireStaleOffers(prisma)

    const parsed = await parseBody(req, offerActionSchema)
    if (!parsed.ok) return parsed.response
    const { action, consent } = parsed.data

    const offer = await prisma.offer.findUnique({
      where: { id: offerId },
      include: {
        post: { select: { id: true, title: true, images: true, valueLeaves: true } },
        sender: { select: { id: true, name: true } },
        receiver: { select: { id: true, name: true } },
      },
    })
    if (!offer) return NextResponse.json({ error: "Offer not found" }, { status: 404 })
    // The receiver decides: the person, or -- acting as a shop (X-Baylo-Org,
    // ACTIVE membership) -- the shop, for an offer on the shop's listing. From
    // here on `myId` is that side: the standing the gates read, the actor on
    // the notification, the author of the system message. Any active member
    // may decide, and on an up-bridge their consent is given on the SHOP's
    // behalf and the fee is held off the shop's balance (offer.receiverId).
    // See @/lib/trade-participant.
    const who = await resolveTradeParticipant(session.user.id, req.headers, offer, "receiver")
    if (!who.ok) return legacyParticipantRefusal(who)
    const myId = who.participantId
    if (offer.status !== "PENDING") {
      return NextResponse.json({ error: "Offer already resolved" }, { status: 400 })
    }
    if (offer.senderId === offer.receiverId) {
      return NextResponse.json({ error: "Cannot trade with yourself" }, { status: 400 })
    }

    // The item the sender put up. A legacy row may name several; the first is
    // the one every shipped client ever sent and the one the card drew.
    const offeredItemId = parseOfferedItemIds(offer.offeredItems)[0] ?? null
    const fee = offer.bridgeFeeLeaves ?? 0
    /**
     * Who owes it, from the brackets stored on the offer. Re-derived from the
     * live items below and cross-checked, so a stale row cannot decide whose
     * Leaves move; this is the reading used before that check has run.
     */
    const proposerPays =
      offer.offeredBracket !== null &&
      offer.targetBracket !== null &&
      offer.offeredBracket < offer.targetBracket

    if (action === "accept") {
      // A shop accepting an offer from one of its own members: one person on
      // both sides. Refused here as well as at propose, because the offer may
      // predate the membership. A DECLINE is allowed -- it is how the offer
      // gets closed and a held fee returned. See @/lib/trade-participant.
      if (await isShopMemberPair(prisma, offer.senderId, offer.receiverId)) return shopMemberSelfTradeRefusal()

      if (!offeredItemId) {
        return NextResponse.json(
          {
            error:
              "This offer predates one-item trading and has no item on it. Ask for a new offer.",
            code: "OFFER_LEGACY_SHAPE",
          },
          { status: 409 },
        )
      }

      // ── The pair, re-derived ──
      const assessed = await assessOffer(prisma, {
        proposerId: offer.senderId,
        offeredItemId,
        targetItemId: offer.postId,
      })
      if (!assessed.ok) {
        return NextResponse.json(
          { error: assessed.message, code: assessed.code, offeredBracket: assessed.offeredBracket, targetBracket: assessed.targetBracket },
          { status: refusalStatus(assessed.code) },
        )
      }
      // Brackets that moved since the offer was made. Refused with both
      // figures, rather than silently honoured or silently re-priced -- the
      // proposer consented to a specific fee for a specific pair.
      if (
        (offer.offeredBracket !== null && offer.offeredBracket !== assessed.offeredBracket) ||
        (offer.targetBracket !== null && offer.targetBracket !== assessed.targetBracket) ||
        assessed.fee !== fee
      ) {
        return NextResponse.json(
          {
            error: `The values behind this offer have changed since it was sent — it was Bracket ${offer.offeredBracket} for Bracket ${offer.targetBracket}, and it is now Bracket ${assessed.offeredBracket} for Bracket ${assessed.targetBracket}. Ask ${offer.sender?.name ?? "the sender"} for a new offer.`,
            code: "OFFER_BRACKETS_MOVED",
            was: { offeredBracket: offer.offeredBracket, targetBracket: offer.targetBracket, fee },
            now: { offeredBracket: assessed.offeredBracket, targetBracket: assessed.targetBracket, fee: assessed.fee },
          },
          { status: 409 },
        )
      }

      // ── Reputation gates, ACCEPT path ──
      //
      // The accepter is acquiring the offered item, so the premium bracket gate
      // and the tier value ceiling apply to it.
      const gate = await enforceAcceptTrade(myId, [offeredItemId])
      if (gate.response) return gate.response

      /*
       * AND THE PROPOSER'S SIDE, RE-CHECKED HERE TOO.
       *
       * They are acquiring the listing, and the premium gate is about whoever
       * RECEIVES a bracket-7-or-above item. It was checked when they proposed;
       * a subscription can lapse in the three days an offer may sit. Refusing
       * at accept rather than letting the trade complete is the same reasoning
       * that re-derives the brackets twenty lines up: this is the last moment
       * before the items are committed.
       *
       * 409 rather than the gate's own 403, because it is not the ACCEPTER who
       * is refused — telling them they need premium would be false.
       */
      const senderGate = await enforceAcceptTrade(offer.senderId, [offer.postId])
      if (senderGate.response) {
        return NextResponse.json(
          {
            error: `${offer.sender?.name ?? "The sender"} can no longer take on "${offer.post.title}" — their premium subscription has lapsed. The offer stays where it is.`,
            code: "SENDER_GATE_FAILED",
          },
          { status: 409 },
        )
      }

      // ── The receiver's own consent, when the receiver is the payer ──
      if (fee > 0 && !proposerPays) {
        if (!consent?.accepted) {
          return NextResponse.json(
            {
              error: `Accepting a Bracket ${offer.offeredBracket} item for your Bracket ${offer.targetBracket} one costs ${fee} Leaves. You have to agree to the bridging fee and the trading policy before this can be accepted.`,
              code: "CONSENT_REQUIRED",
              fee,
              policyVersion: TRADING_POLICY_VERSION,
            },
            { status: 400 },
          )
        }
        if (consent.policyVersion !== TRADING_POLICY_VERSION) {
          return NextResponse.json(
            {
              error: "The trading policy has been updated. Reopen the offer to read the current one.",
              code: "POLICY_VERSION_STALE",
              policyVersion: TRADING_POLICY_VERSION,
            },
            { status: 409 },
          )
        }
      }
    }

    const newStatus = action === "accept" ? "ACCEPTED" : "DECLINED"

    /*
     * The status, the trade and the fee move together.
     *
     * This handler used to be a sequence of unwrapped writes, which was
     * survivable while the worst outcome was a missing notification. It is not
     * survivable now: an ACCEPTED offer whose fee never reached a TradeRequest
     * is a fee in escrow that no completion can pay and no cancellation can
     * release, and a DECLINED offer whose release was lost is Leaves that
     * belong to nobody. So the writes that decide where the fee sits are in one
     * transaction, and the chat/notification side-effects stay outside it.
     */
    let tradeRecord: { id: string; offeredItemTitle: string; requestedItemTitle: string } | null = null
    const now = new Date()

    let outcome: { raced: true } | { raced: false; trade: { id: string; offeredItemTitle: string; requestedItemTitle: string } | null }
    try {
      outcome = await prisma.$transaction(async (tx) => {
      // Conditional on PENDING, so two taps produce one resolution.
      const moved = await tx.offer.updateMany({
        where: { id: offerId, status: "PENDING" },
        data: { status: newStatus },
      })
      if (moved.count !== 1) return { raced: true as const }

      if (action === "decline") {
        // Only a proposer-paid hold exists to release. An up-bridge that is
        // declined never held anything: the receiver is the payer and they
        // have just said no.
        if (fee > 0 && proposerPays) {
          await releaseBridgeFee(tx, {
            userId: offer.senderId,
            offerId,
            amount: fee,
            reason: "declined",
          })
        }
        return { raced: false as const, trade: null }
      }

      // The receiver's fee comes out of their balance HERE, inside the same
      // transaction as the acceptance, with the same conditional-debit guard
      // the propose path uses.
      if (fee > 0 && !proposerPays) {
        const held = await holdBridgeFee(tx, {
          userId: offer.receiverId,
          offerId,
          amount: fee,
          at: now,
        })
        /*
         * THROWN, NOT RETURNED. The conditional status write above has already
         * moved the offer to ACCEPTED in this transaction; returning here would
         * COMMIT that -- leaving an offer marked accepted, no trade created and
         * no fee taken, which is the worst state this route can produce and is
         * unreachable by any other path. Throwing rolls the status back with
         * the failed hold, and the caller answers 400 with need-vs-have.
         * (Caught by verify-bracket-trading section 6, which is why the offer
         * still reads PENDING after a refused accept.)
         */
        if (!held.ok) throw new ReceiverShort(fee, held.have)
        await tx.offer.update({
          where: { id: offerId },
          data: { consentAt: now, policyVersion: TRADING_POLICY_VERSION },
        })
      }

      const [offeredItem, requestedItem] = await Promise.all([
        tx.item.findUnique({ where: { id: offeredItemId as string }, select: { title: true, status: true } }),
        tx.item.findUnique({ where: { id: offer.postId }, select: { title: true, status: true } }),
      ])

      if (offeredItem?.status !== "AVAILABLE" || requestedItem?.status !== "AVAILABLE") {
        throw new Error("item_unavailable")
      }

      const locked = await tx.item.updateMany({
        where: {
          id: { in: [offeredItemId as string, offer.postId] },
          status: "AVAILABLE",
        },
        data: { status: "IN_TRADE" },
      })
      if (locked.count !== 2) throw new Error("item_unavailable")

      const trade = await tx.tradeRequest.create({
        data: {
          senderId: offer.senderId,
          receiverId: offer.receiverId,
          offeredItemId: offeredItemId as string,
          requestedItemId: offer.postId,
          status: "ACCEPTED",
          message: offer.message,
          // Legacy column, never written from here any more: an offer created
          // after 16 Sep 2026 carries no Leaves. Old ACCEPTED trades keep
          // theirs and settle on it.
          offeredLeaves: null,
          // The fee follows the trade, for the same reason `offeredLeaves`
          // used to: settlement and cancellation read the trade and must never
          // re-find the offer. The Leaves are already out of the payer's
          // balance by now; these two columns record how much and whose.
          bridgeFeeLeaves: fee > 0 ? fee : null,
          bridgeFeePaidBySender: fee > 0 ? proposerPays : null,
        },
        select: { id: true },
      })

      const rivals = await tx.offer.findMany({
        where: {
          id: { not: offerId },
          status: "PENDING",
          OR: [
            { postId: { in: [offeredItemId as string, offer.postId] } },
            { offeredItems: { contains: offeredItemId as string } },
          ],
        },
        select: {
          id: true,
          senderId: true,
          offeredBracket: true,
          targetBracket: true,
          bridgeFeeLeaves: true,
        },
      })

      if (rivals.length > 0) {
        await tx.offer.updateMany({
          where: { id: { in: rivals.map((rival) => rival.id) }, status: "PENDING" },
          data: { status: "DECLINED" },
        })
        for (const rival of rivals) {
          const proposerPaid = rival.offeredBracket !== null && rival.targetBracket !== null && rival.offeredBracket < rival.targetBracket
          if (proposerPaid && rival.bridgeFeeLeaves) {
            await releaseBridgeFee(tx, {
              userId: rival.senderId,
              offerId: rival.id,
              amount: rival.bridgeFeeLeaves,
              reason: "rejected",
            })
          }
        }
      }

      return {
        raced: false as const,
        trade: {
          id: trade.id,
          offeredItemTitle: offeredItem?.title ?? "Item",
          requestedItemTitle: requestedItem?.title ?? offer.post.title,
        },
      }
      })
    } catch (e) {
      if (e instanceof Error && e.message === "item_unavailable") {
        return NextResponse.json({ error: "An item in this offer is no longer available" }, { status: 409 })
      }
      if (e instanceof ReceiverShort) {
        return NextResponse.json(
          {
            error: `Accepting this costs ${e.need} Leaves and you have ${e.have}. You need ${e.need - e.have} more.`,
            code: "INSUFFICIENT_LEAVES",
            need: e.need,
            have: e.have,
            short: e.need - e.have,
          },
          { status: 400 },
        )
      }
      throw e
    }

    if (outcome.raced) {
      return NextResponse.json({ error: "This offer was just resolved" }, { status: 409 })
    }
    tradeRecord = outcome.trade

    const offeredItemForCard = tradeRecord
      ? await prisma.item.findUnique({
          where: { id: offeredItemId as string },
          select: { title: true, images: true },
        })
      : null
    const firstImage = (raw: string | null | undefined) => {
      if (!raw) return null
      try {
        const images = JSON.parse(raw)
        return Array.isArray(images) && typeof images[0] === "string" ? images[0] : null
      } catch {
        return null
      }
    }

    // Notify sender — link uses ?partner= format so NotifPanel opens the chat dock
    await prisma.notification.create({
      data: {
        userId: offer.senderId,
        type: action === "accept" ? "TRADE_ACCEPTED" : "TRADE_REJECTED",
        read: false,
        message:
          action === "accept"
            ? `accepted your offer on "${offer.post.title}"`
            : `declined your offer on "${offer.post.title}"` +
              (fee > 0 && proposerPays
                ? ` — your ${fee}-Leaf bridging fee is back in your balance`
                : ""),
        link: `/dashboard/messages?partner=${myId}`,
        actorId: myId,
        // An ACCEPT has a real trade to point at, so it writes the fine-grained
        // ('trade', <tradeId>) pair. A DECLINE never has one: nothing was
        // created, and the thread is where the conversation continues.
        ...(tradeRecord
          ? { entityType: "trade", entityId: tradeRecord.id }
          : { entityType: "conversation", entityId: myId }),
      },
    })
    pusher
      .trigger(`private-user-${offer.senderId}`, "notification-created", {
        type: action === "accept" ? "TRADE_ACCEPTED" : "TRADE_REJECTED",
      })
      .catch(() => {})

    const actorName = offer.receiver?.name ?? "They"
    const updatePayload = {
      type: "offer_update",
      offerId,
      tradeId: tradeRecord?.id ?? null,
      status: newStatus,
      actorName,
      accepterId: offer.receiverId,
      proposerName: offer.sender?.name ?? "They",
      accepterName: actorName,
      offeredItemTitle: offeredItemForCard?.title ?? tradeRecord?.offeredItemTitle ?? "Item",
      requestedItemTitle: offer.post.title,
      offeredItemImage: firstImage(offeredItemForCard?.images),
      requestedItemImage: firstImage(offer.post.images),
    }
    const senderSystemContent = JSON.stringify(updatePayload)
    const receiverSystemContent = JSON.stringify(updatePayload)
    const systemMsg = await createSystemMessage({
      eventKey: `offer-update:${offerId}:${newStatus}:${offer.senderId}`,
      senderId: myId,
      receiverId: offer.senderId,
      tradeId: tradeRecord?.id,
      content: senderSystemContent,
    })
    const counterpartMsg = await createSystemMessage({
      eventKey: `offer-update:${offerId}:${newStatus}:${offer.receiverId}`,
      senderId: offer.senderId,
      receiverId: offer.receiverId,
      tradeId: tradeRecord?.id,
      content: receiverSystemContent,
    })

    const senderSystemPayload = {
      id: systemMsg.id,
      content: systemMsg.content,
      senderId: systemMsg.senderId,
      receiverId: systemMsg.receiverId,
      createdAt: systemMsg.createdAt.toISOString(),
    }
    const receiverSystemPayload = counterpartMsg ? {
      id: counterpartMsg.id,
      content: counterpartMsg.content,
      senderId: counterpartMsg.senderId,
      receiverId: counterpartMsg.receiverId,
      createdAt: counterpartMsg.createdAt.toISOString(),
    } : null

    pusher
      .trigger(`private-user-${offer.senderId}`, "offer-updated", {
        offerId,
        status: newStatus,
        actorName,
        releasedLeaves: action === "decline" && proposerPays ? fee : 0,
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
      })
      .then(() => Promise.all([
        pusher.trigger(`private-user-${offer.senderId}`, "new-message", senderSystemPayload),
        ...(receiverSystemPayload ? [
          pusher.trigger(`private-user-${offer.receiverId}`, "new-message", receiverSystemPayload),
        ] : []),
        ...(receiverSystemPayload ? [
          pusher.trigger(`private-user-${offer.receiverId}`, "offer-updated", {
            offerId,
            status: newStatus,
            actorName,
            systemMessage: receiverSystemPayload ?? undefined,
            ...(tradeRecord && {
              tradeId: tradeRecord.id,
              offeredItemTitle: tradeRecord.offeredItemTitle,
              requestedItemTitle: tradeRecord.requestedItemTitle,
              senderName: offer.sender?.name ?? "",
              receiverName: actorName,
              receiverId: offer.receiverId,
            }),
          }),
        ] : []),
      ]))
      .catch(() => {})

    return NextResponse.json({
      status: newStatus,
      bridgeFeeLeaves: fee > 0 ? fee : null,
      bridgeFeePaidBySender: fee > 0 ? proposerPays : null,
      /** What the ACCEPTER was just charged. 0 unless they were the payer. */
      chargedLeaves: action === "accept" && fee > 0 && !proposerPays ? fee : 0,
      releasedLeaves: action === "decline" && proposerPays ? fee : 0,
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
  } catch (e) {
    console.error("[offers/decide]", e)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

/** Thrown inside the accept transaction so the ACCEPTED status rolls back with the failed hold. */
class ReceiverShort extends Error {
  constructor(readonly need: number, readonly have: number) {
    super("receiver_short")
    this.name = "ReceiverShort"
  }
}
