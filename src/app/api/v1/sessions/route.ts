import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok, unauthenticated } from "@/lib/v1/envelope"
import { withJsonErrors } from "@/lib/v1/with-json-errors"

export const dynamic = "force-dynamic"

/**
 * GET /api/v1/sessions — the devices signed in to this account.
 *
 * A "session" is a refresh FAMILY: one sign-in on one device, and every token
 * rotated from it since. Its id is the familyId, which is what the access
 * token's `sid` names, so `isCurrent` is just "is this the family the caller's
 * own token came from".
 *
 * Both dates are derived, not stored. Every refresh writes a new row into the
 * family, so the oldest row's createdAt is when the device signed in and the
 * newest is when it last refreshed. That makes `lastActiveAt` "last refresh",
 * which lags real use by up to the access token's fifteen minutes.
 *
 * Live = still holding a row that is neither revoked nor expired. A family
 * revoked by a logout or a replay, or idle past thirty days, is not listed.
 *
 * Nothing about a token itself leaves this route: no hash, no expiry, no row id.
 */
export const GET = withJsonErrors("GET v1/sessions", listSessions)

async function listSessions() {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const userId = session.user.id

  const live = await prisma.authToken.findMany({
    where: { userId, type: "REFRESH", revokedAt: null, expiresAt: { gt: new Date() } },
    select: { familyId: true },
    distinct: ["familyId"],
  })
  const familyIds = live.map((r) => r.familyId).filter((f): f is string => f !== null)
  if (familyIds.length === 0) return ok({ sessions: [] })

  const spans = await prisma.authToken.groupBy({
    by: ["familyId"],
    where: { userId, type: "REFRESH", familyId: { in: familyIds } },
    _min: { createdAt: true },
    _max: { createdAt: true },
  })

  const sessions = spans
    .filter((s) => s.familyId !== null && s._min.createdAt && s._max.createdAt)
    .map((s) => ({
      id: s.familyId as string,
      signedInAt: (s._min.createdAt as Date).toISOString(),
      lastActiveAt: (s._max.createdAt as Date).toISOString(),
      isCurrent: s.familyId === session.sid,
    }))
    // This device first, then the most recently active.
    .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.lastActiveAt.localeCompare(a.lastActiveAt))

  return ok({ sessions })
}
