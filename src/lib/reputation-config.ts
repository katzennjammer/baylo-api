// ── Reputation gates ─────────────────────────────────────────────────────────
// Every threshold and every limit the trust tiers impose, in one file, so they
// can be tuned without reading a single route handler.
//
// Two halves, and the split matters:
//
//   TIER_THRESHOLDS  — how a tier is DERIVED (trades + rating). These were
//                      previously inline literals in getTrustTier(), where the
//                      tier was display-only and nothing depended on the
//                      numbers being findable.
//   TIER_LIMITS      — what a tier PERMITS. New. This is the half that turns a
//                      badge into a control.
//
// Nothing here enforces anything. Enforcement lives in @/lib/reputation-gate
// and is called from the route handlers, because a limit that is only consulted
// by the UI is not a limit — the client is not a trusted participant.

import type { TrustTier } from "@/lib/reputation"
import { BRACKET_CEILINGS, type Bracket } from "@/lib/brackets"

// ── Tier derivation ──────────────────────────────────────────────────────────
//
// Preserved EXACTLY as getTrustTier() has always computed it, literals lifted
// out and named. Two properties are easy to lose when tuning these, so they are
// written down:
//
//   1. An UNRATED user (rating === 0, i.e. no reviews yet) is never held back
//      by a rating floor. Zero means "unknown", not "terrible".
//   2. The ladder is not monotone in rating. At 25+ trades a 3.5 rating still
//      reads Trusted, while at 15 trades it reads Rising. That is the shipped
//      behaviour and this refactor does not quietly change it.
export const TIER_THRESHOLDS = {
  /** Completed trades needed to leave "New Trader". Also the DPA debtor floor. */
  risingMinTrades: 3,
  trustedMinTrades: 10,
  topMinTrades: 25,
  /** Rating floors. Ignored entirely while a user has no reviews at all. */
  trustedMinRating: 4.0,
  topMinRating: 4.5,
} as const

// ── What a tier permits ──────────────────────────────────────────────────────

export interface TierLimits {
  /**
   * The most valuable item (Item.valueLeaves) this tier may ACQUIRE, as the
   * ladder was originally written. REFERENCE ONLY since 17 Sep 2026 -- the
   * gate enforces `maxItemBracket`, derived from this by rounding DOWN to a
   * whole bracket. See TIER_MAX_ITEM_BRACKET for why.
   */
  maxItemValueLeaves: number | null
  /**
   * The highest BRACKET this tier may ACQUIRE. `null` is unlimited. THIS is
   * what enforceItemValueCeiling() compares against, and what the refusal
   * names.
   *
   * Applied to the item the user RECEIVES, never the one they give away — the
   * exposure being capped is the counterparty's, not theirs.
   */
  maxItemBracket: number | null
  /** Whether this tier may propose a Deferred Points Agreement as the debtor. */
  mayProposeDpa: boolean
  /**
   * Ceiling on this tier's total unpaid DPA principal at any moment, summed
   * across every contract that is not yet settled. `0` means no debt at all,
   * which is what makes mayProposeDpa: false redundant-but-explicit at the
   * bottom tier.
   */
  maxOutstandingDebtLeaves: number
}

/**
 * ── THE ONE TABLE THAT IS HAND-SET ──────────────────────────────────────────
 *
 * The most valuable item each tier may ACQUIRE. Everything else about a tier's
 * exposure is derived from this, so there is exactly one column of numbers to
 * tune and the two halves cannot drift apart.
 *
 * WHY THESE WERE RAISED. The floor tier was 200, and a New Trader could not
 * offer on most of the marketplace at all — a 480-Leaf pair of shoes was out of
 * reach on day one, which made the tier system read as a wall rather than as a
 * ladder. The point of the bottom rung is to cap EXPOSURE, not to make the app
 * unusable before anybody has traded once; 600 covers the ordinary listing and
 * still stops a brand-new account reaching for a laptop.
 *
 * WHAT A TIER ACTUALLY REACHES is the bracket below: these figures are
 * rounded DOWN to a whole bracket before anything is enforced, so a New Trader
 * reaches 500, not 600. See TIER_MAX_ITEM_BRACKET.
 *
 * `null` at the top is unlimited and is deliberate: a Top Trader has 25+
 * completed trades and a rating to protect, which is the only enforcement this
 * platform has.
 */
export const TIER_MAX_ITEM_VALUE: Record<TrustTier, number | null> = {
  "New Trader": 600,
  "Rising Trader": 900,
  "Trusted Trader": 3000,
  "Top Trader": null,
}

