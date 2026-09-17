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
 * POST /api/admin/listings/[id] — hide or restore a listing.
 *
 * ONE route with an `action`, not /hide and /unhide, so the two halves cannot
 * drift: they write the same audit shape, take the same required reason, and
 * flip the same single column. Two files would eventually have two idea of what
 * "hidden" means.
 *
 * WHAT HIDING DOES: sets Item.moderationHiddenAt. That is the whole mechanism.
 * Every read path in the app already filters `moderationHiddenAt: null` in its
 * WHERE clause (see visibleItemWhere() in @/lib/blocking), so one column write
 * removes the listing from the feed, browse, search, both profile screens, item
 * detail, offers and trade initiation at once.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *
 *   It does not touch `status`. The owner's own lifecycle (AVAILABLE, OWNED,
 *   IN_TRADE, TRADED) is theirs and a takedown must not silently rewrite it —
 *   restoring the listing would otherwise have to guess what it used to be.
 *   The prior status goes into the audit row's `detail` regardless, because
 *   "what did this look like before we touched it" is the question an appeal
 *   asks.
 *
 *   It does not cancel a trade the item is in. Same reasoning as blocking: the
 *   item may already have changed hands at a meetup, and this system has no
 *   mechanism that could recover it. See the note on the DeferredContract model.
 *   A moderator who needs the trade stopped has to say so to the parties; the
 *   database will not pretend it can undo a physical handover.
 */

const bodySchema = z.strictObject({
  action: z.enum(["hide", "unhide", "approve-value", "reject-value"]),
  reason: z
    .string()
    .trim()
    .min(1, "A reason is required — it is written to the audit log")
    .max(1000),
  /** The report this answers, if it came from the queue. */
  reportId: z.string().min(1).max(64).optional(),
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
  const { action, reason, reportId } = parsed.data

  const item = await prisma.item.findUnique({
    where: { id },
    select: {
      id: true, title: true, status: true, userId: true, moderationHiddenAt: true,
      valueLeaves: true, suggestedLeaves: true, valueSetByUser: true,
    },
  })
  if (!item) return notFound("Listing not found")

  /*
   * ── THE VALUE REVIEW ────────────────────────────────────────────────────
   *
   * A listing whose owner asked for a value more than one bracket above the
   * server's suggestion sits in PENDING_REVIEW: it exists, only its owner can
   * see it, and it trades with nobody until this decision is made.
   *
   * APPROVE publishes it AT THE VALUE THEY ASKED FOR. That is the whole point
   * of approving — the reviewer has decided the model was wrong about this
   * item — so nothing is re-derived and the number is not adjusted.
   *
   * REJECT DOES NOT PUBLISH IT AT THE SUGGESTION. That was the obvious
   * implementation and it is wrong: it would put a listing live at a price its
   * owner never agreed to, which is a worse outcome than leaving it hidden.
   * The listing stays in PENDING_REVIEW, the owner is told, and they choose --
   * relist at the suggestion, edit the value back inside the cap (PATCH
   * /api/items/[id], which moves it to AVAILABLE by itself), or delete it. The
   * notification says exactly those three things.
   */
  if (action === "approve-value" || action === "reject-value") {
    if (item.status !== "PENDING_REVIEW") {
      return conflict("That listing is not waiting on a value review", { code: "NOT_IN_REVIEW" })
    }

    const approved = action === "approve-value"
    const approve = await prisma.$transaction(async (tx) => {
      // Conditional on the status we read, so two reviewers clicking at once
      // produce one decision and one 409.
      const moved = await tx.item.updateMany({
        where: { id, status: "PENDING_REVIEW" },
        data: approved ? { status: "AVAILABLE" } : {},
      })
      if (approved && moved.count !== 1) return false

      await writeAudit(tx, {
        actorId: actor.id,
        action: approved ? "LISTING_VALUE_APPROVED" : "LISTING_VALUE_REJECTED",
        targetType: "LISTING",
        targetId: id,
        reportId: reportId ?? null,
        reason,
        // BOTH numbers, because the decision was about the distance between
        // them and the suggestion can move later (a re-valuation, an edited
        // category). This row is the only record of what was actually decided.
        detail: {
          title: item.title,
          ownerId: item.userId,
          requestedLeaves: item.valueLeaves,
          suggestedLeaves: item.suggestedLeaves,
          requestedBracket: item.valueLeaves === null ? null : bracketOf(item.valueLeaves),
          suggestedBracket: item.suggestedLeaves === null ? null : bracketOf(item.suggestedLeaves),
        },
      })

      await tx.notification.create({
        data: {
          userId: item.userId,
          type: approved ? "LISTING_VALUE_APPROVED" : "LISTING_VALUE_REJECTED",
          message: approved
            ? `"${item.title}" is live at ${(item.valueLeaves ?? 0).toLocaleString("en-US")} Leaves — the value you asked for was approved.`
            : `"${item.title}" was not approved at ${(item.valueLeaves ?? 0).toLocaleString("en-US")} Leaves. It stays hidden until you choose: list it at the suggested ${(item.suggestedLeaves ?? 0).toLocaleString("en-US")}, set a value within one bracket of that, or delete it.`,
          entityType: "item",
          entityId: id,
          actorId: actor.id,
        },
      })
      return true
    })

    if (!approve) return conflict("That review was just decided by someone else")

    return ok({
      listing: {
        id,
        status: approved ? "AVAILABLE" : "PENDING_REVIEW",
        valueLeaves: item.valueLeaves,
        suggestedLeaves: item.suggestedLeaves,
      },
      audited: true,
    })
  }

  const alreadyHidden = item.moderationHiddenAt !== null
  if (action === "hide" && alreadyHidden) {
    return conflict("That listing is already hidden", { code: "ALREADY_HIDDEN" })
  }
  if (action === "unhide" && !alreadyHidden) {
    return conflict("That listing is not hidden", { code: "NOT_HIDDEN" })
  }

  const now = new Date()

  // The column write and the audit row in ONE transaction. An audit row written
  // afterwards on its own connection is one that can fail to exist for a change
  // that did happen, and a moderation log with holes invites the reader to
  // trust the rows that are there.
  await prisma.$transaction(async (tx) => {
    await tx.item.update({
      where: { id },
      data: { moderationHiddenAt: action === "hide" ? now : null },
    })
    await writeAudit(tx, {
      actorId: actor.id,
      action: action === "hide" ? "LISTING_HIDDEN" : "LISTING_UNHIDDEN",
      targetType: "LISTING",
      targetId: id,
      reportId: reportId ?? null,
      reason,
      // The listing as it read at the moment of the takedown. The title in
      // particular: an owner who edits it afterwards would otherwise leave the
      // audit row pointing at an id and nothing a human recognises.
      detail: {
        title: item.title,
        ownerId: item.userId,
        // Recorded, never written. See the note above on why `status` is left
        // alone — this is here so an appeal can see what it was.
        statusAtAction: item.status,
        previousModerationHiddenAt: item.moderationHiddenAt,
      },
    })
  })

  return ok({
    listing: { id, moderationHiddenAt: action === "hide" ? now : null },
    audited: true,
  })
}
