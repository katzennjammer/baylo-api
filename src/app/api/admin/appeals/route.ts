import { NextRequest } from "next/server"
import { z } from "zod"
import { requireRole } from "@/lib/api-auth"
import { ok } from "@/lib/v1/envelope"
import { parseQuery } from "@/lib/v1/query"
import { loadAppeals, shapeAppeal } from "@/lib/admin-appeals"

export const dynamic = "force-dynamic"

/**
 * GET /api/admin/appeals — the appeals queue, and the decided ones.
 *
 * Each row carries everything a decision needs in one place: the listing
 * and BOTH values with both brackets (the question is still "is this number
 * right"), the decision being appealed -- who made it, when, the reason the
 * owner was shown (code) and the note they were not -- and the owner's
 * message. `sameReviewer` says whether the caller made the original decision,
 * so the page can warn before they decide their own appeal.
 *
 * OPEN rows oldest first: a queue somebody is waiting in, like the value
 * reviews. Decided rows newest first, because those are read as history.
 */

const querySchema = z.strictObject({
  status: z.enum(["open", "decided"]).optional().default("open"),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
})

export async function GET(req: NextRequest) {
  const gate = await requireRole("ADMIN")
  if (gate.response) return gate.response

  const parsed = parseQuery(req, querySchema)
  if (!parsed.ok) return parsed.response
  const { status, limit } = parsed.data

  const rows = await loadAppeals(status, limit)
  return ok({ appeals: rows.map((r) => shapeAppeal(r, gate.actor.id)) }, { applied: { status, limit } })
}
