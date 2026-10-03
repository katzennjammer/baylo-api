import type { Prisma } from "@/generated/prisma/client"
import type prisma from "@/lib/prisma"
import { visibleItemWhere } from "@/lib/blocking"

type Db = Prisma.TransactionClient | typeof prisma

/**
 * "Recommended for you" — the hybrid recommender (Option B, 30 Sep 2026).
 *
 * WHAT THE ADVISER ASKED FOR, AND WHAT THIS IS: "weighted personal trade
 * history + platform-wide popularity". Both halves are built from rows that
 * already exist -- trades, offers, likes, comments, listings. There is NO view
 * or search tracking in Baylo, so neither is a signal here; if that tracking
 * is ever built it arrives as another PERSONAL_WEIGHTS entry, and nothing
 * below changes shape.
 *
 * ── THE SCORE ───────────────────────────────────────────────────────────────
 *
 *   score = 0.6 × personal + 0.3 × popularity + 0.1 × recency     (history)
 *   score =                  0.9 × popularity + 0.1 × recency     (none)
 *
 * Each of the three terms is in [0, 1], so a score is too.
 *
 *   personal    How much the VIEWER has shown interest in this item's
 *               category, relative to their strongest category, times how
 *               much history they have (points / 24, capped at 1 -- see
 *               PERSONAL_CONFIDENCE_POINTS). Built by categoryAffinity().
 *   popularity  How much the PLATFORM has engaged with this item in the last
 *               14 days, relative to the most-engaged candidate (which is 1).
 *               Log-scaled, so one item with twenty offers does not flatten
 *               every other item to zero.
 *   recency     1 for a listing posted now, falling linearly to 0 at 14 days.
 *               Small on purpose: a tie-breaker between otherwise equal
 *               items, not a "newest first" feed in disguise.
 *
 * NO PERSONAL HISTORY -> POPULARITY ALONE. The personal weight is not dropped
 * and left as a hole (which would cap every cold-start score at 0.4); it is
 * handed to popularity, so the weights still sum to one.
 *
 * ── WHAT IS A CANDIDATE ─────────────────────────────────────────────────────
 *
 * AVAILABLE, visible to this viewer (blocks, suspensions, takedowns), not the
 * viewer's own, and NOT PERISHABLE: perishables have Home's Exclusive row, and
 * recommending the same tray twice on one screen would read as a bug.
 */

/** How much one event says about the viewer's taste in its category. */
export const PERSONAL_WEIGHTS = {
  /** A trade they completed: the item they RECEIVED is what they wanted. */
  completedTrade: 4,
  /** An offer they made on a listing, whatever became of it. */
  offerSent: 3,
  /** A listing they liked. */
  like: 2,
  /** Something they are listing themselves: weakest, it is supply, not demand. */
  ownListing: 1,
} as const

/** How much one engagement adds to an item's raw popularity. */
export const POPULARITY_WEIGHTS = { offer: 3, like: 1, comment: 1 } as const

export const SCORE_WEIGHTS = { personal: 0.6, popularity: 0.3, recency: 0.1 } as const

export const POPULARITY_WINDOW_DAYS = 14
export const RECENCY_WINDOW_DAYS = 14

/** Candidates scored per request, newest first. A ceiling, not a product rule. */
export const CANDIDATE_SCAN_CAP = 500
/** Per-kind ceiling on a viewer's signal rows, newest first. */
export const SIGNAL_SCAN_CAP = 200

const DAY_MS = 24 * 60 * 60 * 1000

export type SignalKind = keyof typeof PERSONAL_WEIGHTS
export interface Signal {
  kind: SignalKind
  category: string
}

export interface Candidate {
  id: string
  category: string
  createdAt: Date
}

export interface Engagement {
  offers: number
  likes: number
  comments: number
}

export type RecommendReason =
  | { code: "CATEGORY"; category: string }
  | { code: "POPULAR" }
  | { code: "NEW" }

export interface Scored {
  id: string
  score: number
  personal: number
  popularity: number
  recency: number
  reason: RecommendReason
}

