import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok, unauthenticated, notFound } from "@/lib/v1/envelope"
import { parseQuery } from "@/lib/v1/query"
import { enforceRateLimit } from "@/lib/rate-limit-config"
import { markStorySeen } from "@/lib/stories"

export const dynamic = "force-dynamic"

/**
 * POST /api/v1/stories/[id]/seen — this viewer has seen this story.
 *
 * Idempotent (one StoryView row per story and viewer). A story the viewer
 * cannot see -- expired, deleted, its listing gone, a block either way, a
 * suspended author -- is a 404 exactly like an id that never existed, so the
 * endpoint confirms nothing about stories outside the viewer's row.
 */

const querySchema = z.strictObject({})

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const viewerId = session.user.id
  const { id } = await params

  const parsed = parseQuery(req, querySchema)
  if (!parsed.ok) return parsed.response

  const limited = enforceRateLimit("storySeen", viewerId)
  if (limited) return limited

  const seen = await markStorySeen(prisma, viewerId, id)
  if (!seen) return notFound("That story is no longer available")
  return ok({ id, seen: true })
}
