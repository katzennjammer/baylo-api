import { fail } from "./envelope"

/**
 * A route handler that cannot answer in anything but the v1 envelope.
 *
 * An exception that escapes a route handler becomes Next's own 500, which is
 * not JSON. The phone's apiV1() can then only say that the path "did not return
 * JSON", and the person holding the phone learns nothing — not even whether
 * the tap took effect. This catches what escapes, logs it whole to the server
 * terminal, and answers INTERNAL_ERROR in the envelope instead.
 *
 * ── THE MESSAGE DOES NOT SAY "NOTHING CHANGED" ──────────────────────────────
 *
 * It cannot know. A throw after the write (the re-read in meetup/accept, say)
 * leaves the write committed and the caller holding a 500. The honest advice
 * is to look before trying again, and the routes this wraps are written to be
 * retried anyway.
 *
 * ── WHAT THIS DOES NOT CATCH ────────────────────────────────────────────────
 *
 * A request Next never routes to the handler: the HTML 404 a stale `.next`
 * answered for meetup/accept on 9 Oct 2026. Only the client can cover that.
 */
export function withJsonErrors<A extends unknown[]>(
  label: string,
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await handler(...args)
    } catch (err) {
      // The Error itself, not err.message: console.error prints the stack.
      console.error(`[${label}]`, err)
      return fail("INTERNAL_ERROR", "Something went wrong on our side. Refresh to check before trying again.")
    }
  }
}
