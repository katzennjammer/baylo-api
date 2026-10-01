import { NextRequest } from "next/server"
import { z } from "zod"
import prisma from "@/lib/prisma"
import { requireRole } from "@/lib/api-auth"
import { writeAudit } from "@/lib/moderation"
import { ok, notFound, conflict } from "@/lib/v1/envelope"
import { parseJsonBody } from "@/lib/v1/body"
import { destroyOrgDocument } from "@/lib/org-document"
import { ORG_WELCOME_LEAVES } from "@/lib/task-constants"
import { ORG_REJECTION_FIX, ORG_REJECTION_REASONS } from "@/lib/organizations"

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
 * REJECTED org keeps trading exactly as a PENDING one does, and the listings
 * it already has stay up; what it loses is the checkmark it never had. That is the whole difference between this gate
 * and the ID gate, and it is deliberate: an ID verifies a PERSON and unlocks
 * the right to post at all, while this verifies a CLAIM ABOUT A BUSINESS and
 * unlocks a badge. Refusing a badge is not grounds to take away an account,
 * and a rejection that silently removed somebody's livelihood because a
 * photograph of a permit was blurry would be a far worse error than a missing
 * checkmark.
 *
 * There is no attempt cap for the same reason. An applicant may fix the photo
 * and ask again; nothing is at stake that a cap would protect.
 *
 * WHAT BOTH NON-VERIFIED STATES DO COST (24 Sep 2026): posting AS the org.
 * POST /api/items refuses a PENDING or REJECTED org outright, whatever the
 * staff member's own ID says. See orgPostingRefusal() in @/lib/organizations,
 * which is also where the reason vocabulary below now lives.
 */

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
    if (updated.count !== 1) return { moved: false as const, welcomeLeaves: 0 }

    // ── The verified-MSME welcome grant ─────────────────────────────────────
    //
    // To the ORG'S OWN balance, its backing User row, because that is the
    // account that lists and trades as the shop. Never to the owner who
    // happens to be watching: the business passed the review, not them.
    //
    // IN THIS TRANSACTION, with the status flip. A shop that shows the badge
    // but never got the grant, or got the grant for a decision that rolled
    // back, is exactly the drift one transaction rules out. And the balance
    // moves together with the ledger row that explains it, the same pairing
    // claimSignupGrant() in @/lib/verification uses, so SUM(User.leaves) still
    // equals SUM(LeafTransaction.amount).
    //
    // ONCE PER ORGANISATION, EVER. The PENDING-only update above already means
    // one decision per review, but nothing today stops a future resubmit path
    // from taking a REJECTED org back to PENDING and verifying it again. So the
    // guard is the ledger itself: an existing SIGNUP_GRANT row on the backing
    // row means it was paid. That row cannot come from the person-side grant,
    // because an org's backing row is created with signupGrantClaimed = true.
    // Concurrent approvals cannot both reach this line, because only one wins
    // the conditional update above.
    let welcomeLeaves = 0
    if (verify && ORG_WELCOME_LEAVES > 0) {
      const alreadyPaid = await tx.leafTransaction.findFirst({
        where: { userId: row.orgUserId, type: "SIGNUP_GRANT" },
        select: { id: true },
      })
      if (!alreadyPaid) {
        await tx.user.update({
          where: { id: row.orgUserId },
          data: {
            leaves: { increment: ORG_WELCOME_LEAVES },
            lifetimeLeaves: { increment: ORG_WELCOME_LEAVES },
          },
        })
        await tx.leafTransaction.create({
          data: {
            userId: row.orgUserId,
            type: "SIGNUP_GRANT",
            amount: ORG_WELCOME_LEAVES,
            description: "Verified MSME welcome grant",
            eventAt: now,
          },
        })
        welcomeLeaves = ORG_WELCOME_LEAVES
      }
    }

    await writeAudit(tx, {
      actorId: actor.id,
      action: verify ? "ORGANIZATION_VERIFIED" : "ORGANIZATION_REJECTED",
      targetType: "ORGANIZATION",
      targetId: row.id,
      reason: body.reason,
      detail: {
        organizationName: row.name,
        orgUserId: row.orgUserId,
        ...(verify ? { welcomeLeaves } : { rejectionReason: body.rejectionReason }),
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
            ? `${row.name} is now a verified organisation. The badge is on your profile` +
              (welcomeLeaves > 0 ? `, and ${welcomeLeaves} welcome Leaves are in the shop's balance.` : ".")
            : ORG_REJECTION_FIX[body.rejectionReason],
          entityType: "organization",
          entityId: row.id,
          link: `/admin/organizations/${row.id}`,
        })),
      })
    }

    return { moved: true as const, welcomeLeaves }
  })

  if (!moved.moved) {
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
    welcomeLeaves: moved.welcomeLeaves,
    documentDeleted,
  })
}
