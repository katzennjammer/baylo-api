import { NextRequest, NextResponse } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import pusher from "@/lib/pusher"
import { createOfferSchema, parseBody } from "@/lib/validation"
import { enforceInitiateTrade } from "@/lib/reputation-gate"

function firstImage(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) && typeof parsed[0] === "string" ? parsed[0] : null
  } catch {
    return null
  }
}
import { enforceNotBlocked } from "@/lib/blocking"
import { assessOffer, refusalStatus } from "@/lib/offer-check"
import { holdBridgeFee } from "@/lib/bridge-fee"
import { TRADING_POLICY_VERSION } from "@/lib/trade-rules"
import { settleQuestsAsync } from "@/lib/quests"

/**
 * POST /api/offers — one of your items for one of theirs.
 *
 * ── WHAT AN OFFER IS, SINCE 16 SEP 2026 ─────────────────────────────────────
 *
 * ONE item for ONE item, and nothing else. It used to be a list of items plus
 * an optional pile of Leaves to patch the value gap, optionally plus a
 * deferred promise for the rest. All three of those are gone: the gap is not
 * patched any more, it is BRIDGED. The offered item must be within ONE BRACKET
 * of the listing, either way, and a one-bracket gap costs a fee — see
 * @/lib/trade-rules for the formula and @/lib/offer-check for the check.
 *
 * ── WHICH BRIDGES THIS ROUTE CHARGES FOR ────────────────────────────────────
 *
 * Only the one where the PROPOSER moves up: they offered the lower item, so
 * they pay, and they pay here. An offer of something HIGHER than the listing
 * is equally legal and costs the proposer nothing — the receiver is the one
 * moving up, and they are charged when they accept (PATCH /api/offers/[id]).
 * This route quotes that fee in its response and stores it on the row so the
 * receiver's sheet has a number, but nothing is held and no consent is asked
 * for: the proposer is not agreeing to anything.
 *
 * `offeredLeaves` is REFUSED rather than ignored. A shipped client still
 * sending it would otherwise get a 201 and an offer that quietly said
 * something different from what the person tapped — the same silent-wrong-
 * answer failure the confirm route refuses `safeZone: true` to avoid.
 *
 * ── THE FEE IS TAKEN HERE, IN THE SAME TRANSACTION AS THE OFFER ─────────────
 *
 * A bridge offer writes three things together: the Offer row, the proposer's
 * balance, and a BRIDGE_FEE_HOLD ledger row. If any of them fails none of them
 * happened. The alternative — create the offer, then take the fee — has a
 * window in which an offer exists that nobody has paid for, and the fee is the
 * only thing making a bridge cost anything.
 *
 * ── CONSENT IS A COLUMN, NOT A CHECKBOX ─────────────────────────────────────
 *
 * The client shows a confirmation sheet with the fee, the balance before and
 * after, and a tick-box. That sheet is a courtesy; THIS is the record. A bridge
 * without `consent.accepted` and a current `policyVersion` is refused, and what
 * is stored is the moment and the version, so a dispute can say which wording
 * the proposer agreed to. A same-bracket offer costs nothing and needs none.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await resolveSession()
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const senderId = session.user.id

    const parsed = await parseBody(req, createOfferSchema)
    if (!parsed.ok) return parsed.response
    const { postId, offeredItemId, message, consent } = parsed.data

    // ── The pair: both brackets, ownership, availability, the fee ──
    //
    // Before the reputation gates and before anything is written. It is the
    // check that needs both items, and its refusals name them.
    const assessed = await assessOffer(prisma, {
      proposerId: senderId,
      offeredItemId,
      targetItemId: postId,
    })
    if (!assessed.ok) {
      return NextResponse.json(
        { error: assessed.message, code: assessed.code, offeredBracket: assessed.offeredBracket, targetBracket: assessed.targetBracket },
        { status: refusalStatus(assessed.code) },
      )
    }
    // What the PROPOSER owes. Zero on a same-bracket offer and zero on an
    // up-bridge, where the receiver pays at accept.
    const proposerFee = assessed.payer === "proposer" ? assessed.fee : 0

    const post = await prisma.item.findUniqueOrThrow({
      where: { id: postId },
      select: { id: true, title: true, images: true, userId: true, user: { select: { id: true, name: true } } },
    })

    // An offer is a trade initiation and creates a chat message as a side
    // effect, so it is barred by a block on both counts. Before the reputation
    // gates, for the same reason as the trade route.
    const blocked = await enforceNotBlocked(senderId, post.userId, "make an offer to this person")
    if (blocked) return blocked

    // ── Reputation gates, INITIATING path ──
    //
    // Against `post` -- the item the offerer would RECEIVE. The item they are
    // putting up is their own and is not capped. assessOffer() above has
    // already judged the pair; these two judge the person.
    const gate = await enforceInitiateTrade(senderId, [postId])
    if (gate.response) return gate.response

    // One live offer per listing per sender. Without this a proposer stacks
    // three bridges on one listing and holds three fees against a listing that
    // can only be traded once.
    const standing = await prisma.offer.findFirst({
      where: { postId, senderId, status: "PENDING" },
      select: { id: true },
    })
    if (standing) {
      return NextResponse.json(
        { error: "You already have an offer waiting on this listing.", code: "OFFER_ALREADY_PENDING", offerId: standing.id },
        { status: 409 },
      )
    }

    const duplicateOfferedItem = await prisma.offer.findFirst({
      where: {
        senderId,
        status: "PENDING",
        offeredItems: { contains: offeredItemId },
      },
      select: { id: true },
    })
    if (duplicateOfferedItem) {
      return NextResponse.json(
        { error: "You already have a pending offer using that item.", code: "OFFERED_ITEM_ALREADY_PENDING", offerId: duplicateOfferedItem.id },
        { status: 409 },
      )
    }

    // ── Consent, from the proposer, only when the proposer is paying ──
    if (proposerFee > 0) {
      if (!consent?.accepted) {
        return NextResponse.json(
          {
            error: `Offering a Bracket ${assessed.offeredBracket} item for a Bracket ${assessed.targetBracket} item costs ${proposerFee} Leaves. You have to agree to the bridging fee and the trading policy before this can be sent.`,
            code: "CONSENT_REQUIRED",
            fee: proposerFee,
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

    const now = new Date()

    /*
     * The offer, the balance and the ledger row, or none of them.
     *
     * The balance check lives INSIDE holdBridgeFee(), against a figure read in
     * this transaction, and the debit is conditional on it still covering the
     * fee. Checking here and debiting there would leave a window two concurrent
     * proposals could both pass.
     */
    let offer: { id: string }
    try {
      offer = await prisma.$transaction(async (tx) => {
        const duplicate = await tx.offer.findFirst({
          where: {
            senderId,
            status: "PENDING",
            offeredItems: { contains: offeredItemId },
          },
          select: { id: true },
        })
        if (duplicate) throw new DuplicateOfferedItem()

        const created = await tx.offer.create({
          data: {
            postId,
            senderId,
            receiverId: post.userId,
            // The shape the chat card and the accept path read. One item now,
            // still an array on the wire: the column is a JSON blob with years
            // of rows in it and re-shaping it would be a migration of text.
            offeredItems: JSON.stringify([{ id: assessed.offered.id, title: assessed.offered.title }]),
            offeredLeaves: null,
            message: message?.trim() || null,
            status: "PENDING",
            // The QUOTE, either direction. Set even when the receiver is the
            // one who will pay it -- their accept sheet needs the number, and
            // the accept path re-derives and re-checks it anyway. It is not a
            // claim that anything is held; see HELD_ON_OFFER_WHERE.
            bridgeFeeLeaves: assessed.fee > 0 ? assessed.fee : null,
            offeredBracket: assessed.offeredBracket,
            targetBracket: assessed.targetBracket,
            // The proposer's consent, when the proposer is the payer. An
            // up-bridge leaves these null until the receiver consents at
            // accept, onto this same row.
            ...(proposerFee > 0 ? { consentAt: now, policyVersion: TRADING_POLICY_VERSION } : {}),
          },
          select: { id: true },
        })

        if (proposerFee > 0) {
          const held = await holdBridgeFee(tx, {
            userId: senderId,
            offerId: created.id,
            amount: proposerFee,
            at: now,
          })
          if (!held.ok) {
            throw new InsufficientLeaves(proposerFee, held.have)
          }
        }
        return created
      })
    } catch (e) {
      if (e instanceof InsufficientLeaves) {
        return NextResponse.json(
          {
            error: `Proposing this trade costs ${e.need} Leaves and you have ${e.have}. You need ${e.need - e.have} more.`,
            code: "INSUFFICIENT_LEAVES",
            need: e.need,
            have: e.have,
            short: e.need - e.have,
          },
          { status: 400 },
        )
      }
      if (e instanceof DuplicateOfferedItem) {
        return NextResponse.json(
          { error: "You already have a pending offer using that item.", code: "OFFERED_ITEM_ALREADY_PENDING" },
          { status: 409 },
        )
      }
      throw e
    }

    // Daily quests, now that the offer has committed: the sender's "send an
    // offer" pair and the receiver's "get an offer". Fire-and-forget.
    settleQuestsAsync(senderId, ["SEND_OFFER", "SEND_BRIDGE_OFFER"])
    settleQuestsAsync(post.userId, ["RECEIVE_OFFER"])

    const sender = await prisma.user.findUnique({
      where: { id: senderId },
      select: { name: true, avatar: true, leaves: true },
    })

    // The offer card in the chat thread. `offeredLeaves` is kept in the payload
    // as an explicit null so an older client renders no Leaves line rather than
    // `undefined`; `bridgeFeeLeaves` and the two brackets are what a current
    // client draws.
    const msgContent = JSON.stringify({
      type: "offer",
      offerId: offer.id,
      postId,
      offeredItems: [{ id: assessed.offered.id, title: assessed.offered.title, imageUrl: firstImage(assessed.offered.images) }],
      postItem: { title: post.title, imageUrl: firstImage(post.images) },
      offeredLeaves: null,
      offeredBracket: assessed.offeredBracket,
      targetBracket: assessed.targetBracket,
      bridgeFeeLeaves: assessed.fee > 0 ? assessed.fee : null,
      bridgeFeePayer: assessed.payer,
      userMessage: message?.trim() || null,
      senderName: sender?.name ?? "Someone",
      senderId,
      status: "PENDING",
    })

    const chatMessage = await prisma.message.create({
      data: { senderId, receiverId: post.userId, content: msgContent },
    })

    pusher
      .trigger(`private-user-${post.userId}`, "new-message", {
        id: chatMessage.id,
        content: chatMessage.content,
        senderId: chatMessage.senderId,
        receiverId: chatMessage.receiverId,
        createdAt: chatMessage.createdAt.toISOString(),
        senderName: sender?.name ?? "",
        senderAvatar: sender?.avatar ?? null,
      })
      .catch(() => {})

    await prisma.notification.deleteMany({
      where: { userId: post.userId, actorId: senderId, type: "NEW_MESSAGE", read: false },
    })
    await prisma.notification.create({
      data: {
        userId: post.userId,
        type: "NEW_MESSAGE",
        message: `made you an offer on "${post.title}"`,
        link: `/dashboard/messages?partner=${senderId}`,
        actorId: senderId,
        // `link` is a WEB path and the mobile client cannot route from it, so
        // the structured target is what makes the row tappable on a phone.
        // "conversation" carries the OTHER participant's id, which from the
        // recipient's side is the sender.
        entityType: "conversation",
        entityId: senderId,
      },
    })

    return NextResponse.json(
      {
        offerId: offer.id,
        messageId: chatMessage.id,
        partnerId: post.userId,
        partnerName: post.user.name,
        offeredBracket: assessed.offeredBracket,
        targetBracket: assessed.targetBracket,
        // 0 for a same-bracket offer. The client shows the fee it was quoted
        // beside the balance it now has, so both are returned.
        bridgeFeeLeaves: assessed.fee,
        /** "proposer", "receiver" or null. Who owes the fee above. */
        bridgeFeePayer: assessed.payer,
        /** What the proposer actually paid just now. 0 on an up-bridge. */
        chargedLeaves: proposerFee,
        /**
         * The line the composer shows before sending an up-bridge: the fee is
         * real, it is just not theirs. Null when there is nothing to say.
         */
        receiverWillPay:
          assessed.payer === "receiver"
            ? `${post.user.name ?? "They"} will pay a ${assessed.fee}-Leaf bridging fee to accept.`
            : null,
        leaves: sender?.leaves ?? 0,
      },
      { status: 201 },
    )
  } catch (e) {
    console.error("[offers/create]", e)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

/** Thrown inside the transaction so the offer row rolls back with the failed hold. */
class InsufficientLeaves extends Error {
  constructor(readonly need: number, readonly have: number) {
    super("insufficient_leaves")
    this.name = "InsufficientLeaves"
  }
}

class DuplicateOfferedItem extends Error {
  constructor() {
    super("offered_item_already_pending")
    this.name = "DuplicateOfferedItem"
  }
}
