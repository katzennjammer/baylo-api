import { NextRequest } from "next/server"
import { z } from "zod"
import { requireRole } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok, notFound, conflict } from "@/lib/v1/envelope"
import { parseJsonBody } from "@/lib/v1/body"
import { writeAudit } from "@/lib/moderation"

export const dynamic = "force-dynamic"

/**
 * One achievement definition: edit it, or activate / deactivate it.
 *
 *   PATCH  /api/admin/achievements/[id]  — update fields and/or flip isActive.
 *
 * ── DEACTIVATE, NEVER DELETE ─────────────────────────────
 *
 * There is no DELETE, here or on the collection route. A UserAchievement row
 * cascades from its Achievement, so a delete would silently strip the badge off
 * every profile that had earned it. Deactivation stops NEW grants and hides the
 * badge from the shelf; the earned copies stay and keep rendering. The
 * ACHIEVEMENT_DEACTIVATED audit row records who did it and why.
 *
 * ── CHANGING A CRITERION OR THRESHOLD IS ALLOWED, WITH A WARNING ─────────────
 *
 * Raising a threshold after the fact does not un-earn badges already granted --
 * the rows exist and are not re-checked. That is deliberate: un-earning a badge
 * somebody is wearing is a support problem and a trust problem, and the audit
 * row records the change so a later "why do I have this?" has an answer. The
 * route does not block it; it records the before/after in `detail`.
 */

const patchSchema = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().min(1).max(400).optional(),
  icon: z.string().trim().min(1).max(8).optional(),
  imageUrl: z
    .string()
    .trim()
    .url()
    .refine((url) => url.startsWith("https://res.cloudinary.com/"), {
      message: "Image must be a Cloudinary delivery URL",
    })
    .nullable()
    .optional(),
  criterion: z
    .enum([
      // Must match the live "AchievementCriterion" enum exactly.
      "VERIFIED_ACCOUNT",
      "ID_VERIFIED",
      "FIRST_LISTING",
      "COMPLETED_TRADES",
      "PROFILE_COMPLETE",
      "LIFETIME_LEAVES",
      "SAFEZONE_MEETUPS",
      "REPORTS_FILED",
      "BRIDGE_COMPLETED",
    ])
    .optional(),
  threshold: z.number().int().min(1).max(1_000_000).optional(),
  points: z.number().int().min(0).max(1_000).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  isActive: z.boolean().optional(),
  reason: z
    .string()
    .trim()
    .min(1, "A reason is required — it is written to the audit log")
    .max(1000),
})

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireRole("ADMIN")
  if (gate.response) return gate.response
  const actor = gate.actor

  const { id } = await params
  const parsed = await parseJsonBody(req, patchSchema)
  if (!parsed.ok) return parsed.response
  const { reason, ...changes } = parsed.data

  const existing = await prisma.achievement.findUnique({ where: { id } })
  if (!existing) return notFound("Achievement not found")

  // Nothing to change is a client mistake, not a success.
  if (Object.keys(changes).length === 0) {
    return conflict("No changes provided", { code: "NO_CHANGES" })
  }

  // Which audit kind this is depends on whether the change is purely a
  // reactivation, a deactivation, or an edit. isActive flipping is the case
  // worth its own kind: "who switched this off, and why" is the question asked
  // about a badge that stopped being awarded.
  const activating = changes.isActive === true && existing.isActive === false
  const deactivating = changes.isActive === false && existing.isActive === true
  const action = activating
    ? "ACHIEVEMENT_REACTIVATED"
    : deactivating
      ? "ACHIEVEMENT_DEACTIVATED"
      : "ACHIEVEMENT_UPDATED"

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.achievement.update({ where: { id }, data: changes })
    await writeAudit(tx, {
      actorId: actor.id,
      action,
      targetType: "ACHIEVEMENT",
      targetId: id,
      reason,
      // Before and after, for the fields that changed. A criterion or threshold
      // edit is exactly the change a later reader needs the history of.
      detail: {
        before: {
          name: existing.name,
          criterion: existing.criterion,
          threshold: existing.threshold,
          points: existing.points,
          isActive: existing.isActive,
          imageUrl: existing.imageUrl,
        },
        after: {
          name: row.name,
          criterion: row.criterion,
          threshold: row.threshold,
          points: row.points,
          isActive: row.isActive,
          imageUrl: row.imageUrl,
        },
      },
    })
    return row
  })

  return ok({
    achievement: {
      id: updated.id,
      key: updated.key,
      name: updated.name,
      description: updated.description,
      icon: updated.icon,
      imageUrl: updated.imageUrl,
      criterion: updated.criterion,
      threshold: updated.threshold,
      points: updated.points,
      sortOrder: updated.sortOrder,
      isActive: updated.isActive,
    },
    audited: true,
  })
}