/**
 * THE CAP THE GATE ACTUALLY ENFORCES: the same ladder, as a BRACKET.
 *
 * ── WHY THE LEAVES FIGURE STOPPED BEING ENFORCEABLE (17 Sep 2026) ───────────
 *
 * Since bracket trading, a viewer never sees another person's exact value --
 * every listing in the offer flow is "Bracket 4". A cap of 600 Leaves sits in
 * the MIDDLE of bracket 4 (501-900), so two tiles that both read "Bracket 4"
 * behaved differently: a 550-Leaf item could be traded for and a 700-Leaf one
 * could not, with nothing on screen to tell them apart. The refusal said so in
 * as many words -- `"Air Max" is in Bracket 4. As a New Trader you can trade
 * for items up to Bracket 4` -- which is not a sentence anybody can act on.
 *
 * So the cap is a BRACKET and the gate compares brackets.
 *
 * ── IT ROUNDS DOWN ──────────────────────────────────────────────────────────
 *
 * The cap becomes the highest bracket that fits ENTIRELY inside the tier's
 * Leaves figure -- the last bracket whose ceiling is at or below it. Rounding
 * up would have been the kinder arithmetic and it is the wrong one: this is a
 * safety limit, and a limit must never come out LOOSER than it was written
 * because the way it is displayed changed. Nobody set 600 intending 900.
 * Every tier under this rule reaches at most what its figure already allowed:
 *
 *   New Trader      600   -> bracket 3 (up to 500)
 *   Rising Trader   900   -> bracket 4 (up to 900: exact, unchanged)
 *   Trusted Trader  3,000 -> bracket 6 (up to 2,500)
 *   Top Trader      null  -> no cap
 *
 * Two of those are tighter than the Leaves figure by the width of one bracket.
 * That is the cost of a cap a person can act on, and it is paid in the safe
 * direction. To give a tier the rest of its bracket, RAISE ITS FIGURE in
 * TIER_MAX_ITEM_VALUE to that bracket's ceiling -- deliberately, in one place,
 * where the next reader can see it was a decision.
 */
export function capBracketFor(maxValueLeaves: number): Bracket {
  // The last ceiling at or below the figure; its index + 1 is the bracket.
  // Nothing fits below bracket 1, which is the floor.
  let bracket = 1
  for (let i = 0; i < BRACKET_CEILINGS.length; i++) {
    if (BRACKET_CEILINGS[i] <= maxValueLeaves) bracket = i + 1
  }
  return bracket
}

export const TIER_MAX_ITEM_BRACKET: Record<TrustTier, number | null> = Object.fromEntries(
  (Object.keys(TIER_MAX_ITEM_VALUE) as TrustTier[]).map((tier) => [
    tier,
    TIER_MAX_ITEM_VALUE[tier] === null ? null : capBracketFor(TIER_MAX_ITEM_VALUE[tier] as number),
  ]),
) as Record<TrustTier, number | null>

/**
 * How much of an item's value a tier may promise rather than pay.
 *
 * ── WHY THE DEBT CEILING IS DERIVED AND NOT WRITTEN DOWN ────────────────────
 *
 * The two used to be independent tables and they had drifted into a shape that
 * did not mean anything: a Top Trader could ACQUIRE an item of any value but
 * never OWE more than 1,500, so the ceiling stopped tracking what the tier was
 * allowed to reach for. Deriving one from the other makes that impossible —
 * raise what a tier may acquire and what it may promise moves with it.
 *
 * A THIRD, and the reasoning: a DPA covers the GAP between two unequal items,
 * so the ceiling is a statement about how mismatched a swap a tier may propose.
 * At one third, somebody reaching for an item at their cap must already be
 * putting up two thirds of its value. At one half — the other obvious choice —
 * a tier may promise as much as it brings, which is a materially different bet
 * for the creditor and is not what "settle the difference" describes.
 */
export const DEBT_TO_ITEM_CAP_RATIO = 1 / 3

/**
 * The floor tier owes NOTHING, and this is not derived from anything.
 *
 * A New Trader has fewer than three completed trades. The DPA's only
 * enforcement is reputational — a default costs a tier, a public record and the
 * ability to start new trades — and somebody who has not finished a trade yet
 * has none of those to forfeit. Lending to them is lending to the one person
 * the mechanism cannot reach, so the answer is zero at any item cap, and
 * `mayProposeDpa: false` says the same thing a second way.
 */
