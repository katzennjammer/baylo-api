import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import { blockDirection } from "@/lib/blocking"
import { bracketOf } from "@/lib/brackets"
import prisma from "@/lib/prisma"
import { loadTrustTiers } from "@/lib/trust-tiers"
import { notFound, unauthenticated, invalid, ok } from "@/lib/v1/envelope"
import { decodeCursor, encodeCursor, olderThan, paginate } from "@/lib/v1/cursor"
import { paginationShape, parseQuery } from "@/lib/v1/query"

export const dynamic = "force-dynamic"

const querySchema = z.strictObject({ ...paginationShape })

function firstImage(images: string): string | null {
  try {
    const parsed: unknown = JSON.parse(images)
    return Array.isArray(parsed) && typeof parsed[0] === "string" ? parsed[0] : null
  } catch {
    return null
  }
}

/** GET /api/v1/profile/[id]/reviews — newest reviews received by a user. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const viewerId = session.user.id
  const { id } = await params

  const parsed = parseQuery(req, querySchema)
  if (!parsed.ok) return parsed.response
  const { limit } = parsed.data
  const cursor = decodeCursor(parsed.data.cursor)
  if (parsed.data.cursor && !cursor) return invalid("Malformed cursor")

  if (await blockDirection(viewerId, id) !== "none") {
    return notFound("Profile not found")
  }

  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, rating: true, deletedAt: true },
  })
  if (!user || user.deletedAt) return notFound("Profile not found")

  const [reviewRows, summary, tiers] = await Promise.all([
    prisma.review.findMany({
      where: { revieweeId: id, ...(olderThan(cursor) ?? {}) },
      select: {
        id: true,
        rating: true,
        comment: true,
        createdAt: true,
        reviewer: { select: { id: true, name: true, avatar: true } },
        trade: {
          select: {
            senderId: true,
            offeredItem: { select: { id: true, title: true, images: true, valueLeaves: true } },
            requestedItem: { select: { id: true, title: true, images: true, valueLeaves: true } },
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    }),
    prisma.review.aggregate({
      where: { revieweeId: id },
      _avg: { rating: true },
      _count: { _all: true },
    }),
    loadTrustTiers(prisma, [{ id: user.id, rating: user.rating }]),
  ])

  const { page, nextCursor } = paginate(reviewRows, limit, (review) =>
    encodeCursor(review.createdAt, review.id),
  )
  const tier = tiers.get(user.id)

  return ok(
    {
      summary: {
        averageRating: summary._avg.rating ?? 0,
        totalReviews: summary._count._all,
        trustTier: tier ?? null,
      },
      reviews: page.map((review) => {
        const item = review.trade.senderId === id
          ? review.trade.offeredItem
          : review.trade.requestedItem

        return {
          id: review.id,
          rating: review.rating,
          comment: review.comment,
          createdAt: review.createdAt,
          reviewer: review.reviewer,
          item: item
            ? {
                id: item.id,
                title: item.title,
                image: firstImage(item.images),
                bracket: item.valueLeaves === null ? null : bracketOf(item.valueLeaves),
              }
            : null,
        }
      }),
    },
    { nextCursor },
  )
}
