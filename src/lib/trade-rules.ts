import { BRACKET_COUNT, bracketOf, bracketRange, type Bracket } from "@/lib/brackets"

/**
 * The rules of bracket trading, as functions. THE ONLY PLACE THEY ARE WRITTEN.
 *
 * ── WHAT CHANGED ON 16 SEP 2026 ─────────────────────────────────────────────
 *
 * Trading used to be about the exact Leaves gap between two items: the offer
 * screen drew it, the proposer patched it with Leaves or a deferred promise,
 * and every surface in the flow named both values. That is gone. An offer is
 * now ONE item for ONE item, judged only by bracket:
 *
 *   same bracket           allowed, free
 *   one bracket apart      allowed -- a "bridge" -- for a fee
 *   two or more apart      refused, in either direction
 *
 * ── WHO PAYS, AND WHY IT IS NOT ALWAYS THE PROPOSER ─────────────────────────
 *
 * THE SIDE THAT ENDS UP WITH THE HIGHER-BRACKET ITEM PAYS, whoever did the
 * asking. That is the whole of the rule, and every other statement about the
 * fee falls out of it:
 *
 *   fee     = 10 x the bracket of the LOWER item, which is the payer's own
 *   payer   = whoever is handing over that lower item
 *   when    = when that side COMMITS. The proposer commits by proposing, so a
 *             down-bridge is held at propose. The receiver commits by
 *             accepting, so an up-bridge is held at accept.
 *   to whom = the counterparty, at completion.
 *
 * The first version of this charged the proposer always and refused an offer
 * of anything higher than the listing outright. Refusing was wrong: somebody
 * offering more than you asked for is not an attack, and the fee is not a
 * penalty for asking -- it prices the bracket someone moves UP into. Charging
 * the proposer for moving somebody else up would have been a toll on
 * generosity.
 *
 * The fee and the completion reward are both functions of a BRACKET, never of
 * a value. That is deliberate and load-bearing: other people's listings are
 * shown as brackets, and an amount derived from the exact value would reveal
 * it. Nothing in this file takes a `valueLeaves`, except the value-cap helpers
 * at the bottom, which are about the owner's OWN listing.
 *
 * ── SERVER AND CLIENT ───────────────────────────────────────────────────────
 *
 * `baylo-mobile/src/lib/trade-rules.ts` carries the same functions so a
 * screen can grey a row or quote a fee before the round trip. Hand-kept in
 * step, the same arrangement as `brackets.ts`. The server re-derives every
 * answer from the database on propose AND on accept; the client copy is a
 * courtesy, never a boundary.
 */

/**
 * Bumped whenever the trading policy text changes. Recorded on every bridge
 * offer as `Offer.policyVersion` alongside `consentAt`, so a dispute can say
 * which wording the proposer agreed to. A client sending a stale version is
 * refused and told to reload.
 */
export const TRADING_POLICY_VERSION = "2026-09-16"

/** Where the policy lives. The consent sheet links here. */
export const TRADING_POLICY_PATH = "/policy/trading"

// ── Legality ─────────────────────────────────────────────────────────────────

export type OfferLegality =
  /** Same bracket. No fee. */
  | "same"
  /** Offered item one bracket BELOW the listing. The proposer moves up, and pays. */
  | "bridgeUp"
  /** Offered item one bracket ABOVE the listing. The receiver moves up, and pays. */
  | "bridgeDown"
  /** Two or more below. Refused. */
  | "tooLow"
  /** Two or more above. Refused. */
  | "tooHigh"

/** How far apart the two brackets may be, in either direction. */
export const MAX_BRACKET_GAP = 1

/**
 * `offerLegality(2, 3)` → "bridgeUp" (you offer less, you move up);
 * `(4, 3)` → "bridgeDown"; `(3, 3)` → "same"; `(1, 3)` → "tooLow";
 * `(5, 3)` → "tooHigh".
 *
 * NAMED FROM THE PROPOSER'S POINT OF VIEW, because every caller is looking at
 * a screen belonging to one of the two people and the proposer is the one
 * choosing. "Up" is the direction the proposer's own holdings move.
 *
 * Pure over two brackets, so the picker, the composer and both server checks
 * are the same comparison.
 */
export function offerLegality(offered: Bracket, target: Bracket): OfferLegality {
  const gap = target - offered
  if (gap === 0) return "same"
  if (gap > MAX_BRACKET_GAP) return "tooLow"
  if (gap < -MAX_BRACKET_GAP) return "tooHigh"
  return gap > 0 ? "bridgeUp" : "bridgeDown"
}

/** True for the three legalities that may actually be sent. */
export function offerAllowed(legality: OfferLegality): boolean {
  return legality === "same" || legality === "bridgeUp" || legality === "bridgeDown"
}

// ── The bridging fee ─────────────────────────────────────────────────────────

/** Leaves per bracket of the LOWER item. A 1↔2 bridge costs 10, a 6↔7 costs 60. */
export const BRIDGE_FEE_PER_BRACKET = 10

/**
 * The fee for a bridge whose lower item sits in `lowerBracket` -- which is
 * always the PAYER's own item, in both directions.
 *
 * `null` for the top bracket: a bracket-10 item cannot be the lower half of a
 * bridge, because there is no bracket 11 for the other half to be in. A caller
 * that gets null has asked a question with no answer rather than a free
 * bridge. (Two bracket-10 items are "same", not a bridge, and cost nothing.)
 */
export function bridgingFee(lowerBracket: Bracket): number | null {
  if (lowerBracket < 1 || lowerBracket >= BRACKET_COUNT) return null
  return BRIDGE_FEE_PER_BRACKET * lowerBracket
}

