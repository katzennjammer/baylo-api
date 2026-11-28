import { NextRequest, NextResponse } from "next/server"
import { recalculateBrackets } from "@/lib/bracket-scheme"

export const dynamic = "force-dynamic"

/**
 * Monthly bracket recalculation, called by the Vercel cron in vercel.json
 * (04:00 UTC on the 1st, which is noon in the Philippines).
 *
 * Works out a new geometric table from live listing values
 * (recalculateBrackets() in @/lib/bracket-scheme) and records it as PROPOSED.
 * It is APPLIED (made active, every listing re-bracketed) only when the env var
 * BRACKET_AUTO_APPLY=1 is set, because app builds from before 28 Nov 2026
 * carry the hand-set table. Turn it on once the app build that reads
 * GET /api/v1/brackets is out. A table identical to the active one records
 * nothing.
 *
 * `?dryRun=1` calculates and answers without writing anything.
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET` when that env var is set;
 * without it the route refuses, as /api/cron/keepalive does.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1"
  const apply = process.env.BRACKET_AUTO_APPLY === "1"
  const result = await recalculateBrackets({ apply, dryRun })
  console.log("[brackets] monthly recalculation", JSON.stringify({ dryRun, apply, ...result }))
  return NextResponse.json({ ok: true, dryRun, autoApply: apply, result })
}
