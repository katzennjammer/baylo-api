import { NextRequest, NextResponse } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { followActionSchema, parseBody } from "@/lib/validation"

// PATCH /api/follows/[id] — accept or decline a follow request
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await resolveSession()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const parsed = await parseBody(req, followActionSchema)
  if (!parsed.ok) return parsed.response
  const { action } = parsed.data

  const follow = await prisma.follow.findUnique({ where: { id } })
  if (!follow) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (follow.followeeId !== session.user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (follow.status !== "PENDING") return NextResponse.json({ error: "Already resolved" }, { status: 409 })

  if (action === "decline") {
    await prisma.follow.delete({ where: { id } })
    return NextResponse.json({ status: "declined" })
  }

  const [updated, followee] = await Promise.all([
    prisma.follow.update({ where: { id }, data: { status: "ACCEPTED" } }),
    prisma.user.findUnique({ where: { id: session.user.id }, select: { name: true } }),
  ])

  await prisma.notification.create({
    data: {
      userId: follow.followerId,
      type: "FOLLOW_ACCEPTED",
      message: "accepted your follow request",
      link: "/dashboard/friends",
      actorId: session.user.id,
    },
  })

  return NextResponse.json(updated)
}

// DELETE /api/follows/[id] — remove the current user's relationship with a user
//
// Default: unfollow [id] (you stop following them).
// ?as=follower: remove [id] as YOUR follower (they stop following you). The
// same row the other way round; they are not told, and can follow again, the
// way removing a follower works elsewhere. A private account's pending request
// from them is removed too.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await resolveSession()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id: otherId } = await params
  const removingFollower = req.nextUrl.searchParams.get("as") === "follower"
  const key = removingFollower
    ? { followerId: otherId, followeeId: session.user.id }
    : { followerId: session.user.id, followeeId: otherId }

  const follow = await prisma.follow.findUnique({ where: { followerId_followeeId: key } })
  if (!follow) return NextResponse.json({ error: "Not found" }, { status: 404 })

  await prisma.follow.delete({ where: { id: follow.id } })
  return NextResponse.json({ status: removingFollower ? "removed" : "unfollowed" })
}
