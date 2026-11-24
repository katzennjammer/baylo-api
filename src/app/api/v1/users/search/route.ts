import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import { userNotBlocked } from "@/lib/blocking"
import { notSuspendedWhere } from "@/lib/moderation"
import prisma from "@/lib/prisma"
import { SUBSCRIPTION_SELECT, hasPremiumAccess } from "@/lib/premium"
import { ORG_PUBLIC_SELECT, orgBadge } from "@/lib/organizations"
import { loadTrustTiers } from "@/lib/trust-tiers"
import { decodeCursor, encodeCursor, paginate } from "@/lib/v1/cursor"
import { invalid, ok, unauthenticated } from "@/lib/v1/envelope"
import { enforceRateLimit } from "@/lib/rate-limit-config"
import { escapeLike } from "@/lib/like"
import { parseQuery } from "@/lib/v1/query"

export const dynamic = "force-dynamic"

const querySchema = z.strictObject({
  q: z.string().trim().min(2).max(50),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(20).optional().default(20),
})

/** GET /api/v1/users/search — public identity matches for the signed-in viewer. */
export async function GET(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const viewerId = session.user.id

  const limited = enforceRateLimit("usersSearch", viewerId)
  if (limited) return limited

  const parsed = parseQuery(req, querySchema)
  if (!parsed.ok) return parsed.response
  const { q, limit } = parsed.data
  const cursor = decodeCursor(parsed.data.cursor)
  if (parsed.data.cursor && (!cursor || typeof cursor.k !== "string")) {
    return invalid("Malformed cursor")
  }

  const rows = await prisma.user.findMany({
    where: {
      id: { not: viewerId },
      deletedAt: null,
      // Escaped: `%` and `_` in a search are characters, not wildcards.
      name: { contains: escapeLike(q), mode: "insensitive" },
      ...userNotBlocked(viewerId),
      ...notSuspendedWhere(),
      ...(cursor && typeof cursor.k === "string"
        ? {
            OR: [
              { name: { gt: cursor.k } },
              { name: cursor.k, id: { gt: cursor.id } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      name: true,
      avatar: true,
      location: true,
      rating: true,
      totalTrades: true,
      _count: { select: { reviewsReceived: true } },
      organization: { select: ORG_PUBLIC_SELECT },
      subscriptions: SUBSCRIPTION_SELECT,
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: limit + 1,
  })

  const { page, nextCursor } = paginate(rows, limit, (user) =>
    encodeCursor(user.name, user.id),
  )
  const people = page.filter((user) => !user.organization)
  const tiers = await loadTrustTiers(prisma, people)

  return ok(
    {
      users: page.map((user) => ({
        id: user.id,
        name: user.name,
        avatar: user.avatar,
        location: user.location,
        rating: user.rating,
        reviewCount: user._count.reviewsReceived,
        totalTrades: user.totalTrades,
        trustTier: user.organization ? null : tiers.get(user.id) ?? null,
        org: user.organization ? orgBadge(user.organization) : null,
        premium: hasPremiumAccess(user.subscriptions),
      })),
    },
    { nextCursor },
  )
}
