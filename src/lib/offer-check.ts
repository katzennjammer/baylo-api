import type { PrismaClient } from "@/generated/prisma/client"
import { bracketOf, type Bracket } from "@/lib/brackets"
import { offerTerms, type FeePayer, type OfferLegality } from "@/lib/trade-rules"

/**
 * Everything the server checks about the two ITEMS of an offer, from the
 * database, in one call -- on propose, and again on accept.
 *
 * ── WHY ONE FUNCTION FOR BOTH MOMENTS ───────────────────────────────────────
 *
 * The rule is "same bracket or one below, for a fee", and it is a rule about
 * the items as they ARE, not as they were. A value can be edited between the
 * offer being sent and the receiver tapping accept (the edit path refuses
 * while an offer is pending, but a listing can be relisted, an admin can
 * approve a review, a revaluation can land). So accept re-derives the whole
 * answer from the rows and compares it with what the offer recorded; a
 * bracket that moved is a refusal with both figures in it, not a silent
 * acceptance under rules the proposer never agreed to.
 *
 * The premium gate and the tier cap are NOT here. They are about the person
 * acquiring, not about the pair of items, and they already run in
 * @/lib/reputation-gate on both paths. This module is the items.
 *
 * WHAT IT RETURNS ABOUT MONEY is `fee` and `payer`, from offerTerms(). Both
 * directions of bridge are legal -- one bracket either way -- and the side
 * handing over the LOWER item is the one that pays. A route reads `payer` to
 * decide whose balance to touch and whose consent to demand; it never works
 * that out from the brackets itself.
 */

type CheckDb = Pick<PrismaClient, "item">

export type OfferRefusal =
  | "ITEM_NOT_FOUND"
  | "ITEM_UNVALUED"
  | "ITEM_NOT_AVAILABLE"
  | "NOT_YOUR_ITEM"
  | "OWN_LISTING"
  | "OFFER_BRACKET_TOO_LOW"
  | "OFFER_BRACKET_TOO_HIGH"

export type OfferAssessment =
  | {
      ok: true
      offeredBracket: Bracket
      targetBracket: Bracket
      legality: Extract<OfferLegality, "same" | "bridgeUp" | "bridgeDown">
      /** 0 for same-bracket. */
      fee: number
      /** Who owes `fee`. null when there is none. See @/lib/trade-rules. */
      payer: FeePayer | null
      offered: { id: string; title: string; userId: string }
      target: { id: string; title: string; userId: string }
    }
  | {
      ok: false
      code: OfferRefusal
      message: string
      offeredBracket?: Bracket
      targetBracket?: Bracket
    }

function refuse(
  code: OfferRefusal,
  message: string,
  brackets: { offeredBracket?: Bracket; targetBracket?: Bracket } = {},
): OfferAssessment {
  return { ok: false, code, message, ...brackets }
}

/**
 * `proposerId` is the sender. `allowOfferedStatus` widens what the OFFERED
 * item may read: on propose it must be AVAILABLE; on accept it is still
 * AVAILABLE (the trade locks it IN_TRADE only after acceptance), so the
 * default serves both. The target must be AVAILABLE on both paths.
 */
export async function assessOffer(
  db: CheckDb,
  input: { proposerId: string; offeredItemId: string; targetItemId: string },
): Promise<OfferAssessment> {
  const { proposerId, offeredItemId, targetItemId } = input

  if (offeredItemId === targetItemId) {
    return refuse("OWN_LISTING", "You cannot offer a listing for itself.")
  }

  const rows = await db.item.findMany({
    where: { id: { in: [offeredItemId, targetItemId] } },
    select: {
      id: true, title: true, userId: true, status: true, valueLeaves: true, moderationHiddenAt: true,
    },
  })
  const offered = rows.find((r) => r.id === offeredItemId)
  const target = rows.find((r) => r.id === targetItemId)

  if (!target || target.moderationHiddenAt) return refuse("ITEM_NOT_FOUND", "That listing is no longer available.")
  if (!offered || offered.moderationHiddenAt) return refuse("ITEM_NOT_FOUND", "The item you are offering is no longer available.")

  if (target.userId === proposerId) return refuse("OWN_LISTING", "You cannot make an offer on your own listing.")
  if (offered.userId !== proposerId) return refuse("NOT_YOUR_ITEM", "You can only offer an item you own.")

  if (target.status !== "AVAILABLE") {
    return refuse("ITEM_NOT_AVAILABLE", `"${target.title}" is not available to trade right now.`)
  }
  if (offered.status !== "AVAILABLE") {
    return refuse("ITEM_NOT_AVAILABLE", `"${offered.title}" is not available to offer right now.`)
  }

  // An unvalued item has no bracket, and a rule about brackets cannot pass it.
  // This closes the hole the old gates left open, where a NULL value passed
  // every check.
  if (target.valueLeaves === null) {
    return refuse("ITEM_UNVALUED", `"${target.title}" has no value on record yet, so it cannot be traded for.`)
  }
  if (offered.valueLeaves === null) {
    return refuse("ITEM_UNVALUED", `"${offered.title}" has no value on record yet, so it cannot be offered.`)
  }

  const offeredBracket = bracketOf(offered.valueLeaves)
  const targetBracket = bracketOf(target.valueLeaves)
  const terms = offerTerms(offeredBracket, targetBracket)
  const brackets = { offeredBracket, targetBracket }

  if (terms.legality === "tooLow") {
    return refuse(
      "OFFER_BRACKET_TOO_LOW",
      `"${offered.title}" is Bracket ${offeredBracket}, ${targetBracket - offeredBracket} brackets below ` +
        `"${target.title}" at Bracket ${targetBracket}. Trading 2 or more brackets above your item isn't allowed — ` +
        "you can go up by one bracket at most.",
      brackets,
    )
  }
  if (terms.legality === "tooHigh") {
    return refuse(
      "OFFER_BRACKET_TOO_HIGH",
      `"${offered.title}" is Bracket ${offeredBracket}, ${offeredBracket - targetBracket} brackets above ` +
        `"${target.title}" at Bracket ${targetBracket}. You can go up or down by one bracket at most — ` +
        "offer something closer to what you are asking for.",
      brackets,
    )
  }

  return {
    ok: true,
    ...brackets,
    legality: terms.legality,
    fee: terms.fee,
    payer: terms.payer,
    offered: { id: offered.id, title: offered.title, userId: offered.userId },
    target: { id: target.id, title: target.title, userId: target.userId },
  }
}

/** HTTP status for a refusal: the two bracket rules are 403 like every other gate; the rest are 4xx by kind. */
export function refusalStatus(code: OfferRefusal): number {
  switch (code) {
    case "ITEM_NOT_FOUND":
      return 404
    case "OFFER_BRACKET_TOO_LOW":
    case "OFFER_BRACKET_TOO_HIGH":
    case "NOT_YOUR_ITEM":
      return 403
    case "ITEM_NOT_AVAILABLE":
      return 409
    case "ITEM_UNVALUED":
    case "OWN_LISTING":
      return 400
  }
}
