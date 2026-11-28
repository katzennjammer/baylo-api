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
 * ── THE LIMITS ARE DATA, NOT CODE (since 28 Nov 2026) ───────────────────────
 *
 * The panel asked for brackets that are justified and system-based, so the
 * nine ceilings are no longer hand-set here. They live in the BracketScheme
 * table: the system recalculates them from Baylo's own listing values
 * (geometric steps between the 2nd and 98th percentile, see
 * @/lib/bracket-math), and one row is ACTIVE at a time.
 *
 * This module holds the ACTIVE ceilings in memory so every caller stays
 * synchronous. @/lib/bracket-scheme loads them from the database and
 * re-checks at most once a minute; resolveSession() awaits that check, so a
 * signed-in request always sees a fresh table. DEFAULT_BRACKET_CEILINGS is the
 * old hand-set table: the first ACTIVE row, and the fallback if the database
 * cannot be read.
 *
 * The NUMBER of brackets never changes (10), so PREMIUM_MIN_BRACKET, the fee
 * and the reward ladder keep their meaning. Only where each bracket starts and
 * ends moves.
 *
 * ── A COLUMN KEPT IN STEP BY THE DATABASE ───────────────────────────────────
 *
 * `Item.bracket` is set by a Postgres trigger from the same ACTIVE row
 * (baylo_bracket_of() in 20261128000000_bracket_scheme), and activating a new
 * scheme re-brackets every listing in the same transaction. Nothing in the app
 * writes it. The table is in Leaves, never in pesos: `valueLeaves` is unpegged
 * and stays that way. Do not add a currency column.
 *
 * ── MIRRORED ON THE MOBILE CLIENT ───────────────────────────────────────────
 *
 * `baylo-mobile/src/lib/brackets.ts` fetches the active ceilings from
 * GET /api/v1/brackets and keeps the same defaults, so a tile can be bracketed
 * without a round trip. The server's table is the one enforced.
 */

/** The hand-set table used until 28 Nov 2026: the first scheme, and the fallback. */
export const DEFAULT_BRACKET_CEILINGS: readonly number[] = Object.freeze([
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
])

/** Always 10 brackets: nine ceilings, and the last bracket is open-ended. */
export const BRACKET_COUNT = DEFAULT_BRACKET_CEILINGS.length + 1

let active: readonly number[] = DEFAULT_BRACKET_CEILINGS
let onRead: (() => void) | null = null

/** True when `c` is a usable table: BRACKET_COUNT - 1 strictly increasing positive integers. */
export function validCeilings(c: unknown): c is number[] {
  return (
    Array.isArray(c) &&
    c.length === BRACKET_COUNT - 1 &&
    c.every((x, i) => Number.isInteger(x) && x > 0 && (i === 0 || x > (c[i - 1] as number)))
  )
}

/** Upper bound of each bracket, inclusive, in Leaves: the ACTIVE scheme. */
export function bracketCeilings(): readonly number[] {
  onRead?.()
  return active
}

/** Installs a new active table. Refuses (returns false) anything validCeilings() rejects. */
export function setBracketCeilings(c: readonly number[]): boolean {
  if (!validCeilings([...c])) return false
  active = Object.freeze([...c])
  return true
}

/** Lets @/lib/bracket-scheme refresh the table in the background when it is stale. */
export function onBracketRead(fn: (() => void) | null): void {
  onRead = fn
}

/** A bracket number, 1..BRACKET_COUNT. */
export type Bracket = number

/**
 * `bracketOf(425)` → 3. Values at or below zero land in bracket 1: a listing
 * cannot be worth a negative amount, and a defensive floor is cheaper than a
 * bracket 0 that no copy knows how to name.
 */
export function bracketOf(valueLeaves: number): Bracket {
  const i = bracketCeilings().findIndex((ceiling) => valueLeaves <= ceiling)
  return i === -1 ? BRACKET_COUNT : i + 1
}

/** Inclusive Leaves range of a bracket; `max` is null for the open top. */
export function bracketRange(bracket: Bracket): { min: number; max: number | null } {
  const b = Math.min(Math.max(1, Math.trunc(bracket)), BRACKET_COUNT)
  const c = bracketCeilings()
  const min = b === 1 ? 1 : c[b - 2] + 1
  const max = b === BRACKET_COUNT ? null : c[b - 1]
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

// No VIP-only bracket since 22 Oct 2026. Brackets 9 and 10 used to need VIP,
// a tier nobody could buy, which left them untradeable for everyone. Premium
// now unlocks every bracket from PREMIUM_MIN_BRACKET up; VIP stays a superset
// of Premium (isVip() in @/lib/premium) but gates nothing of its own.