/** Which side of an offer pays the bridging fee. */
export type FeePayer = "proposer" | "receiver"

export interface OfferTerms {
  legality: OfferLegality
  allowed: boolean
  /** 0 when there is nothing to pay, or when the pair is not allowed. */
  fee: number
  /** null when `fee` is 0. */
  payer: FeePayer | null
  /** The bracket the fee was derived from: the lower of the two. */
  feeBracket: Bracket | null
}

/**
 * Everything about the money on one offer, in one call, so that "is it legal",
 * "what does it cost" and "who pays" can never disagree.
 *
 * THE PAYER IS THE SIDE HANDING OVER THE LOWER ITEM -- equivalently, the side
 * receiving the higher one. `bridgeUp` is the proposer (they offered the
 * smaller item); `bridgeDown` is the receiver (their listing is the smaller
 * item, and they are being offered something bigger).
 */
export function offerTerms(offered: Bracket, target: Bracket): OfferTerms {
  const legality = offerLegality(offered, target)
  const allowed = offerAllowed(legality)
  if (!allowed || legality === "same") {
    return { legality, allowed, fee: 0, payer: null, feeBracket: null }
  }
  const feeBracket = Math.min(offered, target)
  const fee = bridgingFee(feeBracket) ?? 0
  return {
    legality,
    allowed,
    fee,
    payer: legality === "bridgeUp" ? "proposer" : "receiver",
    feeBracket,
  }
}

/**
 * Just the amount. `null` when the pair is not allowed at all, 0 when it is
 * free -- a caller that needs to tell those apart wants `offerTerms()`.
 */
export function feeForOffer(offered: Bracket, target: Bracket): number | null {
  const terms = offerTerms(offered, target)
  return terms.allowed ? terms.fee : null
}

// ── The completion reward ────────────────────────────────────────────────────

/** Leaves per bracket of the item the user GAVE. */
export const TRADE_REWARD_PER_BRACKET = 2

/**
 * What one party earns when a trade completes: 2 x the bracket of the item
 * THEY handed over. Change the number here and nowhere else.
 *
 * Takes a bracket, not a value. The reward is visible to both parties and to
 * the ledger, and 2 x bracket says "bracket 3" where 2 x value would say
 * "425 Leaves" -- the figure the other side is never shown.
 */
export function tradeReward(givenBracket: Bracket): number {
  const b = Math.min(Math.max(1, Math.trunc(givenBracket)), BRACKET_COUNT)
  return TRADE_REWARD_PER_BRACKET * b
}

/**
 * Anti-farming. Three independent limits, each judged per party, each denying
 * that party's reward and nothing else -- the trade still completes.
 *
 *   REPEAT_PAIR_DAYS   no reward when these two users completed any other
 *                      trade together in the window before this one, either
 *                      direction. The obvious loop: A and B pass two items
 *                      back and forth.
 *   SAME_ITEM_DAYS     no reward to the GIVER when the item they gave was in
 *                      any completed trade in the window. Catches the loop
 *                      the pair rule misses -- A→B→C→A rings, and "receive it,
 *                      relist it, hand it back" -- because the item keeps its
 *                      id through relisting.
 *   DAILY_CAP_LEAVES   the most TRADE_REWARD one user can collect in a rolling
 *                      day. Two bracket-10 trades, or twenty bracket-1s.
 *
 * All three are anchored to the trade's own completion time, never to
 * wall-clock now, so a backfill or a replay judges the trade against the
 * history it actually had.
 */
export const TRADE_REWARD_REPEAT_PAIR_DAYS = 7
export const TRADE_REWARD_SAME_ITEM_DAYS = 30
export const TRADE_REWARD_DAILY_CAP_LEAVES = 40

// ── Setting your own value ───────────────────────────────────────────────────

/** How many brackets above the SUGGESTION's bracket an owner may go unreviewed. */
export const VALUE_RAISE_BRACKETS = 1

export type ValueDecision =
  /** No number given, or the suggestion typed back in. Not user-set. */
  | "suggested"
  /** Below the suggestion. Always allowed. */
  | "lowered"
  /** Above it, but no more than VALUE_RAISE_BRACKETS above its bracket. */
  | "raisedWithinCap"
  /** Above that. Saved, but the listing waits in PENDING_REVIEW. */
  | "needsReview"

/**
 * The ceiling an owner may raise a suggestion to without review, as a bracket
 * and as a value. `maxValueWithoutReview` is null when that bracket is the
 * open-ended top one.
 */
export function valueCap(suggestedLeaves: number): {
  suggestedBracket: Bracket
  maxBracketWithoutReview: Bracket
  maxValueWithoutReview: number | null
} {
  const suggestedBracket = bracketOf(suggestedLeaves)
  const maxBracketWithoutReview = Math.min(BRACKET_COUNT, suggestedBracket + VALUE_RAISE_BRACKETS)
  return {
    suggestedBracket,
    maxBracketWithoutReview,
    maxValueWithoutReview: bracketRange(maxBracketWithoutReview).max,
  }
}

/**
 * Which of the four cases a requested value falls in. Pure, so the post
 * wizard, the edit sheet and decideItemValue() agree on the line.
 */
export function classifyValue(requested: number | null | undefined, suggestedLeaves: number): ValueDecision {
  if (requested == null || requested <= 0 || requested === suggestedLeaves) return "suggested"
  if (requested < suggestedLeaves) return "lowered"
  const { maxBracketWithoutReview } = valueCap(suggestedLeaves)
  return bracketOf(requested) <= maxBracketWithoutReview ? "raisedWithinCap" : "needsReview"
}
