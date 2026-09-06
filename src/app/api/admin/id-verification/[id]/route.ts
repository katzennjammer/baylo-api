import { NextRequest } from "next/server"
import { z } from "zod"
import prisma from "@/lib/prisma"
import { requireRole } from "@/lib/api-auth"
import { writeAudit } from "@/lib/moderation"
import { ok, notFound, conflict, forbidden } from "@/lib/v1/envelope"
import { parseJsonBody } from "@/lib/v1/body"
import {
  ID_TYPE_LABEL,
  MAX_ID_SUBMISSIONS,
  hashIdNumber,
  REJECTION_FIX,
  REJECTION_LABEL,
  REJECTION_REASONS,
  selfReviewAllowed,
  toDbRejectionReason,
  toWireIdType,
  type RejectionReasonWire,
} from "@/lib/id-verification"
import { destroyIdImage } from "@/lib/id-verification-image"

export const dynamic = "force-dynamic"

/**
 * POST /api/admin/id-verification/[id] — approve or reject one submission.
 *
 * ── THE THREE THINGS THAT MOVE TOGETHER ─────────────────────────────────────
 *
 * In ONE transaction: the decision, the audit row, and the notification to the
 * submitter. Same rule as resolveReport() next door, and for the same reason —
 * a decision without its audit row is indistinguishable from abuse, and a
 * decision the submitter is never told about is a decision they discover by
 * tapping Post again three days later.
 *
 * ── AND THE ONE THING THAT DOES NOT ─────────────────────────────────────────
 *
 * The Cloudinary destroy is OUTSIDE the transaction and AFTER the commit, and
 * the spec is explicit about why: a decision must not fail because a third
 * party is having a bad afternoon. So the ordering is
 *
 *   1  commit the decision, nulling `imageUrl` so nothing can render the image
 *      from this moment on, and KEEPING `imagePublicId`, which is the delete key
 *   2  ask Cloudinary to destroy it
 *   3  on success null the publicId and stamp imageDeletedAt;
 *      on failure stamp imageDeleteFailedAt and leave the key in place
 *
 * A decided row with a non-null `imagePublicId` is therefore exactly the set of
 * images that still need destroying — including the ones lost to the process
 * dying between steps 1 and 3 — and sweepUndeletedIdImages() retries them off
 * the queue page. No side table, no queue, no cron; the row already says it.
 *
 * Doing the destroy FIRST and the transaction second would be the tempting
 * ordering and it is worse: a destroy that succeeds against a transaction that
 * then rolls back leaves a PENDING submission whose image is gone, which no
 * reviewer can ever act on.
 */

/**
 * APPROVING REQUIRES THE REVIEWER TO TYPE THE NUMBER THEY CAN READ ON THE ID,
 * and this is the resolution of the one place the spec contradicted itself.
 *
 * It asked for two things that cannot both be true: the ID number is stored
 * hashed and never in plaintext, AND the review screen shows the submitted
 * number. There is no way to display a number nobody kept.
 *
 * Storing the plaintext until the decision — the same lifecycle as the image —
 * would satisfy both sentences and was rejected: "never plaintext" is the load-
 * bearing sentence of the whole retention rule, and a column that holds real ID
 * numbers for a day at a time is still a column that holds real ID numbers when
 * the backup runs.
 *
 * But simply dropping the display leaves a real hole, and it is worth naming
 * because it is not obvious: the uniqueness constraint is on the number the
 * SUBMITTER TYPED, not on the document in the photo. If nobody ever compares
 * the two, one physical ID can verify unlimited accounts — upload the same
 * photo, type a different number each time, and every submission is unique to
 * the index and identical to the reviewer.
 *
 * So the comparison moves to the reviewer, in the direction that needs no
 * storage: they read the number off the photo, type it, and the server hashes
 * what they typed and checks it against the digest the submitter produced. A
 * match proves the submitter typed the number on the document they uploaded. A
 * mismatch means the two disagree, which is a rejection. Nothing is stored
 * either way, and the constraint is now anchored to a document a human looked
 * at rather than to a string somebody chose.
 *
 * Rejecting needs no number: you do not have to read a blurry photo to know it
 * is blurry.
 */
const decisionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("approve"),
    /** The number as the REVIEWER reads it on the ID. Checked, never stored. */
    idNumber: z.string().trim().min(1).max(64),
    /** Optional. The decision itself is the reason; see composeReason(). */
    note: z.string().trim().max(1000).optional(),
  }),
  z.strictObject({
    action: z.literal("reject"),
    reason: z.enum(REJECTION_REASONS),
    note: z.string().trim().max(1000).optional(),
  }),
])

/**
 * The audit row's `reason`, composed rather than typed.
 *
 * THIS IS THE ONE MODERATION ROUTE THAT DOES NOT DEMAND FREE TEXT, and the
 * departure is deliberate. Elsewhere — a takedown, a suspension — only prose
 * can say which listing and why, so ModerationActions disables its buttons
 * until a reason is typed. Here the vocabulary IS the reason: "blurry photo" is
 * the complete and exact account of the decision, it is what the submitter is
 * told, and a free-text box would let a tired reviewer type "no" at 1am and
 * burn one of the three attempts a real person gets.
 *
 * A note may still be added and is appended when it is. The composed part is
 * never absent, so AdminAction.reason is never empty and never a shrug.
 */
function composeReason(
  input:
    | { action: "approve"; note?: string }
    | { action: "reject"; reason: RejectionReasonWire; note?: string },
  ctx: { idType: string; attemptCount: number },
): string {
  const head =
    input.action === "approve"
      ? `Approved: ${ID_TYPE_LABEL[toWireIdType(ctx.idType)]}, attempt ${ctx.attemptCount} of ${MAX_ID_SUBMISSIONS}.`
      : `Rejected: ${REJECTION_LABEL[input.reason]} (${ID_TYPE_LABEL[toWireIdType(ctx.idType)]}, attempt ${ctx.attemptCount} of ${MAX_ID_SUBMISSIONS}).`
  return input.note ? `${head} ${input.note}` : head
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireRole("MODERATOR")
  if (gate.response) return gate.response
  const actor = gate.actor

  const { id } = await ctx.params

  const parsed = await parseJsonBody(req, decisionSchema)
  if (!parsed.ok) return parsed.response
  const body = parsed.data

  const row = await prisma.idVerification.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      idType: true,
      idNumberHash: true,
      status: true,
      attemptCount: true,
      imagePublicId: true,
      user: { select: { id: true, name: true } },
    },
  })
  // 403, not 404, throughout the /api/admin tree — there is no row here whose
  // existence is a secret, and requireRole() has already established that this
  // caller is staff. See the note on requireRole().
  if (!row) return notFound("No such ID submission")

  if (row.status !== "PENDING") {
    return conflict(`That submission is already ${row.status.toLowerCase()}.`, {
      status: row.status,
    })
  }

  // Separation of duties, relaxed in development only.
  //
  // In production a moderator who can approve their own ID can approve a forged
  // one, and the audit row would faithfully record them doing it. In
  // development one person is the user, the reviewer and the admin, and
  // forbidding this means keeping two accounts open to test one screen — which
  // is what the spec asked to avoid.
  if (row.userId === actor.id && !selfReviewAllowed()) {
    return forbidden(
      "You cannot decide your own ID submission. Ask another moderator.",
      { rule: "ID_VERIFICATION_SELF_REVIEW" },
    )
  }

  const approve = body.action === "approve"

  // The number check. See the long note on decisionSchema: this is what ties
  // the uniqueness constraint to the document in the photo rather than to a
  // string the submitter chose, and it does it without storing anything.
  //
  // A 409 rather than a 400: the request is well-formed and the reviewer is
  // allowed — the two values simply disagree, which is a fact about the
  // submission and not about the request. The moderator's next move is to
  // reject it, and the message says so.
  if (approve && hashIdNumber(body.idNumber) !== row.idNumberHash) {
    return conflict(
      "That is not the number this user submitted. If the ID in the photo does not match what they typed, reject it — \"Not one of the accepted ID types\" is the wrong reason; use the note to say what you saw.",
      { rule: "ID_NUMBER_MISMATCH" },
    )
  }

  const now = new Date()
  const reason = composeReason(body, { idType: row.idType, attemptCount: row.attemptCount })

  // How many tries they have left AFTER this rejection. Computed before the
  // write so the notification can say it, and from a count rather than from
  // attemptCount — the column is a snapshot and the count is the truth.
  const used = await prisma.idVerification.count({ where: { userId: row.userId } })
  const remaining = Math.max(0, MAX_ID_SUBMISSIONS - used)

  await prisma.$transaction(async (tx) => {
    await tx.idVerification.update({
      where: { id: row.id },
      data: {
        status: approve ? "APPROVED" : "REJECTED",
        rejectionReason: approve ? null : toDbRejectionReason(body.reason),
        reviewedById: actor.id,
        reviewedAt: now,
        // THE CLAIM, MOVED IN THE SAME STATEMENT AS THE STATUS. Never on its
        // own — the two coming apart is precisely the window in which an ID
        // reads as rejected while still holding its slot in the unique index,
        // and the person retaking their blurry photo gets told their own ID is
        // already registered.
        //
        //   approve  the claim STAYS. A suspended user must not be able to
        //            re-present the same ID on a fresh account.
        //   reject   the claim is FREED. A real person whose photo was too dark
        //            has to be able to send the same ID again.
        // `undefined` means "leave this column alone" to Prisma; `null` means
        // "write NULL". The two are not interchangeable here and the difference
        // is the whole rule.
        claimKey: approve ? undefined : null,
        // Nulled here and not after the destroy. The instant this commits,
        // nothing may render the image again — and that must not wait on a
        // network call. `imagePublicId` is deliberately left alone; it is the
        // delete key and the sweep's only handle on the file.
        imageUrl: null,
      },
    })

    // Same transaction as the change it describes. Always. If this throws, the
    // decision rolls back with it, which is the correct outcome — a moderation
    // log with holes in it invites the reader to trust the rows that are there.
    await writeAudit(tx, {
      actorId: actor.id,
      action: approve ? "ID_VERIFICATION_APPROVED" : "ID_VERIFICATION_REJECTED",
      targetType: "ID_VERIFICATION",
      targetId: row.id,
      reason,
      detail: {
        subjectUserId: row.userId,
        idType: toWireIdType(row.idType),
        attemptCount: row.attemptCount,
        ...(approve ? {} : { rejectionReason: body.reason, attemptsRemaining: remaining }),
        ...(row.userId === actor.id ? { selfReview: true } : {}),
      },
    })

    // The submitter is told, in the same transaction. A decision nobody is
    // notified of is one they find out about by tapping Post again next week.
    //
    // No `actorId`: the submitter must not learn which moderator handled it.
    // Same call resolveReport() makes, and for a stronger reason here — someone
    // whose forged ID was refused has no business being handed a name.
    await tx.notification.create({
      data: {
        userId: row.userId,
        type: approve ? "ID_VERIFICATION_APPROVED" : "ID_VERIFICATION_REJECTED",
        message: approve
          ? "Your ID was approved. You can post items and propose deferred agreements now."
          : remaining > 0
            ? `${REJECTION_FIX[(body as { reason: RejectionReasonWire }).reason]} You have ${remaining} of ${MAX_ID_SUBMISSIONS} attempts left.`
            : `${REJECTION_FIX[(body as { reason: RejectionReasonWire }).reason]} That was your last attempt — contact support to continue.`,
        link: "/dashboard",
        entityType: "id_verification",
        entityId: row.id,
      },
    })
  })

  // ── Outside the transaction, on purpose. See the header. ───────────────────

  let imageDeleted = false
  if (row.imagePublicId) {
    imageDeleted = await destroyIdImage(row.imagePublicId)
    await prisma.idVerification.update({
      where: { id: row.id },
      data: imageDeleted
        ? { imagePublicId: null, imageDeletedAt: new Date(), imageDeleteFailedAt: null }
        : { imageDeleteFailedAt: new Date() },
    })
    if (!imageDeleted) {
      // Logged loudly and left for the sweep. The decision has already
      // committed and is not being undone over this.
      console.error(
        `[id-verification] image destroy failed for submission ${row.id}; left for sweepUndeletedIdImages()`,
      )
    }
  }

  return ok({
    id: row.id,
    status: approve ? "APPROVED" : "REJECTED",
    rejectionReason: approve ? null : body.reason,
    reviewedAt: now,
    imageDeleted,
  })
}
