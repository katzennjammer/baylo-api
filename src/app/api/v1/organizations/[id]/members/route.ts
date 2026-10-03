import { NextRequest } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok, unauthenticated, notFound, gone } from "@/lib/v1/envelope"
import { STAFF_REMOVED_MESSAGE } from "@/lib/org-staff"

export const dynamic = "force-dynamic"

/**
 * /api/v1/organizations/[id]/members -- ORGANISATION STAFF WERE REMOVED in
 * schema v2. An organisation has exactly one person behind it, its owner
 * (Organization.ownerId), who posts, trades and chats as the shop.
 *
 * GET stays, in the shape it always had, because shipped APKs open a staff
 * list from Settings: it returns the owner as the only member. Inviting is
 * GONE (410, the v1/contracts convention): shipped builds still have the
 * button, and a 404 would read as "wrong URL" and invite a retry that can
 * never work.
 */

/** GET -- the owner, as the one-member list. Owner only; a roster is not public. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const { id: organizationId } = await params

  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, ownerId: true, ownerJoinedAt: true, owner: { select: { id: true, name: true, avatar: true } } },
  })
  // 404 rather than 403 for anyone but the owner, matching the profile route:
  // a 403 confirms the organisation exists to somebody with no business knowing.
  if (!org || org.ownerId !== session.user.id) return notFound("Organisation not found")

  return ok({
    members: [
      {
        // There is no membership row any more; the organisation's id stands in.
        membershipId: org.id,
        role: "OWNER",
        status: "ACTIVE",
        invitedAt: org.ownerJoinedAt,
        joinedAt: org.ownerJoinedAt,
        user: org.owner,
      },
    ],
    staffCount: 1,
    viewerRole: "OWNER",
  })
}

/** POST -- inviting staff. Gone. */
export async function POST() {
  return gone(STAFF_REMOVED_MESSAGE, { since: "schema-v2" })
}
