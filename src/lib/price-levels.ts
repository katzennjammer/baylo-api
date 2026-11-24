import type { Category } from "@/lib/valuation"

/**
 * Price levels: how an online asking price in pesos becomes a Leaves value
 * WITHOUT a peso-to-Leaves exchange rate.
 *
 * ── HOW IT WORKS ────────────────────────────────────────────────────────────
 *
 * Claude finds current online listings for the item and reads their peso
 * asking prices. That is all it does. The server takes the median of those
 * prices and looks it up here:
 *
 *   1. Which LEVEL is that price for this category?  Four levels, split by
 *      three peso cut-offs per category (PRICE_CUTOFFS_PHP below).
 *   2. Where does that level sit in Baylo's Leaves range for the category and
 *      condition? Always the same point (LEVEL_POSITIONS below).
 *
 * So the same price, for the same category and condition, always gives the
 * same Leaves value, and anyone can check it by hand from this file. The
 * Leaves range itself still comes from @/lib/valuation, unchanged.
 *
 * Pesos are only ever compared with pesos (to pick a level). They are never
 * multiplied into Leaves.
 *
 * ── THE CUT-OFFS ARE A FIRST DRAFT ──────────────────────────────────────────
 *
 * The numbers below are a starting point drafted in Nov 2026 from typical
 * secondhand asking prices in the Philippines. They are a Baylo rule, not a
 * measurement, and should be reviewed by the team. Changing one is a one-line,
 * reviewable edit; scripts/verify-ai-valuation.ts checks they stay ordered.
 */

export const PRICE_LEVEL_NAMES = ["Low", "Typical", "High", "Premium"] as const
export type PriceLevelName = (typeof PRICE_LEVEL_NAMES)[number]

/**
 * Where each level sits in the Leaves range, as a fraction of the way from
 * its min to its max. Spread so no level sits on either end: the very top and
 * bottom of the range are left for the owner's own adjustment.
 */
export const LEVEL_POSITIONS: readonly [number, number, number, number] = [0.15, 0.4, 0.7, 0.9]

/**
 * Three peso cut-offs per category: [Low→Typical, Typical→High, High→Premium].
 * A price exactly on a cut-off belongs to the level above it.
 */
export const PRICE_CUTOFFS_PHP: Record<Category, readonly [number, number, number]> = {
  ELECTRONICS: [2_000, 8_000, 25_000],
  CLOTHING: [200, 600, 2_000],
  BAGS: [500, 2_000, 8_000],
  BEAUTY: [200, 800, 2_500],
  ACCESSORIES: [300, 1_500, 6_000],
  FURNITURE: [1_500, 5_000, 15_000],
  BOOKS: [100, 300, 800],
  GAMING: [1_500, 6_000, 20_000],
  SPORTS: [500, 2_500, 8_000],
  BIKES: [3_000, 10_000, 30_000],
  TOYS: [200, 800, 3_000],
  TOOLS: [500, 2_000, 6_000],
  MUSIC: [1_500, 6_000, 20_000],
  ART: [300, 1_500, 6_000],
  COLLECTIBLES: [300, 1_500, 8_000],
  PETS: [200, 800, 3_000],
  PLANTS: [100, 400, 1_500],
  FOOD: [100, 300, 800],
  OTHER: [300, 1_500, 6_000],
}

const FALLBACK_CUTOFFS = PRICE_CUTOFFS_PHP.OTHER

export function cutoffsFor(category: string): readonly [number, number, number] {
  return PRICE_CUTOFFS_PHP[category as Category] ?? FALLBACK_CUTOFFS
}

/** 0 Low, 1 Typical, 2 High, 3 Premium. */
export function levelOf(category: string, pricePhp: number): 0 | 1 | 2 | 3 {
  const [a, b, c] = cutoffsFor(category)
  if (pricePhp < a) return 0
  if (pricePhp < b) return 1
  if (pricePhp < c) return 2
  return 3
}

/** The Leaves value of a level inside a range. Whole Leaves, at least 1, never outside the range. */
export function leavesForLevel(level: 0 | 1 | 2 | 3, range: { min: number; max: number }): number {
  const raw = Math.floor(range.min + LEVEL_POSITIONS[level] * (range.max - range.min) + 0.5)
  return Math.max(1, Math.min(range.max, Math.max(range.min, raw)))
}

/** The median of the prices, rounded to a whole peso. Null for none. */
export function medianPhp(prices: readonly number[]): number | null {
  if (prices.length === 0) return null
  const s = [...prices].sort((x, y) => x - y)
  const mid = Math.floor(s.length / 2)
  const m = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
  return Math.floor(m + 0.5)
}

/** Everything a client needs to draw the level track for one category and range. */
export function levelTable(category: string, range: { min: number; max: number }) {
  return {
    cutoffsPhp: [...cutoffsFor(category)] as [number, number, number],
    levels: PRICE_LEVEL_NAMES.map((name, i) => ({
      name,
      leaves: leavesForLevel(i as 0 | 1 | 2 | 3, range),
    })),
  }
}
