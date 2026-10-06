import { NextRequest } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok, unauthenticated, notFound } from "@/lib/v1/envelope"

export const dynamic = "force-dynamic"

/**
 * GET /api/v1/suspensions/[id] — one of the CALLER'S OWN suspensions.
 *
 * What the SUSPENSION_LIFTED notification opens: the reason the admin gave,
 * when it started and ended, and which suspension it was for the account.
 *
 * `userId` is in the WHERE, so somebody else's id is a 404 and not a 403: a
 * 403 would confirm that the id is a real suspension of a real account.
 *
 * No moderator is named. AdminAction knows who imposed and who lifted it; the
 * person it was imposed on is told what and why, not by whom.
 *
 * Only ever reached for a suspension that is OVER: resolveSession() refuses an
 * account with one in force, so that account cannot make this request at all.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const { id } = await params

  const suspension = await prisma.suspension.findFirst({
    where: { id, userId: session.user.id },
    select: { id: true, level: true, reason: true, startsAt: true, endsAt: true, liftedAt: true },
  })
  if (!suspension) return notFound("That suspension was not found")
  return ok({ suspension })
}
