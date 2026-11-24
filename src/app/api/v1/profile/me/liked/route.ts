import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import { visibleItemWhere } from "@/lib/blocking"
import { preciseAccessItemIds } from "@/lib/item-visibility"
import prisma from "@/lib/prisma"
import { ok, unauthenticated } from "@/lib/v1/envelope"
import { V1_ITEM_OWNER_SELECT, V1_ITEM_SELECT, v1Item, v1ItemStatsSelect, type V1ItemRow } from "@/lib/v1/item"
import { paginationShape, parseQuery } from "@/lib/v1/query"

export const dynamic = "force-dynamic"

const querySchema = z.strictObject({ ...paginationShape })

/**
 * GET /api/v1/profile/me/liked -- the listings you have liked (saved),
 * most recently liked first. For the "Liked" screen in the profile menu.
 *
 * Reads the existing Like rows; no new table. Listings hidden by a moderator
 * or owned by someone blocked either way are left out, the same rule as
 * every other list. The cursor is the Like row's id.
 */
export async function GET(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const viewerId = session.user.id

  const parsed = parseQuery(req, querySchema)
  if (!parsed.ok) return parsed.response
  const { limit, cursor } = parsed.data

  const likes = await prisma.like.findMany({
    where: { userId: viewerId, post: visibleItemWhere(viewerId) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      createdAt: true,
      post: {
        select: {
          ...V1_ITEM_SELECT,
          user: { select: V1_ITEM_OWNER_SELECT },
          ...v1ItemStatsSelect(viewerId),
        },
      },
    },
  })

  const page = likes.slice(0, limit)
  const access = await preciseAccessItemIds(viewerId, page.map((l) => l.post.id))
  return ok(
    {
      items: page.map((l) => ({ ...v1Item(l.post as unknown as V1ItemRow, viewerId, access), likedAt: l.createdAt.toISOString() })),
    },
    { nextCursor: likes.length > limit ? page[page.length - 1].id : null },
  )
}