const FLOOR_TIER: TrustTier = "New Trader"

/**
 * The top tier's ceiling, in Leaves.
 *
 * Explicit because its item cap is `null` and one third of unlimited is
 * unlimited — which is the one number this feature must never permit. An
 * unbounded promise on a platform with no repossession is an unbounded loss,
 * and the tier that has earned the most trust is also the one that could do the
 * most damage with it.
 */
const TOP_TIER_DEBT_CEILING = 3000

/** The ceiling one tier's item cap implies. See the three notes above. */
export function debtCeilingFor(tier: TrustTier): number {
  if (tier === FLOOR_TIER) return 0
  const itemCap = TIER_MAX_ITEM_VALUE[tier]
  if (itemCap === null) return TOP_TIER_DEBT_CEILING
  return Math.round(itemCap * DEBT_TO_ITEM_CAP_RATIO)
}

/**
 * The tier table, built rather than typed.
 *
 * Tune `TIER_MAX_ITEM_VALUE` and the ratio; nothing else reads these numbers
 * except @/lib/reputation-gate, and nothing caches them. What this currently
 * produces:
 *
 *   New Trader       acquire   600   owe      0   (floored, never derived)
 *   Rising Trader    acquire   900   owe    300
 *   Trusted Trader   acquire 3,000   owe  1,000
 *   Top Trader       acquire   any   owe  3,000   (explicit, see above)
 *
 * `maxConcurrentAsDebtor` is still 1, so a tier's ceiling is also its
 * per-agreement cap. That is one lever left deliberately untouched while these
 * numbers are observed.
 */
export const TIER_LIMITS: Record<TrustTier, TierLimits> = Object.fromEntries(
  (Object.keys(TIER_MAX_ITEM_VALUE) as TrustTier[]).map((tier) => [
    tier,
    {
      maxItemValueLeaves: TIER_MAX_ITEM_VALUE[tier],
      maxItemBracket: TIER_MAX_ITEM_BRACKET[tier],
      // Redundant with a ceiling of 0 and stated anyway: it is the field a gate
      // reads to refuse a proposal outright, and a reader of that gate should
      // not have to know that zero means the same thing.
      mayProposeDpa: debtCeilingFor(tier) > 0,
      maxOutstandingDebtLeaves: debtCeilingFor(tier),
    } satisfies TierLimits,
  ]),
) as Record<TrustTier, TierLimits>

// ── Default consequences ─────────────────────────────────────────────────────
//
// A default costs reputation and access. It never costs the item — see the note
// at the head of @/lib/contracts.
//
// The penalty is DERIVED from the contract rows rather than stamped onto the
// User row, and that is a deliberate choice with two reasons. First, the one
// obvious place to put it (User.rating) is recomputed from the review average
// on every new review, so a decrement there would be silently erased by the
// next 5-star rating. Second, a derived penalty cannot be double-applied, which
// is the exact failure the lazy deadline sweep is most likely to produce.

export const DEFAULT_PENALTY = {
  /**
   * Tier steps lost per default, counted over the user's whole history —
   * including defaults they later paid off. The default happened; paying late
   * settles the debt, not the record.
   */
  tierStepsPerDefault: 1,
  /**
   * While a default is UNSETTLED the user is pinned to the floor tier outright,
   * regardless of trade count. Paying it off releases the pin and leaves only
   * the per-default demotion above.
   */
  unsettledDefaultFloorsTier: true,
} as const

// ── Deferred Points Agreement ────────────────────────────────────────────────

export const DPA = {
  /**
   * Completed trades required before a user may be a DEBTOR. Not a tier lookup:
   * this is a hard floor checked on its own, so lowering a tier threshold can
   * never accidentally let a two-trade account borrow.
   *
   * Counted from COMPLETED TradeRequest rows, never from User.totalTrades —
   * that counter has drifted above the real count on live data.
   */
  minCompletedTradesToOwe: 3,
  /**
   * Contracts a debtor may hold in a non-terminal state at once. One, and it
   * counts PENDING_ACCEPT as well as ACTIVE and DEFAULTED — otherwise a debtor
   * stacks five proposals under the cap and blows through it the moment the
   * fifth creditor accepts.
   */
  maxConcurrentAsDebtor: 1,
  /** Bounds on the term a debtor may propose, in days from proposal. */
  minTermDays: 1,
  maxTermDays: 30,
  /** The one extension, if the creditor grants it. Days past the old deadline. */
  minExtensionDays: 1,
  maxExtensionDays: 14,
} as const
