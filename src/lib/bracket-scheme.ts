/**
 * The ACTIVE bracket table, loaded from the BracketScheme table, and the
 * system recalculation (28 Nov 2026). Server-only: it talks to the database.
 *
 * ── KEEPING THE IN-MEMORY TABLE FRESH ───────────────────────────────────────
 *
 * @/lib/brackets keeps the active ceilings in memory so bracketOf() stays
 * synchronous. This module refreshes them:
 *   - ensureBracketScheme(): awaited by resolveSession() (every signed-in
 *     request) and by the public pages; reads the table at most once per
 *     REFRESH_MS per server instance, and shares one read between concurrent
 *     callers.
 *   - a background refresh, kicked by any bracketOf() call once stale, for the
 *     few unauthenticated paths that do not await.
 * A failed read keeps the last good table (or the hand-set default) and never
 * fails the request.
 *
 * ── RECALCULATING ───────────────────────────────────────────────────────────
 *
 * recalculateBrackets() runs monthly from /api/cron/brackets (and from
 * scripts/recalculate-brackets.ts). It proposes a geometric table from the
 * live listing values (@/lib/bracket-math) and records it as PROPOSED. It is
 * applied only when `apply` is true, which the cron passes only when the env
 * var BRACKET_AUTO_APPLY=1 is set: older app builds carry the hand-set table,
 * so new limits should go live together with an app build that reads
 * GET /api/v1/brackets.
 *
 * Which listings count: AVAILABLE, IN_TRADE, TRADED or OWNED (accepted
 * values), not hidden by a moderator, not perishable (their values are clamped
 * by a different rule). Real listings only, once there are MIN_REAL_SAMPLE
 * (200) of them; until then demo listings are included too, and
 * `stats.sample` says which. Fewer than MIN_SAMPLE (100) values in all: no
 * recalculation, the active table stays.
 */

import prisma from "@/lib/prisma"
import { bracketCeilings, onBracketRead, setBracketCeilings, validCeilings } from "@/lib/brackets"
import { MIN_REAL_SAMPLE, MIN_SAMPLE, proposeGeometricScheme, sameCeilings, type SchemeProposal } from "@/lib/bracket-math"

const REFRESH_MS = 60_000
const DEMO_PREFIXES = ["demo-", "def-", "defb-", "seed-"]

export interface ActiveScheme {
  id: string
  ceilings: number[]
  method: string
  sampleSize: number
  stats: unknown
  activatedAt: Date | null
}

let loadedAt = 0
let current: ActiveScheme | null = null
let inFlight: Promise<void> | null = null

async function load(): Promise<void> {
  try {
    const row = await prisma.bracketScheme.findFirst({
      where: { status: "ACTIVE" },
      select: { id: true, ceilings: true, method: true, sampleSize: true, stats: true, activatedAt: true },
    })
    if (row && validCeilings(row.ceilings) && setBracketCeilings(row.ceilings)) current = row
    loadedAt = Date.now()
  } catch (err) {
    // Keep the last good table. Try again on the next call after a short pause,
    // not on every bracketOf() call.
    loadedAt = Date.now() - REFRESH_MS + 5_000
    console.error("[brackets] could not load the active scheme; keeping the last table", err)
  }
}

function refresh(): Promise<void> {
  if (!inFlight) inFlight = load().finally(() => { inFlight = null })
  return inFlight
}

/** Makes sure the in-memory table is at most REFRESH_MS old. Never throws. */
export async function ensureBracketScheme(): Promise<void> {
  if (Date.now() - loadedAt < REFRESH_MS) return
  await refresh()
}

/** The active scheme as last loaded (null before the first load or if the table is unreadable). */
export async function activeBracketScheme(): Promise<ActiveScheme | null> {
  await ensureBracketScheme()
  return current
}

// Background refresh for callers that never awaited ensureBracketScheme().
onBracketRead(() => {
  if (Date.now() - loadedAt >= REFRESH_MS && !inFlight) void refresh()
})

