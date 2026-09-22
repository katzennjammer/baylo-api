import { NextRequest } from "next/server"
import { z } from "zod"
import prisma from "@/lib/prisma"
import { requireRole } from "@/lib/api-auth"
import { writeAudit } from "@/lib/moderation"
import { ok, notFound, conflict } from "@/lib/v1/envelope"
import { parseJsonBody } from "@/lib/v1/body"
import { destroyOrgDocument } from "@/lib/org-document"

export const dynamic = "force-dynamic"

/**
 * POST /api/admin/organizations/[id] — verify or reject one business document.
 *
 * The exact shape of /api/admin/id-verification/[id], deliberately, because it
 * is the same job on a different document and the two are worked from the same
 * queue. Read that route's header for the full reasoning; the two rules it
 * establishes hold here unchanged:
 *
 *   THE THREE THINGS THAT MOVE TOGETHER — the decision, the audit row and the
 *   notification, in ONE transaction. A decision without its audit row is
 *   indistinguishable from abuse, and a decision the applicant is never told
 *   about is one they discover by wondering why the badge never appeared.
 *
 *   AND THE ONE THAT DOES NOT — the Cloudinary destroy is after the commit. A
 *   decision must not fail because a third party is having a bad afternoon, so
 *   the commit nulls `businessDocUrl` (nothing can render it from that moment)
 *   while KEEPING `businessDocPublicId`, which is the delete key. A decided row
 *   with a non-null public id is exactly the retry set, which is what the
 *   @@index([verificationStatus, businessDocPublicId]) is for and what
 *   sweepUndeletedOrgDocuments() reads off the queue page.
 *
 * ── WHAT REJECTION DOES NOT DO ──────────────────────────────────────────────
 *
 * It does not delete the organisation, suspend it, or hide its listings. A
 * REJECTED org keeps trading exactly as a PENDING one does; what it loses is
 * the checkmark it never had. That is the whole difference between this gate
 * and the ID gate, and it is deliberate: an ID verifies a PERSON and unlocks
 * the right to post at all, while this verifies a CLAIM ABOUT A BUSINESS and
 * unlocks a badge. Refusing a badge is not grounds to take away an account,
 * and a rejection that silently removed somebody's livelihood because a
 * photograph of a permit was blurry would be a far worse error than a missing
 * checkmark.
 *
 * There is no attempt cap for the same reason. An applicant may fix the photo
 * and ask again; nothing is at stake that a cap would protect.
 */

export const ORG_REJECTION_REASONS = [
  "BLURRY_DOCUMENT",
  "NAME_MISMATCH",
  "EXPIRED_REGISTRATION",
  "WRONG_DOCUMENT_TYPE",
  "NOT_A_BUSINESS_DOCUMENT",
] as const

export type OrgRejectionReason = (typeof ORG_REJECTION_REASONS)[number]

export const ORG_REJECTION_LABEL: Record<OrgRejectionReason, string> = {
  BLURRY_DOCUMENT: "Too blurry to read",
  NAME_MISMATCH: "Name does not match the account",
  EXPIRED_REGISTRATION: "Registration has expired",
  WRONG_DOCUMENT_TYPE: "Not a document we accept",
  NOT_A_BUSINESS_DOCUMENT: "Not a business document",
}

/**
 * What the applicant is told, per reason. The FIX, not the verdict.
 *
 * Same rule as REJECTION_FIX next door: "rejected" tells somebody nothing they
 * can act on, and the entire value of a closed reason list is that each value
 * maps to a sentence describing what to do about it.
 */
export const ORG_REJECTION_FIX: Record<OrgRejectionReason, string> = {
  BLURRY_DOCUMENT:
    "We could not read your business document. Retake the photo in good light with the whole page in frame.",
  NAME_MISMATCH:
    "The name on the document does not match your organisation's name on Baylo. Update one to match the other and send it again.",
  EXPIRED_REGISTRATION:
    "That registration has expired. Send a current DTI/SEC registration or barangay permit.",
  WRONG_DOCUMENT_TYPE:
    "We accept a DTI or SEC registration, or a barangay business permit. Send one of those.",
  NOT_A_BUSINESS_DOCUMENT:
    "That does not look like a business document. Send your DTI/SEC registration or barangay permit.",
}

const decisionSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("verify"),
    // REQUIRED, and not defaulted, matching AdminAction.reason. An optional
    // reason is a reason nobody fills in.
    reason: z.string().trim().min(3).max(500),
  }),
  z.strictObject({
    decision: z.literal("reject"),
    reason: z.string().trim().min(3).max(500),
    rejectionReason: z.enum(ORG_REJECTION_REASONS),
  }),
])

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // ADMIN, matching every other route under /api/admin. MODERATOR exists in
  // the Role enum but was removed from the runtime checks (e8dfd3f) and
  // ROLE_RANK does not map it, so naming it here would not compile and would
  // not mean anything if it did.
  const gate = await requireRole("ADMIN")
  if (gate.response) return gate.response
  const actor = gate.actor

  const { id } = await params

  const parsedBody = await parseJsonBody(req, decisionSchema)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data

  const row = await prisma.organization.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      orgUserId: true,
      verificationStatus: true,
      businessDocPublicId: true,
      members: {
        where: { role: "OWNER", status: "ACTIVE" },
        select: { userId: true },
      },
    },
  })
  if (!row) return notFound("Organisation not found")

  // Conditional on still being PENDING, so two moderators opening the same row
  // produce one decision and one conflict rather than two audit rows that
  // disagree. The same guard the ID route uses.
  if (row.verificationStatus !== "PENDING") {
    return conflict(`This organisation has already been ${row.verificationStatus.toLowerCase()}.`)
  }

  const verify = body.decision === "verify"
  const now = new Date()

  const moved = await prisma.$transaction(async (tx) => {
    const updated = await tx.organization.updateMany({
      where: { id, verificationStatus: "PENDING" },
      data: {
        verificationStatus: verify ? "VERIFIED" : "REJECTED",
        rejectionReason: verify ? null : body.rejectionReason,
        reviewedById: actor.id,
        reviewedAt: now,
        // Nulled in the transaction: nothing may render the document from the
        // moment the decision commits, and that must not wait on a network
        // call. The public id SURVIVES — it is the delete key. See the header.
        businessDocUrl: null,
      },
    })
    if (updated.count !== 1) return false

    await writeAudit(tx, {
      actorId: actor.id,
      action: verify ? "ORGANIZATION_VERIFIED" : "ORGANIZATION_REJECTED",
      targetType: "ORGANIZATION",
      targetId: row.id,
      reason: body.reason,
      detail: {
        organizationName: row.name,
        orgUserId: row.orgUserId,
        ...(verify ? {} : { rejectionReason: body.rejectionReason }),
      },
    })

    // EVERY ACTIVE OWNER IS TOLD, not just the founder. An organisation can
    // have several owners and any of them may be the one watching for this;
    // notifying only the row that happens to be first is how a decision goes
    // unnoticed for a week.
    //
    // The notification goes to the HUMAN owners, never to the org's backing
    // row: nobody reads that account's notifications because nobody can log
    // into it.
    //
    // No `actorId` — the applicant must not learn which moderator handled it,
    // the same call the ID route and resolveReport() both make.
    if (row.members.length > 0) {
      await tx.notification.createMany({
        data: row.members.map((m) => ({
          userId: m.userId,
          // REUSES the ID verification notification types rather than adding a
          // pair of its own. They are the right shape -- "your document was
          // approved/refused, here is what it unlocks or how to fix it" -- and
          // the alternative was two more NotificationType values that would
          // have had to land on main in their own migration before anything
          // could write them. The message and the entityType say which
          // document this was about.
          type: verify
            ? ("ID_VERIFICATION_APPROVED" as const)
            : ("ID_VERIFICATION_REJECTED" as const),
          message: verify
            ? `${row.name} is now a verified organisation. The badge is on your profile.`
            : ORG_REJECTION_FIX[body.rejectionReason],
          entityType: "organization",
          entityId: row.id,
          link: `/admin/organizations/${row.id}`,
        })),
      })
    }

    return true
  })

  if (!moved) {
    return conflict("Somebody else decided this one first.")
  }

  // ── Outside the transaction, on purpose. See the header. ───────────────────

  let documentDeleted = false
  if (row.businessDocPublicId) {
    documentDeleted = await destroyOrgDocument(row.businessDocPublicId)
    await prisma.organization.update({
      where: { id: row.id },
      data: documentDeleted
        ? { businessDocPublicId: null, docDeletedAt: new Date(), docDeleteFailedAt: null }
        : { docDeleteFailedAt: new Date() },
    })
    if (!documentDeleted) {
      console.error(
        `[organizations] document destroy failed for ${row.id}; left for sweepUndeletedOrgDocuments()`,
      )
    }
  }

  return ok({
    id: row.id,
    verificationStatus: verify ? "VERIFIED" : "REJECTED",
    rejectionReason: verify ? null : body.rejectionReason,
    documentDeleted,
  })
}
