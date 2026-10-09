import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok, unauthenticated, notFound } from "@/lib/v1/envelope"
import { withJsonErrors } from "@/lib/v1/with-json-errors"

export const dynamic = "force-dynamic"

/**
 * DELETE /api/v1/sessions/[familyId] — sign one device out.
 *
 * Revokes the whole family, as POST /api/auth/revoke does, and the effect is
 * immediate: resolveSession() refuses an access token whose family has no
 * unrevoked row, so that device's very next request is a 401.
 *
 * Ownership is part of the UPDATE's WHERE, not a check before it, so there is
 * no window between "is it yours" and "revoke it". Someone else's family, a
 * made-up id and a family that is already signed out all touch zero rows and
 * all answer the same 404 -- see notFound() for why not 403.
 *
 * Revoking the caller's own family is allowed; it is a logout. The app offers
 * it only for other devices.
 */
export const DELETE = withJsonErrors("DELETE v1/sessions/[familyId]", revokeSession)

async function revokeSession(_req: Request, { params }: { params: Promise<{ familyId: string }> }) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const { familyId } = await params

  const notThere = () => notFound("That device is not signed in")
  if (!familyId || familyId.length > 64) return notThere()

  const res = await prisma.authToken.updateMany({
    where: { userId: session.user.id, type: "REFRESH", familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  if (res.count === 0) return notThere()

  return ok({ revoked: familyId })
}