/** Values the scheme is calculated from (see the header for which listings count). */
export async function listingValuesForBrackets(): Promise<{ values: number[]; sample: "real" | "real+demo"; real: number; demo: number }> {
  const rows = await prisma.item.findMany({
    where: {
      status: { in: ["AVAILABLE", "IN_TRADE", "TRADED", "OWNED"] as never },
      moderationHiddenAt: null,
      isPerishable: false,
      valueLeaves: { gt: 0 },
    },
    select: { id: true, valueLeaves: true },
  })
  const real: number[] = []
  const demo: number[] = []
  for (const r of rows) (DEMO_PREFIXES.some((p) => r.id.startsWith(p)) ? demo : real).push(r.valueLeaves as number)
  return real.length >= MIN_REAL_SAMPLE
    ? { values: real, sample: "real", real: real.length, demo: demo.length }
    : { values: [...real, ...demo], sample: "real+demo", real: real.length, demo: demo.length }
}

export type RecalcResult =
  | { outcome: "notEnoughData"; sampleSize: number; minSample: number }
  | { outcome: "unchanged"; active: number[]; proposal: SchemeProposal }
  | { outcome: "proposed" | "applied"; id: string; previous: number[]; proposal: SchemeProposal; itemsRebracketed?: number }

/**
 * Calculates a new table from live data. `dryRun` writes nothing. Otherwise a
 * changed table is recorded as PROPOSED, and also activated when `apply`.
 */
export async function recalculateBrackets(opts: { apply: boolean; dryRun?: boolean }): Promise<RecalcResult> {
  const { values, sample, real, demo } = await listingValuesForBrackets()
  const proposal = proposeGeometricScheme(values)
  if (!proposal) return { outcome: "notEnoughData", sampleSize: values.length, minSample: MIN_SAMPLE }
  const stats = { ...proposal.stats, sample, realListings: real, demoListings: demo }
  const full: SchemeProposal = { ...proposal, stats }

  await ensureBracketScheme()
  const previous = [...bracketCeilings()]
  if (sameCeilings(previous, proposal.ceilings)) return { outcome: "unchanged", active: previous, proposal: full }
  if (opts.dryRun) return { outcome: "proposed", id: "(dry run)", previous, proposal: full }

  const row = await prisma.bracketScheme.create({
    data: { ceilings: proposal.ceilings, method: proposal.method, status: "PROPOSED", sampleSize: proposal.sampleSize, stats },
    select: { id: true },
  })
  if (!opts.apply) return { outcome: "proposed", id: row.id, previous, proposal: full }
  const { itemsRebracketed } = await activateBracketScheme(row.id)
  return { outcome: "applied", id: row.id, previous, proposal: full, itemsRebracketed }
}

/**
 * Makes a PROPOSED (or RETIRED) scheme the ACTIVE one: retires the current
 * row, activates this one and re-brackets every listing, all in one
 * transaction, so no reader ever sees two active tables or a listing
 * bracketed by the old one.
 */
export async function activateBracketScheme(id: string): Promise<{ itemsRebracketed: number }> {
  const itemsRebracketed = await prisma.$transaction(async (tx) => {
    const target = await tx.bracketScheme.findUnique({ where: { id }, select: { status: true, ceilings: true } })
    if (!target) throw new Error(`No bracket scheme ${id}`)
    if (!validCeilings(target.ceilings)) throw new Error(`Bracket scheme ${id} has an invalid table`)
    if (target.status === "ACTIVE") return 0
    const now = new Date()
    await tx.bracketScheme.updateMany({ where: { status: "ACTIVE" }, data: { status: "RETIRED", retiredAt: now } })
    await tx.bracketScheme.update({ where: { id }, data: { status: "ACTIVE", activatedAt: now, retiredAt: null } })
    // The trigger recomputes "bracket" from the (now) active row on any
    // update that names the column.
    return tx.$executeRaw`UPDATE "Item" SET "bracket" = NULL WHERE "valueLeaves" IS NOT NULL`
  })
  loadedAt = 0
  await ensureBracketScheme()
  return { itemsRebracketed }
}
