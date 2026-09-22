import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { parseBody } from "@/lib/validation"
import { ok, unauthenticated, invalid, conflict, forbidden, notFound } from "@/lib/v1/envelope"
import { isOrgOwner } from "@/lib/organizations"

export const dynamic = "force-dynamic"

/**
 * /api/v1/organizations/[id]/members — the staff list, and invitations to it.
 *
 * ── ONLY AN OWNER MANAGES STAFF ─────────────────────────────────────────────
 *
 * This is the org-scoped mirror of the rule User.role's note sets out: the
 * ability to grant a permission is itself the permission worth attacking. A
 * STAFF member who could invite would be a STAFF member who could invite a
 * second account they control, and from there the organisation has as many
 * hands as the attacker wants. `isOrgOwner()` re-reads the row on every call
 * for the same reason the org context is a header rather than a token claim —
 * see the header of @/lib/organizations.
 *
 * ── AN INVITATION IS NOT A MEMBERSHIP ───────────────────────────────────────
 *
 * POST creates a PENDING row. It does not make anybody staff, and nothing in
 * the write paths treats PENDING as permission: `resolveActingIdentity()`
 * refuses it explicitly. The invited person accepts through PATCH, which is
 * the only thing that writes ACTIVE and the only thing that stamps `joinedAt`.
 *
 * That split is what stops an organisation adding someone's account to itself
 * without asking. An org is a public identity that posts and trades; being
 * silently made staff of one is being made to appear to endorse it.
 */

const inviteSchema = z.strictObject({
  /** The person to invite, by the email they signed up with. */
  email: z.string().trim().toLowerCase().email().max(200),
  role: z.enum(["OWNER", "STAFF"]).optional(),
})

/** GET — the staff list. Members only; an org's roster is not public. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const { id: organizationId } = await params

  const mine = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId: session.user.id } },
    select: { role: true, status: true },
  })
  // 404 rather than 403 for a non-member, matching the profile route: a 403
  // confirms the organisation exists to somebody with no business knowing.
  if (!mine || mine.status !== "ACTIVE") return notFound("Organisation not found")

  const members = await prisma.organizationMember.findMany({
    where: { organizationId },
    select: {
      id: true,
      role: true,
      status: true,
      invitedAt: true,
      joinedAt: true,
      user: { select: { id: true, name: true, avatar: true } },
    },
    orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
  })

  return ok({
    members: members.map((m) => ({
      membershipId: m.id,
      role: m.role,
      status: m.status,
      invitedAt: m.invitedAt,
      joinedAt: m.joinedAt,
      user: m.user,
    })),
    // STAFF COUNT, which is what the org profile renders where a person's
    // profile shows Followers/Following. ACTIVE only — a pending invitation is
    // not a member, and counting it would inflate the number on a public
    // profile with people who have not agreed to be there.
    staffCount: members.filter((m) => m.status === "ACTIVE").length,
    viewerRole: mine.role,
  })
}

/** POST — invite somebody. OWNER only. Creates a PENDING row, nothing more. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const { id: organizationId } = await params

  if (!(await isOrgOwner(prisma, organizationId, session.user.id))) {
    return forbidden("Only an owner can manage staff.")
  }

  const parsed = await parseBody(req, inviteSchema)
  if (!parsed.ok) return parsed.response

  const invitee = await prisma.user.findUnique({
    where: { email: parsed.data.email },
    select: { id: true, name: true, isOrgAccount: true, deletedAt: true },
  })
  // The same answer whether the address has no account or the account is gone.
  // Distinguishing them turns this endpoint into an oracle that answers "is
  // this email registered on Baylo?" for any address somebody cares to type.
  if (!invitee || invitee.deletedAt) {
    return notFound("No Baylo account uses that email address.")
  }
  // An organisation is not a member of itself, and not of another one either.
  if (invitee.isOrgAccount) {
    return invalid("That is an organisation account, not a person.")
  }

  // The @@unique([organizationId, userId]) makes a repeat invitation a no-op
  // rather than a second row. Reported as a conflict so the owner learns the
  // invitation is already out rather than clicking again and seeing success.
  const existing = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId: invitee.id } },
    select: { status: true },
  })
  if (existing) {
    return conflict(
      existing.status === "ACTIVE"
        ? `${invitee.name} is already on your staff.`
        : `${invitee.name} has already been invited and has not answered yet.`,
    )
  }

  const member = await prisma.organizationMember.create({
    data: {
      organizationId,
      userId: invitee.id,
      role: parsed.data.role ?? "STAFF",
      status: "PENDING",
    },
    select: { id: true, role: true, invitedAt: true },
  })

  return ok({
    membershipId: member.id,
    role: member.role,
    status: "PENDING",
    invitedAt: member.invitedAt,
    user: { id: invitee.id, name: invitee.name },
  })
}
