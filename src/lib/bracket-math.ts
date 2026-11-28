/**
 * How Baylo works out its bracket limits from its own listing values (28 Nov 2026).
 *
 * Pure: no database, so the cron route, the script and the tests all share it.
 *
 * ── THE METHOD: GEOMETRIC STEPS BETWEEN THE 2ND AND 98TH PERCENTILE ─────────
 *
 * 1. Take the accepted values of the visible, non-perishable listings.
 * 2. Low anchor = the 2nd percentile, high anchor = the 98th. Cutting the
 *    outer 2% on each side means one oddly cheap or oddly expensive listing
 *    cannot drag the whole table.
 * 3. Split the range between the anchors into 10 EQUAL STEPS ON A LOG SCALE.
 *    The 9 points between the anchors are the 9 ceilings, so each bracket
 *    covers values about the same MULTIPLE of the one below (about 2x on
 *    today's data). People judge value in ratios, not in absolute pesos (a
 *    ₱100 gap matters on a ₱150 item and not on a ₱9,000 one, which is Weber's
 *    law), so "one bracket apart" means the same thing at every price level.
 * 4. Round each ceiling to a clean number (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6,
 *    7.5, 8 × a power of ten), so a person can remember the table.
 *
 * ── SAFEGUARD: STEPS NEVER GET SMALL ────────────────────────────────────────
 *
 * If the listing values sit in a narrow range, ten equal steps between the
 * anchors would make each bracket only a little wider than the last (₱100,
 * 110, 120…), and near-equal items would pay bridging fees. So each step is at
 * least MIN_STEP_RATIO (1.5×): a narrower range is widened around its middle
 * (on the log scale) until it is. An empty top or bottom bracket is fine (few
 * listings are very cheap or very valuable) and is reported in the stats.
 *
 * Why not equal-frequency (deciles)? It gives every bracket the same number
 * of listings, but on today's data the cheap brackets become ₱120 / 150 / 200
 * / 250 wide, so near-equal items pay a bridging fee over a ₱20 gap, and the
 * limits move with every batch of new listings.
 */

import { BRACKET_COUNT, validCeilings } from "@/lib/brackets"

/** Below this many values the scheme is not recalculated; the active one stays. */
export const MIN_SAMPLE = 100

/**
 * Real listings alone are used once there are this many (about 20 per
 * bracket); until then demo listings are counted too (@/lib/bracket-scheme).
 */
export const MIN_REAL_SAMPLE = 200

/** The anchors: the 2nd and 98th percentile of the listing values. */
export const LOW_QUANTILE = 0.02
export const HIGH_QUANTILE = 0.98

/** Each bracket covers at least this multiple of the one below (see SAFEGUARD). */
export const MIN_STEP_RATIO = 1.5

const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8, 10]

/** Rounds UP to the next clean number: nice(137) → 150, nice(2140) → 2500. */
export function nice(x: number): number {
  if (!(x > 0)) return 1
  const e = 10 ** Math.floor(Math.log10(x))
  const m = x / e
  for (const k of NICE_STEPS) {
    if (m <= k * 1.0001) return Math.round(k * e)
  }
  return Math.round(10 * e)
}

/** Percentile with linear interpolation (the same as numpy's default). `sorted` must be ascending. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/** Listings per bracket under `ceilings` (bracket i holds values ≤ ceilings[i-1]). */
export function bracketCounts(values: readonly number[], ceilings: readonly number[]): number[] {
  const counts = new Array<number>(ceilings.length + 1).fill(0)
  for (const v of values) {
    const i = ceilings.findIndex((c) => v <= c)
    counts[i === -1 ? ceilings.length : i]++
  }
  return counts
}

/** Gini coefficient of the counts: 0 = every bracket equally full, 1 = all in one. */
export function gini(counts: readonly number[]): number {
  const total = counts.reduce((a, b) => a + b, 0)
  if (total === 0) return 0
  const c = [...counts].sort((a, b) => a - b).map((x) => x / total)
  const n = c.length
  let s = 0
  for (let i = 0; i < n; i++) s += (n - (i + 1) + 0.5) * c[i]
  return Math.round((1 - (2 * s) / n) * 1000) / 1000
}

/** Ceilings from one anchor pair, rounded and forced strictly increasing. */
export function geometricCeilings(sorted: readonly number[], lowQ: number, highQ: number): number[] {
  const steps = BRACKET_COUNT // 10 equal log steps → 9 interior points
  let lo = Math.max(1, quantile(sorted, lowQ))
  let hi = Math.max(lo, quantile(sorted, highQ))
  const minSpan = steps * Math.log10(MIN_STEP_RATIO)
  const span = Math.log10(hi) - Math.log10(lo)
  if (span < minSpan) {
    // Widen around the middle, but never below 1 Leaf.
    const mid = (Math.log10(hi) + Math.log10(lo)) / 2
    lo = Math.max(1, 10 ** (mid - minSpan / 2))
    hi = 10 ** (Math.log10(lo) + minSpan)
  }
  const out: number[] = []
  for (let i = 1; i < steps; i++) {
    const raw = 10 ** (Math.log10(lo) + ((Math.log10(hi) - Math.log10(lo)) * i) / steps)
    let c = nice(raw)
    // Rounding can make two neighbours equal on a narrow range; push up to the
    // next clean number so the table stays strictly increasing.
    while (out.length && c <= out[out.length - 1]) c = nice(c * 1.0002 + 1)
    out.push(c)
  }
  return out
}

export interface SchemeProposal {
  ceilings: number[]
  method: "geometric"
  sampleSize: number
  stats: {
    lowQuantile: number
    highQuantile: number
    lowAnchor: number
    highAnchor: number
    /** Average size of one step, as a multiple ("each bracket ≈ 1.9× the one below"). */
    stepRatio: number
    listingsPerBracket: number[]
    emptyBrackets: number
    gini: number
    median: number
  }
}

/** The geometric scheme for these values, or null when there are fewer than MIN_SAMPLE. */
export function proposeGeometricScheme(values: readonly number[]): SchemeProposal | null {
  const v = values.filter((x) => Number.isFinite(x) && x > 0)
  if (v.length < MIN_SAMPLE) return null
  const sorted = [...v].sort((a, b) => a - b)

  const ceilings = geometricCeilings(sorted, LOW_QUANTILE, HIGH_QUANTILE)
  if (!validCeilings(ceilings)) return null
  const counts = bracketCounts(sorted, ceilings)
  const lowAnchor = Math.round(quantile(sorted, LOW_QUANTILE))
  const highAnchor = Math.round(quantile(sorted, HIGH_QUANTILE))
  const c = ceilings
  return {
    ceilings: c,
    method: "geometric",
    sampleSize: sorted.length,
    stats: {
      lowQuantile: LOW_QUANTILE,
      highQuantile: HIGH_QUANTILE,
      lowAnchor,
      highAnchor,
      stepRatio: Math.round((c[c.length - 1] / c[0]) ** (1 / (c.length - 1)) * 100) / 100,
      listingsPerBracket: counts,
      emptyBrackets: counts.filter((n) => n === 0).length,
      gini: gini(counts),
      median: Math.round(quantile(sorted, 0.5)),
    },
  }
}

export function sameCeilings(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}
