import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok, unauthenticated, notFound, conflict } from "@/lib/v1/envelope"
import { parseJsonBody } from "@/lib/v1/body"
import { APPEAL_MESSAGE_MAX, appealKindFor, appealableAction } from "@/lib/appeals"

export const dynamic = "force-dynamic"

/**
 * POST /api/v1/items/[id]/appeal — the owner appeals a value rejection or a
 * takedown, in their own words.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 *
 * It does not change the listing. It stays VALUE_REJECTED, or stays hidden,
 * until an admin decides; filing is not a publish and not a half-publish.
 * From here on the listing is LOCKED -- no value edit, no delete -- until the
 * decision (see @/lib/appeals for why).
 *
 * It writes no AdminAction. The audit table's actor is staff; the owner's
 * step is the ListingAppeal row itself, which is never edited.
 *
 * ── ONE PER DECISION ────────────────────────────────────────────────────────
 *
 * `actionId` is unique, so a second appeal against the same rejection -- and
 * any appeal against one already upheld -- is refused. Which one it is comes
 * back in the 409's code, so the client can say "waiting" or "decided" rather
 * than "no". The check-then-insert below is racy by nature; the unique index
 * is the real guard and P2002 is mapped to the same 409.
 *
 * 404 (not 403) for a listing the caller does not own, matching every other
 * route on a listing somebody else may not know exists.
 */

const bodySchema = z.strictObject({
  message: z
    .string()
    .trim()
    .min(1, "Say why the decision should be looked at again")
    .max(APPEAL_MESSAGE_MAX, `Keep it to ${APPEAL_MESSAGE_MAX} characters`),
})

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const viewerId = session.user.id
  const { id } = await params

  const parsed = await parseJsonBody(req, bodySchema)
  if (!parsed.ok) return parsed.response

  const item = await prisma.item.findFirst({
    where: { id, userId: viewerId, status: { not: "REMOVED" } },
    select: { id: true, status: true, moderationHiddenAt: true, userId: true },
  })
  if (!item) return notFound("Item not found")

  const kind = appealKindFor(item)
  if (kind === null) {
    return conflict("There is no decision on this listing to appeal", { code: "NOTHING_TO_APPEAL" })
  }
  const action = await appealableAction(prisma, item.id, kind)
  if (!action) {
    // The state exists without the audit row that would have produced it.
    // Nothing to point the appeal at; a moderator can restore it by hand.
    return conflict("This decision has no record to appeal against", { code: "NO_DECISION_RECORD" })
  }

  const existing = await prisma.listingAppeal.findUnique({
    where: { actionId: action.id },
    select: { id: true, status: true },
  })
  if (existing) return alreadyAppealed(existing.status)

  try {
    const appeal = await prisma.listingAppeal.create({
      data: {
        itemId: item.id,
        ownerId: viewerId,
        kind,
        actionId: action.id,
        message: parsed.data.message,
      },
      select: { id: true, status: true, kind: true, message: true, createdAt: true },
    })
    return ok({ appeal })
  } catch (err) {
    if (isUniqueViolation(err)) {
      const raced = await prisma.listingAppeal.findUnique({ where: { actionId: action.id }, select: { status: true } })
      return alreadyAppealed(raced?.status ?? "OPEN")
    }
    throw err
  }
}

function alreadyAppealed(status: string) {
  return status === "OPEN"
    ? conflict("This decision is already under appeal", { code: "APPEAL_OPEN" })
    : status === "UPHELD"
      ? conflict("This decision was appealed and upheld; it cannot be appealed again", { code: "APPEAL_UPHELD" })
      : conflict("This decision was already overturned", { code: "APPEAL_OVERTURNED" })
}

/** P2002 — the unique constraint. Narrowed without importing the error class. */
function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002"
}
