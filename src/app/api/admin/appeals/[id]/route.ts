import { NextRequest } from "next/server"
import { z } from "zod"
import { requireRole } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { bracketOf } from "@/lib/brackets"
import { ok, notFound, conflict } from "@/lib/v1/envelope"
import { parseJsonBody } from "@/lib/v1/body"
import { writeAudit } from "@/lib/moderation"

export const dynamic = "force-dynamic"

/**
 * POST /api/admin/appeals/[id] — uphold or overturn one appeal.
 *
 * ── WHAT EACH DECISION DOES ─────────────────────────────────────────────────
 *
 *   uphold     nothing changes on the listing. It stays VALUE_REJECTED, or
 *              stays hidden. The appeal is UPHELD, which the unique actionId
 *              makes final: that decision cannot be appealed again. The
 *              owner keeps the same three exits (suggested / within cap /
 *              delete), which the lock releases.
 *
 *   overturn   VALUE_REJECTION: the listing goes AVAILABLE at the value the
 *              owner asked for -- the same thing approve-value does, for the
 *              same reason: overturning is deciding the number was right.
 *              MODERATION_HIDE: moderationHiddenAt is cleared. In both cases
 *              the write is conditional on the state the appeal was filed
 *              against still holding; if it does not (an admin hid a rejected
 *              listing in the meantime, say), the transaction fails and the
 *              appeal stays OPEN for a decision that fits.
 *
 * ── SAME REVIEWER: A WARNING, NOT A BLOCK ───────────────────────────────────
 *
 * The page warns when the caller made the decision being appealed and asks
 * for a second click; this route accepts either way and records
 * `sameReviewer: true` in the audit detail. A block would deadlock a
 * one-admin deployment, and the audit row is the accountability.
 *
 * Conditional updateMany on status OPEN, so two admins deciding at once get
 * one decision and one 409. Audit row and notification in the same
 * transaction as the state change, as everywhere else in /api/admin.
 */

const bodySchema = z.strictObject({
  decision: z.enum(["uphold", "overturn"]),
  reason: z.string().trim().min(1, "A reason is required — it is written to the audit log").max(1000),
})

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await requireRole("MODERATOR")
  if (gate.response) return gate.response
  const actor = gate.actor

  const { id } = await params
  const parsed = await parseJsonBody(req, bodySchema)
  if (!parsed.ok) return parsed.response
  const { decision, reason } = parsed.data

  const appeal = await prisma.listingAppeal.findUnique({
    where: { id },
    select: {
      id: true, kind: true, status: true, actionId: true, ownerId: true, message: true,
      item: { select: { id: true, title: true, status: true, moderationHiddenAt: true, valueLeaves: true, suggestedLeaves: true } },
    },
  })
  if (!appeal) return notFound("Appeal not found")
  if (appeal.status !== "OPEN") {
    return conflict("That appeal was already decided", { code: "ALREADY_DECIDED", status: appeal.status })
  }

  const appealed = await prisma.adminAction.findUnique({
    where: { id: appeal.actionId },
    select: { actorId: true, reason: true, createdAt: true },
  })
  const sameReviewer = appealed?.actorId === actor.id
  const overturn = decision === "overturn"
  const item = appeal.item

  const outcome = await prisma.$transaction(async (tx) => {
    const decided = await tx.listingAppeal.updateMany({
      where: { id, status: "OPEN" },
      data: {
        status: overturn ? "OVERTURNED" : "UPHELD",
        decidedById: actor.id,
        decidedAt: new Date(),
        decisionReason: reason,
      },
    })
    if (decided.count !== 1) return "raced" as const

    if (overturn) {
      const moved =
        appeal.kind === "VALUE_REJECTION"
          ? await tx.item.updateMany({
              where: { id: item.id, status: "VALUE_REJECTED" },
              data: { status: "AVAILABLE", valueRejectionReason: null },
            })
          : await tx.item.updateMany({
              where: { id: item.id, moderationHiddenAt: { not: null } },
              data: { moderationHiddenAt: null },
            })
      // The state the appeal was filed against no longer holds. Roll the
      // whole thing back rather than mark an appeal overturned with nothing
      // overturned.
      if (moved.count !== 1) throw new StateChanged()
    }

    await writeAudit(tx, {
      actorId: actor.id,
      action: overturn ? "LISTING_APPEAL_OVERTURNED" : "LISTING_APPEAL_UPHELD",
      targetType: "LISTING_APPEAL",
      targetId: appeal.id,
      reason,
      detail: {
        itemId: item.id,
        title: item.title,
        ownerId: appeal.ownerId,
        kind: appeal.kind,
        appealedActionId: appeal.actionId,
        appealedActorId: appealed?.actorId ?? null,
        appealedReason: appealed?.reason ?? null,
        appealMessage: appeal.message,
        requestedLeaves: item.valueLeaves,
        suggestedLeaves: item.suggestedLeaves,
        requestedBracket: item.valueLeaves === null ? null : bracketOf(item.valueLeaves),
        suggestedBracket: item.suggestedLeaves === null ? null : bracketOf(item.suggestedLeaves),
        // Recorded whenever it is true. The page warned; this is the record
        // that the warning was seen and the decision made anyway.
        ...(sameReviewer ? { sameReviewer: true } : {}),
      },
    })

    // No actorId, entityType "listing_review": same rules as the decision
    // being appealed. See the note in /api/admin/listings/[id].
    await tx.notification.create({
      data: {
        userId: appeal.ownerId,
        type: overturn ? "LISTING_APPEAL_OVERTURNED" : "LISTING_APPEAL_UPHELD",
        message: ownerMessage(appeal.kind, overturn, item),
        entityType: "listing_review",
        entityId: item.id,
      },
    })
    return "decided" as const
  }).catch((err: unknown) => {
    if (err instanceof StateChanged) return "changed" as const
    throw err
  })

  if (outcome === "raced") return conflict("That appeal was just decided by someone else", { code: "ALREADY_DECIDED" })
  if (outcome === "changed") {
    return conflict(
      "The listing is no longer in the state this appeal was filed against; decide it from the Listings page instead",
      { code: "STATE_CHANGED" },
    )
  }

  return ok({
    appeal: { id: appeal.id, status: overturn ? "OVERTURNED" : "UPHELD", sameReviewer },
    listing: overturn
      ? appeal.kind === "VALUE_REJECTION"
        ? { id: item.id, status: "AVAILABLE", valueLeaves: item.valueLeaves }
        : { id: item.id, moderationHiddenAt: null }
      : { id: item.id, status: item.status, moderationHiddenAt: item.moderationHiddenAt },
    audited: true,
  })
}

class StateChanged extends Error {}

function ownerMessage(
  kind: "VALUE_REJECTION" | "MODERATION_HIDE",
  overturn: boolean,
  item: { title: string; valueLeaves: number | null; suggestedLeaves: number | null },
): string {
  const leaves = (n: number | null) => (n ?? 0).toLocaleString("en-US")
  if (kind === "MODERATION_HIDE") {
    return overturn
      ? `Your appeal on "${item.title}" was accepted — it is visible again.`
      : `Your appeal on "${item.title}" was reviewed and the decision stands: it stays hidden. This decision can't be appealed again.`
  }
  return overturn
    ? `Your appeal on "${item.title}" was accepted — it is live at ${leaves(item.valueLeaves)} Leaves.`
    : `Your appeal on "${item.title}" was reviewed and the decision stands. It can't be appealed again. You can still list it at the suggested ${leaves(item.suggestedLeaves)}, set a value within one bracket of that, or delete it.`
}
