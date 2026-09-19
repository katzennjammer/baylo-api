import { NextRequest } from "next/server"
import { z } from "zod"
import { requireRole } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok, invalid } from "@/lib/v1/envelope"
import { parseQuery, paginationShape } from "@/lib/v1/query"
import { decodeCursor, encodeCursor, olderThan, paginate } from "@/lib/v1/cursor"

export const dynamic = "force-dynamic"

/**
 * GET /api/admin/audit — the moderation log, readable.
 *
 * An audit trail nobody can read is a table, not an audit trail. The point of
 * writing AdminAction rows is that somebody can afterwards ask "who suspended
 * this account, and what did they say the reason was" and get an answer
 * without a database prompt.
 *
 * Filterable by actor and by target, because those are the two questions:
 * "what has this moderator been doing" (accountability) and "what has been done
 * to this user" (appeal). Both are served by an index; see the model.
 *
 * READ-ONLY, AND THERE IS NO WRITE ROUTE. Rows are written only from inside the
 * transaction of the action they describe, by writeAudit(). There is no
 * endpoint to create, edit or delete one — an audit log with an edit button
 * records what somebody was willing to admit to, which is a different and much
 * less useful thing.
 *
 * MODERATOR, not ADMIN. A moderator being able to read what other moderators
 * did is most of what makes the log a check on anything.
 */

const querySchema = z.strictObject({
  ...paginationShape,
  actorId: z.string().min(1).max(64).optional(),
  targetType: z.enum(["REPORT", "LISTING", "USER", "HUB", "ID_VERIFICATION"]).optional(),
  targetId: z.string().min(1).max(64).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

export async function GET(req: NextRequest) {
  const gate = await requireRole("ADMIN")
  if (gate.response) return gate.response

  const parsed = parseQuery(req, querySchema)
  if (!parsed.ok) return parsed.response
  const { limit, actorId, targetType, targetId, from, to } = parsed.data
  const cursor = decodeCursor(parsed.data.cursor)
  if (parsed.data.cursor && !cursor) return invalid("Malformed cursor")
  const fromDate = from ? new Date(`${from}T00:00:00.000Z`) : undefined
  const toDate = to ? new Date(`${to}T00:00:00.000Z`) : undefined
  if (fromDate && Number.isNaN(fromDate.getTime())) return invalid("Invalid `from` date")
  if (toDate && Number.isNaN(toDate.getTime())) return invalid("Invalid `to` date")
  if (fromDate && toDate && fromDate > toDate) return invalid("`from` must be before `to`")
  const createdAt = {
    ...(fromDate ? { gte: fromDate } : {}),
    ...(toDate ? { lt: new Date(toDate.getTime() + 86_400_000) } : {}),
  }

  const rows = await prisma.adminAction.findMany({
    where: {
      ...(actorId ? { actorId } : {}),
      ...(targetType ? { targetType } : {}),
      ...(targetId ? { targetId } : {}),
      ...(fromDate || toDate ? { createdAt } : {}),
      ...(olderThan(cursor) ?? {}),
    },
    select: {
      id: true,
      action: true,
      targetType: true,
      targetId: true,
      reportId: true,
      reason: true,
      detail: true,
      createdAt: true,
      actor: { select: { id: true, name: true, email: true, role: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  })

  const { page, nextCursor } = paginate(rows, limit, (r) => encodeCursor(r.createdAt, r.id))

  return ok(
    {
      actions: page.map((r) => ({
        id: r.id,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        reportId: r.reportId,
        reason: r.reason,
        // Stored as a JSON string; parsed here so the client does not have to
        // know that. A malformed value yields null rather than throwing — one
        // bad row must not take down the whole log.
        detail: (() => {
          if (!r.detail) return null
          try {
            return JSON.parse(r.detail) as unknown
          } catch {
            return null
          }
        })(),
        createdAt: r.createdAt,
        actor: r.actor,
      })),
    },
    {
      nextCursor,
      applied: {
        actorId: actorId ?? null,
        targetType: targetType ?? null,
        targetId: targetId ?? null,
      },
    },
  )
}
