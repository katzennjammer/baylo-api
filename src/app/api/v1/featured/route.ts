import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { preciseAccessItemIds } from "@/lib/item-visibility"
import { visibleItemWhere } from "@/lib/blocking"
import { CATEGORY_VALUES } from "@/lib/validation"
import { ok, unauthenticated } from "@/lib/v1/envelope"
import { parseQuery } from "@/lib/v1/query"
import { V1_ITEM_SELECT, V1_ITEM_OWNER_SELECT, v1ItemStatsSelect, v1Item, type V1ItemRow } from "@/lib/v1/item"
import { categoryLabel } from "@/lib/v1/taxonomy"
import {
  FEATURED_SCAN_CAP,
  FEATURED_VISIBLE_CAP,
  activeFeaturedWhere,
  expireFeaturedItems,
  featuredRotation,
  rotationHour,
} from "@/lib/featured"

export const dynamic = "force-dynamic"

/**
 * GET /api/v1/featured?category=BOOKS — Home's Featured section for one
 * category. THREE queries: every eligible id (1), the eight chosen rows (2),
 * and their pickup access (3).
 *
 * ── THE ROTATION, AND WHY IT IS TWO READS ───────────────────────────────────
 *
 * Which eight is featuredRotation() in @/lib/featured: all eligible boosts,
 * shuffled by a hash of (UTC hour, category, id), first eight shown. The same
 * hour gives the same eight on every request; the next hour gives a new draw.
 *
 * Query 1 reads ids ONLY, for every eligible boost; the ordering happens in
 * JS; query 2 fetches the full rows for the chosen eight. Doing the hash in
 * SQL would need raw SQL on Item, and raw SQL on this table has already
 * written to the wrong schema once (see itemTable() in @/lib/perishable).
 * Plain Prisma keeps every read in the schema its connection names.
 *
 * Every filter -- active window, AVAILABLE, not perishable, blocks,
 * suspensions, takedowns -- is in query 1's WHERE, so a listing this viewer
 * cannot see never wins a slot and leaves the section short. It also means two
 * viewers with different block lists can see different eights: the order is
 * deterministic for a given VISIBLE set, the only set that matters to a viewer.
 *
 * Not paginated: the section is the eight, and a "more" page would be the
 * pay-to-dominate feed the cap exists to prevent. `total` is how many boosts
 * are live and visible in the category; `rotationHour` names the draw.
 */

const querySchema = z.strictObject({
  category: z.enum(CATEGORY_VALUES),
})

export async function GET(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const viewerId = session.user.id

  const parsed = parseQuery(req, querySchema)
  if (!parsed.ok) return parsed.response
  const { category } = parsed.data

  // Hygiene, not correctness: activeFeaturedWhere() already requires the
  // window to be open, so this only keeps the flag honest for other readers.
  const now = new Date()
  await expireFeaturedItems(prisma, {}, now)

  const where = { ...activeFeaturedWhere(now), category, ...visibleItemWhere(viewerId) }

  // ── 1 ── every eligible id. The featuredAt/id order matters only past the
  // scan cap, where it decides deterministically which boosts are considered.
  const candidates = await prisma.item.findMany({
    where,
    select: { id: true },
    orderBy: [{ featuredAt: "asc" }, { id: "asc" }],
    take: FEATURED_SCAN_CAP,
  })
  const chosen = featuredRotation(candidates, category, now)
    .slice(0, FEATURED_VISIBLE_CAP)
    .map((c) => c.id)

  // ── 2 ── the chosen rows, put back into rotation order (IN keeps none).
  // `where` again, not just the ids: a boost that lapsed or was taken down
  // between the two reads drops out rather than being served.
  const rows = chosen.length
    ? await prisma.item.findMany({
        where: { ...where, id: { in: chosen } },
        select: {
          ...V1_ITEM_SELECT,
          user: { select: V1_ITEM_OWNER_SELECT },
          ...v1ItemStatsSelect(viewerId),
        },
      })
    : []
  const rank = new Map(chosen.map((id, i) => [id, i]))
  const page = (rows as V1ItemRow[]).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
  const access = await preciseAccessItemIds(viewerId, page.map((r) => r.id))

  return ok(
    { items: page.map((r) => v1Item(r, viewerId, access)) },
    {
      category,
      categoryLabel: categoryLabel(category),
      cap: FEATURED_VISIBLE_CAP,
      total: candidates.length,
      rotationHour: rotationHour(now),
    },
  )
}
