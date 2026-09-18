import { NextRequest } from "next/server"
import { z } from "zod"
import { requireRole } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { bracketOf } from "@/lib/brackets"
import type { ValueRejectionReason } from "@/generated/prisma/client"
import { ok, notFound, conflict, invalid } from "@/lib/v1/envelope"
import { parseJsonBody } from "@/lib/v1/body"
import { writeAudit } from "@/lib/moderation"
import {
  VALUE_REJECTION_REASON_CODES,
  VALUE_REJECTION_NOTE_MAX,
  valueRejectionSentence,
} from "@/lib/value-rejection"

export const dynamic = "force-dynamic"

/**
 * POST /api/admin/listings/[id] — hide or restore a listing; approve or
 * reject a value review.
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
  /**
   * Required for everything except reject-value, which takes a code and an
   * optional note instead -- see below. Checked after parsing rather than
   * with a discriminated union so that the error for a missing reason reads
   * the same on every action.
   */
  reason: z.string().trim().min(1).max(1000).optional(),
  /**
   * reject-value only. The owner is shown THIS -- one of a closed list of
   * sentences this codebase wrote -- and never `note`, which is the
   * moderator's own words and goes to the audit row alone.
   */
  reasonCode: z.enum(VALUE_REJECTION_REASON_CODES as [string, ...string[]]).optional(),
  note: z.string().trim().max(VALUE_REJECTION_NOTE_MAX).optional(),
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
  const { action, reportId } = parsed.data

  // The audit row's `reason`. For reject-value it is assembled from the code
  // and the note so that the log reads "ABOVE_MARKET: three comparables at
  // 300" rather than a bare code; for everything else it is what was typed.
  let reason: string
  if (action === "reject-value") {
    if (!parsed.data.reasonCode) {
      return invalid("A reason is required — pick one from the list", { field: "reasonCode" })
    }
    reason = parsed.data.note
      ? `${parsed.data.reasonCode}: ${parsed.data.note}`
      : parsed.data.reasonCode
  } else {
    if (!parsed.data.reason) {
      return invalid("A reason is required — it is written to the audit log", { field: "reason" })
    }
    reason = parsed.data.reason
  }

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
   * The listing moves to VALUE_REJECTED -- still visible to nobody but the
   * owner, but no longer in the admin queue, because "waiting for the owner"
   * and "waiting for an admin" are different rows to everyone who filters --
   * the owner is told WHICH reason (the code, never the note), and they
   * choose: relist at the suggestion, edit the value back inside the cap
   * (PATCH /api/items/[id], which moves it to AVAILABLE by itself), or delete
   * it. Or appeal, which is the one path that can publish it at the value
   * they asked for without them touching it.
   *
   * Both decisions are conditional on PENDING_REVIEW. A second reject on an
   * already-rejected listing is a 409, not a second notification (it was, until
   * 18 Sep 2026).
   */
  if (action === "approve-value" || action === "reject-value") {
    if (item.status !== "PENDING_REVIEW") {
      return conflict("That listing is not waiting on a value review", { code: "NOT_IN_REVIEW" })
    }

    const approved = action === "approve-value"
    const reasonCode = (parsed.data.reasonCode ?? null) as ValueRejectionReason | null
    const approve = await prisma.$transaction(async (tx) => {
      // Conditional on the status we read, so two reviewers clicking at once
      // produce one decision and one 409.
      const moved = await tx.item.updateMany({
        where: { id, status: "PENDING_REVIEW" },
        data: approved
          ? { status: "AVAILABLE", valueRejectionReason: null }
          : { status: "VALUE_REJECTED", valueRejectionReason: reasonCode },
      })
      if (moved.count !== 1) return false

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
          ...(approved ? {} : { reasonCode, note: parsed.data.note ?? null }),
        },
      })

      // NO `actorId`. The mobile list renders `${actor.name} ${message}`, so
      // an actor here put the reviewing moderator's name and face in front of
      // the owner -- the thing ID verification and report resolution both
      // refuse to do. The decision is the system's; the reason is the code's
      // sentence; the person is nobody's business.
      //
      // entityType "listing_review", not "item": the client routes on this
      // pair and has no screen that takes an item id from a notification. The
      // review screen is the one place a rejected or waiting listing can be
      // opened from.
      await tx.notification.create({
        data: {
          userId: item.userId,
          type: approved ? "LISTING_VALUE_APPROVED" : "LISTING_VALUE_REJECTED",
          message: approved
            ? `"${item.title}" is live at ${(item.valueLeaves ?? 0).toLocaleString("en-US")} Leaves — the value you asked for was approved.`
            : `"${item.title}" was not approved at ${(item.valueLeaves ?? 0).toLocaleString("en-US")} Leaves. ${valueRejectionSentence(reasonCode)} Open it to list at the suggested ${(item.suggestedLeaves ?? 0).toLocaleString("en-US")}, set a value within one bracket of that, delete it, or appeal.`,
          entityType: "listing_review",
          entityId: id,
        },
      })
      return true
    })

    if (!approve) return conflict("That review was just decided by someone else")

    return ok({
      listing: {
        id,
        status: approved ? "AVAILABLE" : "VALUE_REJECTED",
        valueLeaves: item.valueLeaves,
        suggestedLeaves: item.suggestedLeaves,
        valueRejectionReason: approved ? null : reasonCode,
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

    // The owner is told about a takedown -- until 18 Sep 2026 they were not,
    // and what they saw instead was a tile on their own shelf that 404ed when
    // opened. No reason (the takedown's reason is the audit row's, as it
    // always was) and no actor, for the reasons given on the value review
    // above. The review screen the notification opens explains what a
    // takedown is and offers the appeal.
    //
    // A restore sends nothing. The owner asked for nothing; the listing is
    // simply back, and "your listing is visible again" would be the only
    // notification in the app that announces the absence of a problem.
    if (action === "hide") {
      await tx.notification.create({
        data: {
          userId: item.userId,
          type: "LISTING_HIDDEN",
          message: `"${item.title}" was hidden by a moderator. Nobody else can see it. Open it to read what that means and to appeal.`,
          entityType: "listing_review",
          entityId: id,
        },
      })
    }
  })

  return ok({
    listing: { id, moderationHiddenAt: action === "hide" ? now : null },
    audited: true,
  })
}
