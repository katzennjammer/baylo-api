import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok, unauthenticated, notFound } from "@/lib/v1/envelope"
import { parseQuery } from "@/lib/v1/query"
import { deleteOwnStory } from "@/lib/stories"
import { ORG_CONTEXT_HEADER, resolveActingIdentity } from "@/lib/organizations"

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

  // The shop's own story can be deleted from shop mode (16 Nov 2026); the
  // person's own stays deletable in either mode.
  const acting = await resolveActingIdentity(prisma, session.user.id, req.headers.get(ORG_CONTEXT_HEADER))
  const actingId = acting.ok ? acting.acting.actingUserId : session.user.id
  const deleted =
    (actingId !== session.user.id && (await deleteOwnStory(prisma, actingId, id))) ||
    (await deleteOwnStory(prisma, session.user.id, id))
  if (!deleted) return notFound("That story no longer exists")
  return ok({ id, deleted: true })
}