/**
 * Signal points at which a history counts in full (30 Sep 2026). Six
 * completed trades, or eight offers, or two dozen own listings.
 *
 * WHY. Affinity is normalised to the viewer's strongest category, so without
 * this ONE offer made that category a perfect 1 -- and a viewer with two
 * offers in OTHER got a shelf that was 70% OTHER, outranking everything the
 * platform was actually engaging with. Scaling by how much history there is
 * lets a thin history nudge the shelf while popularity still leads it, and
 * leaves a real history (the 46- and 113-point viewers on live) at full weight.
 *
 * WHY 24 AND NOT 12. The top category's term is 0.6 x scale and the most
 * popular item's is at most 0.3, so a category match outranks EVERY popular
 * item until scale drops under about 0.5 (recency moves that by up to 1/6
 * either way). At 12, a 7-point history -- two offers and a listing -- sat
 * at 0.58, just above it, and the scaling changed nothing about the order.
 */
export const PERSONAL_CONFIDENCE_POINTS = 24

// ── The pure half: no database, so the verify script can pin it exactly. ──

/** How much of the personal weight a history has earned: points / 24, capped at 1. */
export function affinityConfidence(signals: readonly Signal[]): number {
  const points = signals.reduce((n, s) => n + PERSONAL_WEIGHTS[s.kind], 0)
  return Math.min(1, points / PERSONAL_CONFIDENCE_POINTS)
}

/**
 * Category -> affinity in [0, 1]: normalised so the strongest category is 1,
 * then scaled by affinityConfidence(), so the strongest category is 1 only for
 * a history of at least PERSONAL_CONFIDENCE_POINTS. Empty when there are no
 * signals, which is what "no personal history" means.
 */
export function categoryAffinity(signals: readonly Signal[]): Map<string, number> {
  const raw = new Map<string, number>()
  for (const s of signals) raw.set(s.category, (raw.get(s.category) ?? 0) + PERSONAL_WEIGHTS[s.kind])
  const max = Math.max(0, ...raw.values())
  const out = new Map<string, number>()
  if (max === 0) return out
  const confidence = affinityConfidence(signals)
  for (const [cat, v] of raw) out.set(cat, (v / max) * confidence)
  return out
}

export function rawPopularity(e: Engagement): number {
  return (
    e.offers * POPULARITY_WEIGHTS.offer +
    e.likes * POPULARITY_WEIGHTS.like +
    e.comments * POPULARITY_WEIGHTS.comment
  )
}

export function recencyOf(createdAt: Date, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - createdAt.getTime()) / DAY_MS)
  return Math.max(0, 1 - ageDays / RECENCY_WINDOW_DAYS)
}

/**
 * Every candidate scored, best first. Ties break on newer, then id, so the
 * order is total and the same inputs always give the same list.
 */
export function scoreCandidates(
  candidates: readonly Candidate[],
  affinity: ReadonlyMap<string, number>,
  engagement: ReadonlyMap<string, Engagement>,
  now: Date,
): Scored[] {
  const personalized = affinity.size > 0
  const raws = new Map(candidates.map((c) => [c.id, rawPopularity(engagement.get(c.id) ?? NO_ENGAGEMENT)]))
  const maxLog = Math.log1p(Math.max(0, ...raws.values()))

  const wPersonal = personalized ? SCORE_WEIGHTS.personal : 0
  const wPopularity = personalized ? SCORE_WEIGHTS.popularity : SCORE_WEIGHTS.popularity + SCORE_WEIGHTS.personal

  return candidates
    .map((c) => {
      const personal = affinity.get(c.category) ?? 0
      const popularity = maxLog === 0 ? 0 : Math.log1p(raws.get(c.id)!) / maxLog
      const recency = recencyOf(c.createdAt, now)
      const score = wPersonal * personal + wPopularity * popularity + SCORE_WEIGHTS.recency * recency
      return { c, scored: { id: c.id, score, personal, popularity, recency, reason: reasonFor(c, wPersonal * personal, wPopularity * popularity) } }
    })
    .sort(
      (a, b) =>
        b.scored.score - a.scored.score ||
        b.c.createdAt.getTime() - a.c.createdAt.getTime() ||
        (a.c.id < b.c.id ? -1 : 1),
    )
    .map((x) => x.scored)
}

/**
 * The line under a card. Whichever of the two weighted terms contributed more
 * names the reason; neither contributing means it is here on recency alone.
 * Honest about which half put it there -- "for your interest in Books" is never
 * shown for an item that only ranked on popularity.
 */
function reasonFor(c: Candidate, personalTerm: number, popularityTerm: number): RecommendReason {
  if (personalTerm > 0 && personalTerm >= popularityTerm) return { code: "CATEGORY", category: c.category }
  if (popularityTerm > 0) return { code: "POPULAR" }
  return { code: "NEW" }
}

