/**
 * Value brackets: the coarse, PRESENTATION-ONLY tiering of `Item.valueLeaves`.
 *
 * ── WHY A BRACKET AND NOT THE NUMBER ────────────────────────────────────────
 *
 * An exact figure on somebody else's listing invites loss aversion: "425
 * Leaves against your 150" reads as a bad deal, "Bracket 3, one above yours"
 * reads as a fair one-tier gap. Same trade, different emotional read. So every
 * DISCOVERY surface -- feed cards, grid tiles, item detail, the out-of-reach
 * line, share text, accessibility labels -- shows the bracket of another
 * person's listing, and the exact number is kept for the surfaces where a
 * person is looking at their OWN worth (their shelf, the post wizard) or
 * COMMITTING to a figure (the offer composer, a DPA, the header balance).
 *
 * ── NOT A COLUMN, NOT A PEG ─────────────────────────────────────────────────
 *
 * The bracket is a lookup over `valueLeaves` and nothing more. There is no
 * `bracket` column to drift from the value it summarises, and the table is in
 * Leaves, never in pesos: `valueLeaves` is unpegged and stays that way, which
 * is what keeps the non-monetary claim true. Do not add a currency column to
 * this table.
 *
 * ── MIRRORED ON THE MOBILE CLIENT ───────────────────────────────────────────
 *
 * `baylo-mobile/src/lib/brackets.ts` carries the same table so a tile can be
 * bracketed without a round trip. The two are hand-kept in step, the same
 * arrangement as the tier ladder; change one, change the other.
 */

/** Upper bound of each bracket, inclusive, in Leaves. The last is open-ended. */
export const BRACKET_CEILINGS: readonly number[] = [
  100, // 1
  250, // 2
  500, // 3
  900, // 4
  1500, // 5
  2500, // 6
  4000, // 7
  9000, // 8
  12000, // 9
  // 10: everything above
]

export const BRACKET_COUNT = BRACKET_CEILINGS.length + 1

/** A bracket number, 1..BRACKET_COUNT. */
export type Bracket = number

/**
 * `bracketOf(425)` → 3. Values at or below zero land in bracket 1: a listing
 * cannot be worth a negative amount, and a defensive floor is cheaper than a
 * bracket 0 that no copy knows how to name.
 */
export function bracketOf(valueLeaves: number): Bracket {
  const i = BRACKET_CEILINGS.findIndex((ceiling) => valueLeaves <= ceiling)
  return i === -1 ? BRACKET_COUNT : i + 1
}

/** Inclusive Leaves range of a bracket; `max` is null for the open top. */
export function bracketRange(bracket: Bracket): { min: number; max: number | null } {
  const b = Math.min(Math.max(1, Math.trunc(bracket)), BRACKET_COUNT)
  const min = b === 1 ? 1 : BRACKET_CEILINGS[b - 2] + 1
  const max = b === BRACKET_COUNT ? null : BRACKET_CEILINGS[b - 1]
  return { min, max }
}

/**
 * The first bracket that needs a premium subscription to ACQUIRE from.
 *
 * Brackets at and above this are visible to everyone -- in the feed, in the
 * grid, on the map, openable like any listing. What is gated is taking one in,
 * whether by proposing for it or by accepting an offer of it; see
 * enforcePremiumForListing() in @/lib/reputation-gate.
 */
export const PREMIUM_MIN_BRACKET: Bracket = 7

export function bracketNeedsPremium(bracket: Bracket): boolean {
  return bracket >= PREMIUM_MIN_BRACKET
}

/** `valueNeedsPremium(null)` is false: an unvalued listing has no bracket. */
export function valueNeedsPremium(valueLeaves: number | null): boolean {
  return valueLeaves !== null && bracketNeedsPremium(bracketOf(valueLeaves))
}
