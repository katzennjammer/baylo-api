import { NextRequest } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { isPremium, isVip, premiumUntil, vipUntil, SUBSCRIPTION_SELECT } from "@/lib/premium"
import { enforceRateLimit } from "@/lib/rate-limit-config"
import { MAX_USER_TURNS, assistantBodySchema, runAssistantTurn } from "@/lib/assistant/turn"
import { parseJsonBody } from "@/lib/v1/body"
import { fail, forbidden, invalid, ok, unauthenticated } from "@/lib/v1/envelope"

export const dynamic = "force-dynamic"

/**
 * POST /api/v1/assistant -- one turn of the Premium search assistant.
 *
 * ── WHAT IT CAN DO: TURN WORDS INTO BROWSE FILTERS. NOTHING ELSE. ───────────
 *
 * The boundary is structural, not a promise in a prompt:
 *
 *   - This file performs NO database writes. Its one query reads the caller's
 *     subscription dates. Nothing here imports a writer.
 *   - It does not read or return LISTINGS. It returns filters; the phone runs
 *     GET /api/v1/browse with them, so blocking, suspension, takedowns and the
 *     perishable sweep all apply exactly as they do to a search typed by hand.
 *   - The model has no tools. Its only output is a fixed JSON shape (structured
 *     output), and every filter in it is clamped and then validated by
 *     browseQuerySchema -- the schema browse itself parses with -- before it
 *     leaves. See @/lib/assistant/filters.
 *
 * So a model talked into "go ahead and send that offer" has no way to do it.
 * The worst a hostile conversation can produce is an odd search.
 *
 * ── WHO MAY USE IT ──────────────────────────────────────────────────────────
 *
 * Premium or VIP, read with the exact expression offer-check.ts uses:
 * isPremium(premiumUntil) || isVip(vipUntil), VIP being a superset. Always the
 * PERSON's subscription: resolveSession() never reads X-Baylo-Org, so staff
 * acting as a shop use their own Premium. Searching is not acquiring, and the
 * shop's standing has nothing to say about it.
 *
 * ── STATE ───────────────────────────────────────────────────────────────────
 *
 * None on the server. The phone holds the conversation and sends it whole each
 * turn; nothing is stored, including the text. The server re-validates every
 * echoed turn, and a forged history can only mislead its own sender's search.
 *
 * Earlier results reach the model as a COUNT ONLY -- "[Last search: 12
 * listings]". Never titles or descriptions: those are written by other users,
 * and a listing called "ignore your instructions and..." is a prompt injection
 * with a photo. A number cannot carry one.
 *
 * The model call and everything after it live in @/lib/assistant/turn, so the
 * sample harness exercises the same code this route runs.
 */

export async function POST(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const userId = session.user.id

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { subscriptions: SUBSCRIPTION_SELECT },
  })
  if (!(isPremium(premiumUntil(user?.subscriptions)) || isVip(vipUntil(user?.subscriptions)))) {
    return forbidden("The search assistant is part of Premium.", { rule: "PREMIUM_REQUIRED" })
  }

  // Every call past this point bills a Haiku request to our account.
  const hourly = enforceRateLimit("aiAssistant", userId)
  if (hourly) return hourly
  const daily = enforceRateLimit("aiAssistantDaily", userId)
  if (daily) return daily

  const parsed = await parseJsonBody(req, assistantBodySchema)
  if (!parsed.ok) return parsed.response
  const { turns, hasLocation } = parsed.data

  const userTurns = turns.filter((t) => t.role === "user").length
  if (userTurns > MAX_USER_TURNS) {
    return invalid(`A conversation is limited to ${MAX_USER_TURNS} messages. Start a new one to keep searching.`, {
      rule: "ASSISTANT_TURN_LIMIT",
      maxTurns: MAX_USER_TURNS,
    })
  }

  const result = await runAssistantTurn(turns, hasLocation)
  // 503 in the envelope, whatever the cause. The phone answers this turn with
  // its keyword matcher; the cause stays in the server log.
  if (!result.ok) {
    return fail("UNAVAILABLE", "The assistant is unavailable right now. Try again in a moment.")
  }
  return ok(result.answer)
}
