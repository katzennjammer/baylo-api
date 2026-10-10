import { resolveSession } from "@/lib/api-auth"
import { revokeUserFamilies } from "@/lib/auth-tokens"
import { ok, unauthenticated, conflict } from "@/lib/v1/envelope"
import { withJsonErrors } from "@/lib/v1/with-json-errors"

export const dynamic = "force-dynamic"

/**
 * POST /api/v1/sessions/revoke-others — "Log out all other devices".
 *
 * Revokes every live family the caller has except the one their own access
 * token names (`sid`). Each of those devices gets a 401 on its next request.
 *
 * REFUSED WITHOUT A `sid`, rather than read as "keep nothing". A token minted
 * before `sid` existed, or the web cookie session, cannot say which family is
 * this device, and revoking all of them would sign out the phone that tapped
 * the button. A pre-`sid` token is at most fifteen minutes old; the app's next
 * refresh replaces it with one that has a `sid`.
 */
export const POST = withJsonErrors("POST v1/sessions/revoke-others", revokeOthers)

async function revokeOthers() {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  if (!session.sid) {
    return conflict("This device could not be identified. Try again in a few minutes.", { rule: "NO_SESSION_ID" })
  }

  // No count in the answer: revokeUserFamilies() counts token ROWS, and a
  // family holds one row per refresh, so the number would not be "devices".
  // The app re-reads GET /api/v1/sessions instead.
  await revokeUserFamilies(session.user.id, session.sid)
  return ok({ kept: session.sid })
}
