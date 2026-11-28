/**
 * "Picked for you", ranked by weights LEARNED from Baylo's own activity (29 Nov 2026).
 *
 * Switched on with RECOMMENDER=learned; unset keeps the hand-set formula in
 * @/lib/recommend. Same candidates, same popularity and recency measures; only
 * the weighting is learned, and two signals are added.
 *
 * ── HOW THE WEIGHTS WERE FOUND ──────────────────────────────────────────────
 *
 * From the anonymised export (scripts/export-interactions.ts) of 268 likes,
 * comments, offers and completed trades by 15 people on 301 listings. Each
 * first engagement was replayed at the moment it happened: every listing
 * on Baylo then (not the person's own) is a candidate, the one engaged with
 * is the positive. A logistic model with every weight held at zero or above
 * (so each factor can only raise a listing, which keeps it explainable) was
 * fitted on the earlier 70% of moments and tested on the later 30%. Rapid
 * "like everything" test sessions (likes < 10 s apart) were left out.
 *
 *                       top-10 hit rate     leave-one-person-out
 *   hand-set formula        24%                  19%
 *   learned (this file)     76%                  75%
 *
 * What it learned: how NEW a listing is matters most; then whether the person
 * has dealt with that owner before; then popularity; interest in a category
 * matters little in this data, and being within a bracket of their own listing
 * did not help. Small data (69 moments without test sessions): re-run the
 * export and retrain as activity grows. The feed is newest-first, so people
 * saw new listings most; part of the recency weight is that exposure.
 */

import type { PrismaClient, Prisma } from "@/generated/prisma/client"
import { loadCandidates, loadEngagement, rawPopularity, recencyOf, type Candidate, type Engagement, type Scored } from "@/lib/recommend"

type Db = PrismaClient | Prisma.TransactionClient

/** Fitted weights (non-negative logistic, 29 Nov 2026). Zero weights are kept, to show they were tested. */
export const LEARNED_WEIGHTS = {
  affinityTrade: 0,
  affinityOffer: 0,
  affinityLike: 0.022,
  affinityComment: 0.058,
  affinityOwn: 0.034,
  popularity: 0.207,
  recency: 1.071,
  bracketReach: 0,
  knownOwner: 0.532,
} as const

export function learnedEnabled(): boolean {
  return process.env.RECOMMENDER === "learned"
}

const CAP = 200

export interface LearnedSignals {
  /** Share of the viewer's events of each kind that fall in each category. */
  likes: Map<string, number>
  comments: Map<string, number>
  offers: Map<string, number>
  trades: Map<string, number>
  own: Map<string, number>
  totalEvents: number
  ownCount: number
  /** Owners of listings the viewer has liked, commented on, offered on or traded with. */
  knownOwners: Set<string>
}

const tally = (cats: string[]) => {
  const m = new Map<string, number>()
  for (const c of cats) m.set(c, (m.get(c) ?? 0) + 1)
  return m
}

/** The viewer's history, as the training replay measured it. READ ONLY. */
export async function loadLearnedSignals(db: Db, viewerId: string): Promise<LearnedSignals> {
  const item = { select: { category: true, userId: true } } as const
  const [likes, comments, offers, trades, own] = await Promise.all([
    db.like.findMany({ where: { userId: viewerId }, select: { post: item }, orderBy: { createdAt: "desc" }, take: CAP }),
    db.comment.findMany({ where: { userId: viewerId }, select: { post: item }, orderBy: { createdAt: "desc" }, take: CAP }),
    db.trade.findMany({ where: { senderId: viewerId, offerStatus: { not: null } }, select: { requestedItem: item }, orderBy: { createdAt: "desc" }, take: CAP }),
    db.trade.findMany({
      where: { status: "COMPLETED", OR: [{ senderId: viewerId }, { receiverId: viewerId }] },
      select: { senderId: true, offeredItem: item, requestedItem: item },
      take: CAP,
    }),
    db.item.findMany({ where: { userId: viewerId }, select: { category: true }, take: CAP }),
  ])
  const received = trades.map((t) => (t.senderId === viewerId ? t.requestedItem : t.offeredItem)).filter((x): x is { category: string; userId: string } => !!x)
  const all = [...likes.map((l) => l.post), ...comments.map((c) => c.post), ...offers.map((o) => o.requestedItem), ...received]
  return {
    likes: tally(likes.map((l) => l.post.category)),
    comments: tally(comments.map((c) => c.post.category)),
    offers: tally(offers.map((o) => o.requestedItem.category)),
    trades: tally(received.map((r) => r.category)),
    own: tally(own.map((o) => o.category)),
    totalEvents: all.length,
    ownCount: own.length,
    knownOwners: new Set(all.map((x) => x.userId).filter((id) => id !== viewerId)),
  }
}

/** Every candidate scored with LEARNED_WEIGHTS, best first; same tie-break as scoreCandidates(). */
export function scoreLearned(
  candidates: readonly Candidate[],
  s: LearnedSignals,
  engagement: ReadonlyMap<string, Engagement>,
  now: Date,
): Scored[] {
  const W = LEARNED_WEIGHTS
  const raws = new Map(candidates.map((c) => [c.id, rawPopularity(engagement.get(c.id) ?? { offers: 0, likes: 0, comments: 0 })]))
  const maxLog = Math.log1p(Math.max(0, ...raws.values()))
  const tot = Math.max(1, s.totalEvents)
  const share = (m: Map<string, number>, cat: string, n: number) => (m.get(cat) ?? 0) / Math.max(1, n)

  return candidates
    .map((c) => {
      const personal =
        W.affinityTrade * share(s.trades, c.category, tot) +
        W.affinityOffer * share(s.offers, c.category, tot) +
        W.affinityLike * share(s.likes, c.category, tot) +
        W.affinityComment * share(s.comments, c.category, tot) +
        W.affinityOwn * share(s.own, c.category, s.ownCount)
      const known = c.ownerId && s.knownOwners.has(c.ownerId) ? W.knownOwner : 0
      const popularity = maxLog === 0 ? 0 : Math.log1p(raws.get(c.id)!) / maxLog
      const recency = recencyOf(c.createdAt, now)
      const pop = W.popularity * popularity
      const score = personal + known + pop + W.recency * recency
      // The line under the card names the strongest NON-recency reason that
      // actually contributed; recency alone reads "New on Baylo", as before.
      const reason: Scored["reason"] =
        known > 0 && known >= pop && known >= personal
          ? { code: "KNOWN" }
          : personal > 0 && personal >= pop
            ? { code: "CATEGORY", category: c.category }
            : pop > 0
              ? { code: "POPULAR" }
              : { code: "NEW" }
      return { c, scored: { id: c.id, score, personal: personal + known, popularity, recency, reason } }
    })
    .sort(
      (a, b) =>
        b.scored.score - a.scored.score ||
        b.c.createdAt.getTime() - a.c.createdAt.getTime() ||
        (a.c.id < b.c.id ? -1 : 1),
    )
    .map((x) => x.scored)
}

/** The learned pipeline, for the route when RECOMMENDER=learned. */
export async function recommendLearnedFor(db: Db, viewerId: string, now: Date = new Date()) {
  const [signals, candidates] = await Promise.all([loadLearnedSignals(db, viewerId), loadCandidates(db, viewerId)])
  const engagement = await loadEngagement(db, candidates.map((c) => c.id), now)
  return { personalized: signals.totalEvents + signals.ownCount > 0, scored: scoreLearned(candidates, signals, engagement, now) }
}