const NO_ENGAGEMENT: Engagement = { offers: 0, likes: 0, comments: 0 }

// ── The loaders. READS ONLY: the verify script runs them in a read-only
// transaction against live data, and a write here would fail it loudly. ──

/** The viewer's taste signals, each kind capped at SIGNAL_SCAN_CAP newest. */
export async function loadSignals(db: Db, viewerId: string): Promise<Signal[]> {
  const [trades, offers, likes, own] = await Promise.all([
    db.tradeRequest.findMany({
      where: { status: "COMPLETED", OR: [{ senderId: viewerId }, { receiverId: viewerId }] },
      select: {
        senderId: true,
        offeredItem: { select: { category: true } },
        requestedItem: { select: { category: true } },
      },
      orderBy: { createdAt: "desc" },
      take: SIGNAL_SCAN_CAP,
    }),
    db.offer.findMany({
      where: { senderId: viewerId },
      select: { post: { select: { category: true } } },
      orderBy: { createdAt: "desc" },
      take: SIGNAL_SCAN_CAP,
    }),
    db.like.findMany({
      where: { userId: viewerId },
      select: { post: { select: { category: true } } },
      orderBy: { createdAt: "desc" },
      take: SIGNAL_SCAN_CAP,
    }),
    db.item.findMany({
      where: { userId: viewerId, status: "AVAILABLE" },
      select: { category: true },
      orderBy: { createdAt: "desc" },
      take: SIGNAL_SCAN_CAP,
    }),
  ])

  return [
    // The sender gave offeredItem and got requestedItem; the receiver the reverse.
    ...trades.map((t) => ({
      kind: "completedTrade" as const,
      category: t.senderId === viewerId ? t.requestedItem.category : t.offeredItem.category,
    })),
    ...offers.map((o) => ({ kind: "offerSent" as const, category: o.post.category })),
    ...likes.map((l) => ({ kind: "like" as const, category: l.post.category })),
    ...own.map((i) => ({ kind: "ownListing" as const, category: i.category })),
  ]
}

/** What this viewer may be recommended, newest first. */
export async function loadCandidates(db: Db, viewerId: string): Promise<Candidate[]> {
  return db.item.findMany({
    where: {
      status: "AVAILABLE",
      isPerishable: false,
      userId: { not: viewerId },
      ...visibleItemWhere(viewerId),
    },
    select: { id: true, category: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: CANDIDATE_SCAN_CAP,
  })
}

/** Offers, likes and comments per candidate over the popularity window. */
export async function loadEngagement(
  db: Db,
  itemIds: readonly string[],
  now: Date,
): Promise<Map<string, Engagement>> {
  const out = new Map<string, Engagement>()
  if (itemIds.length === 0) return out
  const since = new Date(now.getTime() - POPULARITY_WINDOW_DAYS * DAY_MS)
  const where = { postId: { in: [...itemIds] }, createdAt: { gte: since } }

  const [offers, likes, comments] = await Promise.all([
    db.offer.groupBy({ by: ["postId"], where, _count: { _all: true } }),
    db.like.groupBy({ by: ["postId"], where, _count: { _all: true } }),
    db.comment.groupBy({ by: ["postId"], where, _count: { _all: true } }),
  ])

  const bump = (id: string, key: keyof Engagement, n: number) => {
    const e = out.get(id) ?? { ...NO_ENGAGEMENT }
    e[key] += n
    out.set(id, e)
  }
  for (const r of offers) bump(r.postId, "offers", r._count._all)
  for (const r of likes) bump(r.postId, "likes", r._count._all)
  for (const r of comments) bump(r.postId, "comments", r._count._all)
  return out
}

/** The whole pipeline, for the route and the verify script alike. */
export async function recommendFor(db: Db, viewerId: string, now: Date = new Date()) {
  const [signals, candidates] = await Promise.all([loadSignals(db, viewerId), loadCandidates(db, viewerId)])
  const affinity = categoryAffinity(signals)
  const engagement = await loadEngagement(db, candidates.map((c) => c.id), now)
  return {
    personalized: affinity.size > 0,
    signals,
    affinity,
    candidates,
    engagement,
    scored: scoreCandidates(candidates, affinity, engagement, now),
  }
}
