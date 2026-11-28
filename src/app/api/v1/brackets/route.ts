import { resolveSession } from "@/lib/api-auth"
import { activeBracketScheme } from "@/lib/bracket-scheme"
import { BRACKET_COUNT, PREMIUM_MIN_BRACKET, bracketCeilings } from "@/lib/brackets"
import { ok, unauthenticated } from "@/lib/v1/envelope"

export const dynamic = "force-dynamic"

/**
 * GET /api/v1/brackets — the ACTIVE value-bracket table (28 Nov 2026).
 *
 * The limits are calculated by the system from Baylo's own listing values
 * (@/lib/bracket-math) and can change when a new scheme is applied, so the
 * app reads them here instead of hard-coding them. It keeps the last answer
 * on the phone and falls back to the hand-set table it ships with.
 *
 * `basis` is what the app can show to explain the table ("worked out from 210
 * listings on 1 Dec"): the method, how many listings, the anchors and the
 * average step. Nothing personal; only counts.
 *
 * Authenticated, like every other /api/v1 route.
 */
export async function GET() {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()

  const scheme = await activeBracketScheme()
  const stats = (scheme?.stats ?? null) as Record<string, unknown> | null
  return ok({
    ceilings: [...bracketCeilings()],
    count: BRACKET_COUNT,
    premiumMinBracket: PREMIUM_MIN_BRACKET,
    basis: {
      schemeId: scheme?.id ?? null,
      method: scheme?.method ?? "hand-set",
      activatedAt: scheme?.activatedAt?.toISOString() ?? null,
      sampleSize: scheme?.sampleSize ?? 0,
      stepRatio: typeof stats?.stepRatio === "number" ? stats.stepRatio : null,
      lowAnchor: typeof stats?.lowAnchor === "number" ? stats.lowAnchor : null,
      highAnchor: typeof stats?.highAnchor === "number" ? stats.highAnchor : null,
    },
  })
}
