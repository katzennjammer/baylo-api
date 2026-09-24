import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok, unauthenticated } from "@/lib/v1/envelope"
import { evaluateAchievements } from "@/lib/achievements"

export const dynamic = "force-dynamic"

/** The profile shelf holds four badges. Featured (home) holds one. */
export const MAX_PROFILE_BADGES = 4
/**
 * GET /api/v1/achievements -- the user's shelf, with real progress.
 *
 * This used to read the tables with raw SQL and hard-code `progress: 0`, so a
 * locked badge said "0 of 5" no matter what the user had done. The evaluation
 * now decides progress and grants anything newly earned -- see
 * @/lib/achievements. The route is a thin wrapper around it.
 *
 * Grants happen here rather than on a timer: this is the screen where a badge
 * appearing matters, and the user is looking at it. A badge earned a moment ago
 * is in the response, not in the next one.
 */
export async function GET(_req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()

  const achievements = await evaluateAchievements(session.user.id)
  // Summed here rather than stored: it is a read-time derivation of unlocked
  // badges' `points`, and any future backfill or deactivation stays correct
  // without a second write path to keep in sync.
  const totalPoints = achievements.reduce((sum, a) => sum + (a.unlocked ? a.points : 0), 0)
  return ok({ achievements, totalPoints, maxProfileBadges: MAX_PROFILE_BADGES })
}

const displaySchema = z.object({
  /** Profile shelf picks, in order. Capped at MAX_PROFILE_BADGES in the handler. */
  achievementIds: z.array(z.string()).default([]),
  /** The single home-feed slot. null clears it. */
  featuredAchievementId: z.string().nullable().optional(),
})

/**
 * PATCH /api/v1/achievements -- set the profile shelf and the featured slot.
 *
 * ── WHAT THIS REPLACED, AND WHY IT MATTERED ─────────────────
 *
 * The previous version built its UPDATE with string interpolation:
 * `... SET "displayOrder" = CASE "achievementId" WHEN '${id}' ...` after a
 * single-quote escape. The ids are cuids and come from the client, so the escape
 * was the only thing between a crafted id and arbitrary SQL. This version uses
 * Prisma's typed API and a transaction: no string is ever concatenated into a
 * statement, and the two updates (shelf + featured) commit together or not at
 * all.
 *
 * ── THE CAP IS ENFORCED HERE, NOT TRUSTED FROM THE CLIENT ───────────────────
 *
 * The app lets a user pick up to four; the server takes the first four of
 * whatever it is sent and ignores the rest, in the client's own order. The
 * badge ids are also checked to be ones THIS user has EARNED -- an id the user
 * does not own is dropped, so a crafted request cannot display somebody else's
 * badge or a badge the user has not unlocked.
 */
export async function PATCH(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()

  const body = await req.json().catch(() => ({}))
  const parsed = displaySchema.safeParse(body)
  if (!parsed.success) {
    return ok({ ok: false, error: "Invalid payload" })
  }

  const userId = session.user.id
  // Only the badges this user has actually earned may be displayed. Reading the
  // earned set and intersecting is what makes an unearned or foreign id a
  // no-op rather than a hole.
  const earned = await prisma.userAchievement.findMany({
    where: { userId },
    select: { achievementId: true },
  })
  const earnedIds = new Set(earned.map((row) => row.achievementId))

  const shelf = parsed.data.achievementIds
    .filter((id) => earnedIds.has(id))
    .slice(0, MAX_PROFILE_BADGES)

  const featured =
    parsed.data.featuredAchievementId && earnedIds.has(parsed.data.featuredAchievementId)
      ? parsed.data.featuredAchievementId
      : null
  try {
    await prisma.$transaction(async (tx) => {
      // Clear the shelf for every earned row, then set the chosen order. Two
      // statements, no dynamic SQL: the first is a blanket reset, the second
      // walks the picks.
      await tx.userAchievement.updateMany({
        where: { userId },
        data: { displayOrder: null, homeDisplayOrder: null },
      })

      for (let index = 0; index < shelf.length; index++) {
        await tx.userAchievement.updateMany({
          where: { userId, achievementId: shelf[index] },
          data: { displayOrder: index + 1 },
        })
      }

      if (featured) {
        await tx.userAchievement.updateMany({
          where: { userId, achievementId: featured },
          data: { homeDisplayOrder: 1 },
        })
      }
    })

    return ok({ ok: true })
  } catch (err) {
    console.error("[achievements] display update failed:", err instanceof Error ? err.message : err)
    return ok({ ok: false, error: "Could not update achievements" })
  }
}
