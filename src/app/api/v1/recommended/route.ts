import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { preciseAccessItemIds } from "@/lib/item-visibility"
import { visibleItemWhere } from "@/lib/blocking"
import { ok, unauthenticated } from "@/lib/v1/envelope"
import { parseQuery } from "@/lib/v1/query"
import { V1_ITEM_SELECT, V1_ITEM_OWNER_SELECT, v1ItemStatsSelect, v1Item, type V1ItemRow } from "@/lib/v1/item"
import { categoryLabel } from "@/lib/v1/taxonomy"
import { SCORE_WEIGHTS, recommendFor, type RecommendReason } from "@/lib/recommend"

export const dynamic = "force-dynamic"

/**
 * GET /api/v1/recommended — Home's "Recommended for you".
 *
 * The scoring is @/lib/recommend, and its header is the explanation: personal
 * category affinity from trades, offers, likes and own listings, plus 14-day
 * popularity from offers, likes and comments, plus a small recency term; no
 * personal history means popularity alone. This route only loads, trims to
 * `limit`, and dresses the winners as v1 items.
 *
 * Two reads of Item, like /featured: the scorer sees ids, categories and dates
 * for up to CANDIDATE_SCAN_CAP listings; the full rows are fetched for the
 * chosen few. `where` is re-applied on the second read so a listing that went
 * unavailable in between drops out rather than being served.
 *
 * Each item carries `recommendation`: its score, the three terms, and a reason
 * with a human label, so the client never has to guess why something is here
 * -- and never claims "for your interest in Books" for an item that ranked only
 * on popularity. `meta.personalized` says which formula ran.
 *
 * Not paginated. It is a shelf, and past the first dozen the scores are mostly
 * recency, which is Marketplace's job.
 */

const querySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(30).optional().default(10),
})

/**
 * "interest", not "trade": the personal signal is trades AND offers, likes and
 * own listings, so "because you trade Books" would overclaim for someone who
 * only liked one. OTHER is not a category anyone recognises as a taste, so it
 * gets the generic line rather than "your interest in Other".
 */
function reasonLabel(r: RecommendReason): string {
  switch (r.code) {
    case "CATEGORY":
      return r.category === "OTHER" ? "For your recent activity" : `For your interest in ${categoryLabel(r.category)}`
    case "POPULAR":
      return "Popular right now"
    case "NEW":
      return "New on Baylo"
  }
}

export async function GET(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const viewerId = session.user.id

  const parsed = parseQuery(req, querySchema)
  if (!parsed.ok) return parsed.response
  const { limit } = parsed.data

  const run = await recommendFor(prisma, viewerId)
  const top = run.scored.slice(0, limit)

  const rows = top.length
    ? await prisma.item.findMany({
        where: {
          id: { in: top.map((t) => t.id) },
          status: "AVAILABLE",
          isPerishable: false,
          ...visibleItemWhere(viewerId),
        },
        select: {
          ...V1_ITEM_SELECT,
          user: { select: V1_ITEM_OWNER_SELECT },
          ...v1ItemStatsSelect(viewerId),
        },
      })
    : []
  const byId = new Map((rows as V1ItemRow[]).map((r) => [r.id, r]))
  const page = top.filter((t) => byId.has(t.id))
  const access = await preciseAccessItemIds(viewerId, page.map((t) => t.id))

  const round = (n: number) => Math.round(n * 1000) / 1000

  return ok(
    {
      items: page.map((t) => ({
        ...v1Item(byId.get(t.id)!, viewerId, access),
        recommendation: {
          score: round(t.score),
          personal: round(t.personal),
          popularity: round(t.popularity),
          recency: round(t.recency),
          reason: t.reason.code,
          reasonLabel: reasonLabel(t.reason),
        },
      })),
    },
    {
      personalized: run.personalized,
      weights: run.personalized
        ? SCORE_WEIGHTS
        : { personal: 0, popularity: SCORE_WEIGHTS.personal + SCORE_WEIGHTS.popularity, recency: SCORE_WEIGHTS.recency },
      candidates: run.candidates.length,
    },
  )
}
