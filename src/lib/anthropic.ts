import Anthropic from "@anthropic-ai/sdk"

/**
 * The one Anthropic client, and the one model id, for every route that calls
 * Claude.
 *
 * ── WHY ONE ─────────────────────────────────────────────────────────────────
 *
 * Every call is billed to the same account, so the model id is a cost decision
 * and not a per-route detail. Two routes that each spelled out
 * "claude-haiku-4-5-20251001" were two places a later edit could quietly move
 * one surface to a model ten times the price.
 *
 * /api/ai/identify and /api/ai/phash still construct their own client and name
 * the model inline. They move here in a follow-up commit: the dev server was
 * mid-test against live when this landed, and a hot reload of the image-ID
 * route was not worth the tidiness.
 *
 * ── LAZY, NOT AT IMPORT ─────────────────────────────────────────────────────
 *
 * `new Anthropic()` reads ANTHROPIC_API_KEY when it is constructed. Built on
 * first use, a missing key surfaces as that request's failure -- which the
 * caller already handles as "assistant unavailable" -- rather than as a module
 * that cannot be imported.
 */

/** Haiku 4.5, the tier image identification already runs on. */
export const HAIKU_MODEL = "claude-haiku-4-5-20251001"

let client: Anthropic | null = null

export function anthropic(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      // Presence only -- never any part of the key.
      console.warn("[anthropic] ANTHROPIC_API_KEY is not set; Claude calls will fail")
    }
    client = new Anthropic({
      // One retry, not the SDK's two: a person is waiting on the other end,
      // and three attempts at a 20-second timeout is a minute of spinner.
      maxRetries: 1,
      timeout: 20_000,
    })
  }
  return client
}
