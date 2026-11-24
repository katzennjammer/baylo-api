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

/**
 * Claude Haiku 5.5 (5 Nov 2026; was Haiku 4.5). The current Haiku, about a
 * tenth of Haiku 4.5's per-token price at Baylo's prompt sizes, and better at
 * following instructions and at using search.
 *
 * Two Haiku 5.5 rules every caller follows: no `temperature` / `top_p` /
 * `top_k` (non-default values are a 400), and thinking is ON unless turned
 * off. Every Baylo call is a short structured answer on a small max_tokens,
 * so each passes NO_THINKING; left on, thinking would spend that budget.
 */
export const HAIKU_MODEL = "claude-haiku-5-5"

/**
 * Claude Sonnet 5.5, for the online price check ONLY (5 Nov 2026). It gets
 * the newer web search (filters results) and web fetch (opens the shop page
 * to read the price), which Haiku does not, and finding a real price is the
 * whole job of that call. About 20x Haiku 5.5's per-token price, so it is
 * not used anywhere else.
 */
export const SONNET_MODEL = "claude-sonnet-5-5"

/** Thinking off, for Baylo's short structured calls. See HAIKU_MODEL. */
export const NO_THINKING = { type: "disabled" } as const

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
