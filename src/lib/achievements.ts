import type { Prisma, PrismaClient, AchievementCriterion } from "@/generated/prisma/client"
import prisma from "@/lib/prisma"
import { isIdVerified } from "@/lib/id-verification"

/**
 * The achievements engine.
 *
 * ── WHAT THIS IS ─────────────────────────────
 *
 * The bridge between "an admin defined a badge" (the Achievement row) and "this
 * user has earned it" (the UserAchievement row). Two jobs:
 *
 *   evaluateAchievements(userId)  reads the user's activity, grants every badge
 *                                 whose criterion is now met, and returns the
 *                                 full shelf with REAL progress.
 *   computeProgress(...)          one criterion, one user, one number -- the
 *                                 thing that lets a locked badge say "2 of 5"
 *                                 instead of a hard-coded 0.
 *
 * ── WHY A CLOSED CRITERION SET ───────────────────────────────
 *
 * `criterion` is an enum the code knows how to evaluate, never a rule an admin
 * types. "Grayed out unless achieved" is only honest if the SYSTEM decides, and
 * the system can only decide what it can measure. Adding a criterion is adding
 * a case to the switch below -- deliberate, reviewable, one place.
 *
 * ── GRANTING IS IDEMPOTENT, AND THE CONSTRAINT IS THE CLAIM ──────────────────
 *
 * The grant inserts with skipDuplicates against @@unique([userId, achievementId])
 * -- the same claim pattern as TaskCompletion in @/lib/tasks and for the same
 * reason: two concurrent requests must not write the row twice, and on Postgres
 * a caught unique violation would abort the enclosing transaction. skipDuplicates
 * compiles to ON CONFLICT DO NOTHING, which does not error.
 *
 * ── NEVER THROWS ─────────────────────────────
 *
 * Called from GET routes (the achievements screen, the profile read). A badge
 * that fails to grant must not blank the screen: on any error this returns the
 * list it can build and grants nothing, which is the same shape the old route
 * had when it returned an empty array. A badge arriving one screen later is a
 * far smaller failure than a 500 on the profile.
 */

/** A Prisma client or a transaction client. */
type Db = PrismaClient | Prisma.TransactionClient

/** The read model the API and the app both use. */
export interface AchievementView {
  id: string
  key: string
  name: string
  description: string
  icon: string
  imageUrl: string | null
  criterion: AchievementCriterion
  threshold: number
  /** What the user has reached toward `threshold`. Equal to threshold when unlocked. */
  progress: number
  unlocked: boolean
  unlockedAt: string | null
  displayOrder: number | null
  homeDisplayOrder: number | null
}

/**
 * The raw counts every criterion is judged against, read once per evaluation.
 *
 * ONE ROUND OF QUERIES FOR ALL BADGES, not one per badge: a user with twelve
 * badges must not cost twelve sets of counts, and the profile screen loads on
 * every profile view. Every field is a plain number or boolean -- no assembly,
 * no per-criterion fetch.
 */
interface Activity {
  isVerified: boolean
  profileComplete: boolean
  idVerified: boolean
  listings: number
  trades: number
  lifetimeLeaves: number
  safeZoneMeetups: number
  reportsFiled: number
}

/**
 * Reads the activity snapshot the criteria are judged against.
 *
 * `trades` counts COMPLETED trades on EITHER side -- the same reading as the
 * task engine's FIRST_TRADE, so the two never disagree about what a completed
 * trade is. `safeZoneMeetups` narrows that to completed trades that named a hub.
 */
async function readActivity(db: Db, userId: string): Promise<Activity | null> {
  const [user, listings, completedTrades, safeZoneMeetups, reportsFiled, idVerified] =
    await Promise.all([
      db.user.findUnique({
        where: { id: userId },
        select: { isVerified: true, avatar: true, bio: true, location: true, lifetimeLeaves: true },
      }),
      db.item.count({ where: { userId } }),
      db.tradeRequest.count({
        where: { status: "COMPLETED", OR: [{ senderId: userId }, { receiverId: userId }] },
      }),
      db.tradeRequest.count({
        where: {
          status: "COMPLETED",
          safeZoneHubId: { not: null },
          OR: [{ senderId: userId }, { receiverId: userId }],
        },
      }),
      db.report.count({ where: { reporterId: userId } }),
      isIdVerified(userId, db),
    ])

  if (!user) return null

  return {
    isVerified: user.isVerified,
    profileComplete: !!user.avatar?.trim() && !!user.bio?.trim() && !!user.location?.trim(),
    idVerified,
    listings,
    trades: completedTrades,
    lifetimeLeaves: user.lifetimeLeaves,
    safeZoneMeetups,
    reportsFiled,
  }
}

/**
 * One criterion, one activity snapshot, one number.
 *
 * For the boolean criteria the number is 0 or 1 (and the badge's threshold is
 * 1, so "met" is "1 >= 1"). For the counted ones it is the raw count. This is
 * the ONLY place a criterion is interpreted; adding one is adding a case here
 * and a value to the enum.
 */
