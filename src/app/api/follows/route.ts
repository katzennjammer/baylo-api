import { NextRequest, NextResponse } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { followSchema, parseBody } from "@/lib/validation"
import { settleQuestsAsync } from "@/lib/quests"

// GET /api/follows — incoming pending follow requests for current user
export async function GET() {
  const session = await resolveSession()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const requests = await prisma.follow.findMany({
    where: { followeeId: session.user.id, status: "PENDING" },
    include: { follower: { select: { id: true, name: true, avatar: true, location: true } } },
    orderBy: { createdAt: "desc" },
  })

  return NextResponse.json(requests)
}

// POST /api/follows — follow a user immediately
export async function POST(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const parsed = await parseBody(req, followSchema)
  if (!parsed.ok) return parsed.response
  const { followeeId } = parsed.data
  if (followeeId === session.user.id) return NextResponse.json({ error: "Cannot follow yourself" }, { status: 400 })

  const existing = await prisma.follow.findUnique({
    where: { followerId_followeeId: { followerId: session.user.id, followeeId } },
  })
  if (existing) return NextResponse.json(existing)

  const follow = await prisma.follow.create({
    data: { followerId: session.user.id, followeeId, status: "ACCEPTED" },
  })

  // A NEW follow only. The early return above for an existing one means
  // re-following cannot re-trigger the check, though it would pay nothing anyway.
  settleQuestsAsync(session.user.id, ["FOLLOW_TRADER"])

  await prisma.notification.create({
    data: {
      userId: followeeId,
      type: "FOLLOW_REQUEST",
      message: "started following you",
      link: "/dashboard/friends",
      actorId: session.user.id,
    },
  })

  return NextResponse.json(follow, { status: 201 })
}
