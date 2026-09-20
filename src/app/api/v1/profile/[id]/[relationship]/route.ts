import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import { blockDirection } from "@/lib/blocking"
import prisma from "@/lib/prisma"
import { loadTrustTiers } from "@/lib/trust-tiers"
import { decodeCursor, encodeCursor, olderThan, paginate } from "@/lib/v1/cursor"
import { invalid, notFound, ok, unauthenticated } from "@/lib/v1/envelope"
import { paginationShape, parseQuery } from "@/lib/v1/query"

export const dynamic = "force-dynamic"

const querySchema = z.strictObject({ ...paginationShape })

/** GET /api/v1/profile/[id]/followers|following — accepted relationships. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; relationship: string }> },
) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const viewerId = session.user.id
  const { id, relationship } = await params

  if (relationship !== "followers" && relationship !== "following") {
    return notFound("Relationship list not found")
  }

  const parsed = parseQuery(req, querySchema)
  if (!parsed.ok) return parsed.response
  const { limit } = parsed.data
  const cursor = decodeCursor(parsed.data.cursor)
  if (parsed.data.cursor && !cursor) return invalid("Malformed cursor")

  if (await blockDirection(viewerId, id) !== "none") {
    return notFound("Profile not found")
  }

  const profile = await prisma.user.findUnique({
    where: { id },
    select: { id: true, deletedAt: true },
  })
  if (!profile || profile.deletedAt) return notFound("Profile not found")

  const edges = await prisma.follow.findMany({
    where: {
      ...(relationship === "followers" ? { followeeId: id } : { followerId: id }),
      status: "ACCEPTED",
      ...(olderThan(cursor) ?? {}),
    },
    select: {
      id: true,
      createdAt: true,
      follower: { select: { id: true, name: true, avatar: true, rating: true, deletedAt: true } },
      followee: { select: { id: true, name: true, avatar: true, rating: true, deletedAt: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  })

  const { page, nextCursor } = paginate(edges, limit, (edge) => encodeCursor(edge.createdAt, edge.id))
  const users = page
    .map((edge) => relationship === "followers" ? edge.follower : edge.followee)
    .filter((user) => !user.deletedAt)
  const userIds = users.map((user) => user.id)

  const [tiers, viewerEdges] = await Promise.all([
    loadTrustTiers(prisma, users),
    userIds.length === 0
      ? Promise.resolve([])
      : prisma.follow.findMany({
          where: {
            OR: [
              { followerId: viewerId, followeeId: { in: userIds } },
              { followerId: { in: userIds }, followeeId: viewerId },
            ],
          },
          select: { followerId: true, followeeId: true, status: true },
        }),
  ])
  const viewerEdgeByFollowee = new Map(
    viewerEdges
      .filter((edge) => edge.followeeId !== viewerId)
      .map((edge) => [edge.followeeId, edge.status]),
  )
  const followsViewer = new Set(
    viewerEdges
      .filter((edge) => edge.followeeId === viewerId && edge.status === "ACCEPTED")
      .map((edge) => edge.followerId),
  )

  return ok(
    {
      users: users.map((user) => ({
        id: user.id,
        name: user.name,
        avatar: user.avatar,
        trustTier: tiers.get(user.id) ?? null,
        follow: {
          status: viewerEdgeByFollowee.get(user.id) ?? "NONE",
        },
        followsYou: followsViewer.has(user.id),
      })),
    },
    { nextCursor },
  )
}