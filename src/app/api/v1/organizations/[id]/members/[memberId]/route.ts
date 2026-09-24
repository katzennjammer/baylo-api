import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { parseBody } from "@/lib/validation"
import { ok, unauthenticated, invalid, conflict, forbidden, notFound } from "@/lib/v1/envelope"
import { isOrgOwner } from "@/lib/organizations"

export const dynamic = "force-dynamic"

/**
 * /api/v1/organizations/[id]/members/[memberId] — accept, change, remove.
 *
 * ── TWO CALLERS WITH DIFFERENT RIGHTS, ON ONE ROW ───────────────────────────
 *
 *   the INVITED PERSON   may accept or decline their own invitation, and
 *                        may leave. Nothing else. They may not promote themselves, and
 *                        they may not touch anyone else's row.
 *   an OWNER             may change a role and may remove anybody. May not
 *                        accept an invitation on somebody's behalf — that is
 *                        the whole point of the PENDING state.
 *
 * Both are checked against the ROW rather than against a remembered claim, on
 * every call. See the header of @/lib/organizations.
 *
 * ── AN ORGANISATION MUST KEEP AN OWNER ──────────────────────────────────────
 *
 * The last ACTIVE OWNER cannot be demoted or removed, by anybody including
 * themselves. An organisation with no owner is one whose staff can never be
 * changed again and whose settings can never be edited — it is not a recoverable
 * state through any endpoint here, and the account cannot log in to fix it
 * because it has no password. Refused rather than repaired.
 */

const patchSchema = z.strictObject({
  /** The invited person answering, or leaving. The only values they may send. */
  action: z.enum(["accept", "decline", "leave"]).optional(),
  /** An owner changing a role. */
  role: z.enum(["OWNER", "STAFF"]).optional(),
})

/**
 * The ORG_INVITE notification for this membership, once the invitation is
 * answered or withdrawn. Left in place it would open Settings onto an
 * invitation that is no longer there -- the dead-end tap the notification
 * exists to avoid. Keyed on the "org_invite" token alone, which nothing else
 * writes -- NOT on `type`, because comparing against 'ORG_INVITE' is an
 * error on a database that has not taken 20260925000001 yet, and that would
 * turn every accept, decline and withdrawal into a 500.
 */
function clearInviteNotification(memberId: string) {
  return prisma.notification.deleteMany({
    where: { entityType: "org_invite", entityId: memberId },
  })
}

async function activeOwnerCount(organizationId: string, excludingMemberId?: string) {
  return prisma.organizationMember.count({
    where: {
      organizationId,
      role: "OWNER",
      status: "ACTIVE",
      ...(excludingMemberId ? { id: { not: excludingMemberId } } : {}),
    },
  })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> },
) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const viewerId = session.user.id
  const { id: organizationId, memberId } = await params

  const member = await prisma.organizationMember.findUnique({
    where: { id: memberId },
    select: { id: true, organizationId: true, userId: true, role: true, status: true },
  })
  // The row must belong to the organisation in the path. Without this check the
  // id in the URL is decorative and any membership anywhere could be edited by
  // anyone who owns any organisation.
  if (!member || member.organizationId !== organizationId) return notFound("Membership not found")

  const parsed = await parseBody(req, patchSchema)
  if (!parsed.ok) return parsed.response
  const { action, role } = parsed.data
  if (!action && !role) return invalid("Send an action or a role.")
  if (action && role) return invalid("Send an action or a role, not both.")

  // ── The invited person's own two verbs ────────────────────────────────────
  if (action) {
    if (member.userId !== viewerId) {
      return forbidden("You can only accept or leave your own membership.")
    }

    if (action === "accept") {
      if (member.status === "ACTIVE") return conflict("You are already on this staff.")
      // Conditional on still being PENDING, so an accept racing a withdrawal
      // does not resurrect a membership the owner has just removed.
      const updated = await prisma.organizationMember.updateMany({
        where: { id: memberId, status: "PENDING" },
        data: { status: "ACTIVE", joinedAt: new Date() },
      })
      if (updated.count !== 1) return conflict("That invitation is no longer open.")
      await clearInviteNotification(memberId)
      return ok({ membershipId: memberId, status: "ACTIVE" })
    }

    // Declining. Its own verb rather than "leave" on a PENDING row, so a
    // decline that races an accept on another device cannot delete the
    // membership the accept just made ACTIVE. A hard delete, like withdrawal:
    // a tombstone would block the org from ever asking again.
    if (action === "decline") {
      const declined = await prisma.organizationMember.deleteMany({
        where: { id: memberId, status: "PENDING" },
      })
      if (declined.count !== 1) return conflict("That invitation is no longer open.")
      await clearInviteNotification(memberId)
      return ok({ membershipId: memberId, removed: true })
    }

    // Leaving. An owner leaving is subject to the last-owner rule like any
    // other demotion -- see the header.
    if (member.role === "OWNER" && (await activeOwnerCount(organizationId, memberId)) === 0) {
      return conflict(
        "You are the only owner. Make somebody else an owner before you leave.",
        { rule: "ORG_LAST_OWNER" },
      )
    }
    await prisma.organizationMember.delete({ where: { id: memberId } })
    return ok({ membershipId: memberId, removed: true })
  }

  // ── An owner changing a role ──────────────────────────────────────────────
  if (!(await isOrgOwner(prisma, organizationId, viewerId))) {
    return forbidden("Only an owner can change roles.")
  }
  if (member.status !== "ACTIVE") {
    return conflict("That person has not accepted their invitation yet.")
  }
  if (role === member.role) return ok({ membershipId: memberId, role })

  if (
    member.role === "OWNER" &&
    role === "STAFF" &&
    (await activeOwnerCount(organizationId, memberId)) === 0
  ) {
    return conflict("An organisation needs at least one owner.", { rule: "ORG_LAST_OWNER" })
  }

  await prisma.organizationMember.update({ where: { id: memberId }, data: { role } })
  return ok({ membershipId: memberId, role })
}

/** DELETE — an owner removing somebody, or withdrawing an invitation. */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> },
) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const { id: organizationId, memberId } = await params

  const member = await prisma.organizationMember.findUnique({
    where: { id: memberId },
    select: { id: true, organizationId: true, role: true, status: true },
  })
  if (!member || member.organizationId !== organizationId) return notFound("Membership not found")

  if (!(await isOrgOwner(prisma, organizationId, session.user.id))) {
    return forbidden("Only an owner can remove staff.")
  }

  if (
    member.role === "OWNER" &&
    member.status === "ACTIVE" &&
    (await activeOwnerCount(organizationId, memberId)) === 0
  ) {
    return conflict("An organisation needs at least one owner.", { rule: "ORG_LAST_OWNER" })
  }

  // A hard delete, not a DECLINED tombstone. The @@unique([organizationId,
  // userId]) means a tombstone would permanently block re-inviting somebody
  // who once said no -- see the note on OrgMemberStatus.
  await prisma.organizationMember.delete({ where: { id: memberId } })
  if (member.status === "PENDING") await clearInviteNotification(memberId)
  return ok({ membershipId: memberId, removed: true })
}