export function progressFor(criterion: AchievementCriterion, activity: Activity): number {
  switch (criterion) {
    // The names here MUST match the "AchievementCriterion" enum in the live
    // database -- VERIFIED_ACCOUNT, FIRST_LISTING and COMPLETED_TRADES are the
    // live spellings, not the VERIFIED/LISTINGS/TRADES an earlier draft used.
    case "VERIFIED_ACCOUNT":
      return activity.isVerified ? 1 : 0
    case "ID_VERIFIED":
      return activity.idVerified ? 1 : 0
    case "FIRST_LISTING":
      return activity.listings
    case "COMPLETED_TRADES":
      return activity.trades
    case "PROFILE_COMPLETE":
      return activity.profileComplete ? 1 : 0
    case "LIFETIME_LEAVES":
      return activity.lifetimeLeaves
    case "SAFEZONE_MEETUPS":
      return activity.safeZoneMeetups
    case "REPORTS_FILED":
      return activity.reportsFiled
  }
}

/**
 * Grants every active badge whose criterion the user now meets, then returns
 * the full shelf (active badges) with real progress and unlock state.
 *
 * The grant is per-badge and idempotent; the read afterwards is a single join.
 * Returns an empty list rather than throwing if anything goes wrong -- see the
 * file header.
 */
export async function evaluateAchievements(
  userId: string,
  db: Db = prisma,
): Promise<AchievementView[]> {
  try {
    const [definitions, activity, earned] = await Promise.all([
      db.achievement.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      }),
      readActivity(db, userId),
      db.userAchievement.findMany({
        where: { userId },
        select: { achievementId: true, unlockedAt: true, displayOrder: true, homeDisplayOrder: true },
      }),
    ])

    if (!activity) return []

    // Explicitly typed: the union `Db` weakens Prisma's inference here, and an
    // untyped map would make every read below `any`.
    interface EarnedRow {
      achievementId: string
      unlockedAt: Date
      displayOrder: number | null
      homeDisplayOrder: number | null
    }
    const earnedBy = new Map<string, EarnedRow>(
      (earned as EarnedRow[]).map((row) => [row.achievementId, row]),
    )

    // Which definitions have just been met but not yet earned. Sort by key so
    // the write order is stable (and so a test's assertions do not depend on
    // query order) -- the grants are independent, so order is cosmetic.
    const toGrant = definitions
      .filter((def) => {
        if (earnedBy.has(def.id)) return false
        return progressFor(def.criterion, activity) >= def.threshold
      })
      .sort((a, b) => a.key.localeCompare(b.key))

    if (toGrant.length > 0) {
      await db.userAchievement.createMany({
        data: toGrant.map((def) => ({ userId, achievementId: def.id })),
        skipDuplicates: true,
      })
      // Reflect the grants in the returned view without a second query. The
      // display slots are null: a newly earned badge is not auto-displayed --
      // that is the user's choice, made on the achievements screen.
      const now = new Date().toISOString()
      for (const def of toGrant) {
        earnedBy.set(def.id, {
          achievementId: def.id,
          unlockedAt: new Date(now),
          displayOrder: null,
          homeDisplayOrder: null,
        })
      }
    }

    return definitions.map((def) => {
      const unlock = earnedBy.get(def.id)
      const unlocked = !!unlock
      const reached = progressFor(def.criterion, activity)
      return {
        id: def.id,
        key: def.key,
        name: def.name,
        description: def.description,
        icon: def.icon,
        imageUrl: def.imageUrl,
        criterion: def.criterion,
        threshold: def.threshold,
        // A locked badge shows real progress (capped at the threshold); an
        // unlocked one shows full, because it is met by definition.
        progress: unlocked ? def.threshold : Math.min(reached, def.threshold),
        unlocked,
        unlockedAt: unlock ? new Date(unlock.unlockedAt).toISOString() : null,
        displayOrder: unlock?.displayOrder ?? null,
        homeDisplayOrder: unlock?.homeDisplayOrder ?? null,
      }
    })
  } catch (err) {
    console.error("[achievements] evaluate failed:", err instanceof Error ? err.message : err)
    return []
  }
}

/**
 * Backfills a definition to everyone who ALREADY meets its criterion.
 *
 * When an admin creates a badge for something users have already done -- almost
 * every badge, on the day it is created -- waiting for each of them to open the
 * achievements screen means most never get it. This runs the same evaluation for
 * a bounded batch of users and grants what they qualify for.
 *
 * Bounded on purpose: a badge created against a huge existing population should
 * not run an unbounded job inside the admin request. It processes the most
 * recently active users first, and returns how many it granted, so the admin
 * sees that it did something and the rest arrive as users open their screens.
 */
export async function backfillAchievement(
  achievementId: string,
  db: Db = prisma,
  limit = 500,
): Promise<number> {
  try {
    const def = await db.achievement.findUnique({ where: { id: achievementId } })
    if (!def || !def.isActive) return 0

    const users = await db.user.findMany({
      where: { deletedAt: null },
      select: { id: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    })

    let granted = 0
    for (const user of users) {
      const activity = await readActivity(db, user.id)
      if (!activity) continue
      if (progressFor(def.criterion, activity) < def.threshold) continue

      const { count } = await db.userAchievement.createMany({
        data: [{ userId: user.id, achievementId: def.id }],
        skipDuplicates: true,
      })
      granted += count
    }
    return granted
  } catch (err) {
    console.error("[achievements] backfill failed:", err instanceof Error ? err.message : err)
    return 0
  }
}
