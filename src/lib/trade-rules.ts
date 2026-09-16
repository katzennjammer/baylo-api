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
 *   exactly one lower      allowed -- a "bridge" -- for a fee the proposer
 *                          pays, held at proposal and paid to the receiver on
 *                          completion
 *   two or more lower      refused
 *   any bracket higher     refused
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
export const TRADING_POLICY_PATH = "/trust#trading"

// ── Legality ─────────────────────────────────────────────────────────────────

export type OfferLegality =
  /** Same bracket. No fee. */
  | "same"
  /** Exactly one bracket below. Allowed, for the fee. */
  | "bridge"
  /** Two or more below. Refused. */
  | "tooLow"
  /** Above the listing. Refused. */
  | "higher"

/** How many brackets below the target an offered item may sit. */
export const MAX_BRACKETS_BELOW = 1

/**
 * `offerLegality(2, 3)` → "bridge"; `(3, 3)` → "same"; `(1, 3)` → "tooLow";
 * `(4, 3)` → "higher". Pure over two brackets, so the picker, the composer and
 * both server checks are the same comparison.
 */
export function offerLegality(offered: Bracket, target: Bracket): OfferLegality {
  if (offered === target) return "same"
  if (offered > target) return "higher"
  return target - offered <= MAX_BRACKETS_BELOW ? "bridge" : "tooLow"
}

/** True for the two legalities that may actually be sent. */
export function offerAllowed(legality: OfferLegality): boolean {
  return legality === "same" || legality === "bridge"
}

// ── The bridging fee ─────────────────────────────────────────────────────────

/** Leaves per bracket of the item being OFFERED. 1→2 costs 10, 6→7 costs 60. */
export const BRIDGE_FEE_PER_BRACKET = 10

/**
 * The fee for offering an item of `offeredBracket` one bracket up. `null` for
 * the top bracket: there is nothing above it to bridge to, and a caller that
 * gets null has asked a question with no answer rather than a free bridge.
 */
export function bridgingFee(offeredBracket: Bracket): number | null {
  if (offeredBracket < 1 || offeredBracket >= BRACKET_COUNT) return null
  return BRIDGE_FEE_PER_BRACKET * offeredBracket
}

/**
 * The fee an offer of `offered` for `target` carries: 0 when same-bracket, the
 * formula when it is a bridge, and `null` when the pair is not allowed at all.
 * One call for the propose route, so "is it legal" and "what does it cost"
 * cannot disagree.
 */
export function feeForOffer(offered: Bracket, target: Bracket): number | null {
  const legality = offerLegality(offered, target)
  if (legality === "same") return 0
  if (legality === "bridge") return bridgingFee(offered)
  return null
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
