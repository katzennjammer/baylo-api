import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok, unauthenticated, notFound } from "@/lib/v1/envelope"
import { parseQuery } from "@/lib/v1/query"
import { deleteOwnStory } from "@/lib/stories"

export const dynamic = "force-dynamic"

/**
 * DELETE /api/v1/stories/[id] — take your own story down.
 *
 * Idempotent: a second DELETE of your own story is still a 200. Someone else's
 * story and a nonexistent id are the same 404.
 */

const querySchema = z.strictObject({})

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const { id } = await params

  const parsed = parseQuery(req, querySchema)
  if (!parsed.ok) return parsed.response

  const deleted = await deleteOwnStory(prisma, session.user.id, id)
  if (!deleted) return notFound("That story no longer exists")
  return ok({ id, deleted: true })
}
