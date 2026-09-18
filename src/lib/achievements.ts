import prisma from "@/lib/prisma"
import { isIdVerified } from "@/lib/id-verification"
import type { PrismaClient } from "@/generated/prisma/client"
import type { AchievementCriterion } from "@/generated/prisma/enums"

type AchievementDb = Pick<
  PrismaClient,
  "achievement" | "userAchievement" | "user" | "taskCompletion" | "tradeRequest"
>

export const ACHIEVEMENT_CRITERIA = [
  "VERIFIED_ACCOUNT",
  "ID_VERIFIED",
  "FIRST_LISTING",
  "COMPLETED_TRADES",
] as const

export type AchievementCriterionValue = (typeof ACHIEVEMENT_CRITERIA)[number]

export interface AchievementProgress {
  criterion: AchievementCriterionValue
  value: number
}

/**
 * Unlocks are derived from trusted account and activity records. The catalog is
 * editable by staff, but neither the client nor an admin request can claim an
 * achievement for a user.
 */
export async function reconcileAchievements(
  userId: string,
  db: AchievementDb = prisma,
): Promise<void> {
  const [user, active, firstListing, completedTrades, idVerified] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { isVerified: true } }),
    db.achievement.findMany({ where: { isActive: true }, select: { id: true, criterion: true, threshold: true } }),
    db.taskCompletion.count({ where: { userId, task: "FIRST_LISTING", leaves: { gt: 0 } } }),
    db.tradeRequest.count({ where: { status: "COMPLETED", OR: [{ senderId: userId }, { receiverId: userId }] } }),
    isIdVerified(userId),
  ])
  if (!user) return

  const values: Record<AchievementCriterionValue, number> = {
    VERIFIED_ACCOUNT: user.isVerified ? 1 : 0,
    ID_VERIFIED: idVerified ? 1 : 0,
    FIRST_LISTING: firstListing,
    COMPLETED_TRADES: completedTrades,
  }

  const unlocked = active
    .filter((achievement) => values[achievement.criterion as AchievementCriterionValue] >= achievement.threshold)
    .map((achievement) => ({ userId, achievementId: achievement.id }))

  if (unlocked.length > 0) {
    await db.userAchievement.createMany({ data: unlocked, skipDuplicates: true })
  }
}

export async function getAchievementsForUser(userId: string) {
  // The catalog should remain readable even if a secondary unlock source is
  // temporarily unavailable. Reconciliation will run again on the next read.
  await reconcileAchievements(userId).catch(() => undefined)

  const [catalog, unlocked] = await Promise.all([
    prisma.achievement.findMany({
      where: { isActive: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, key: true, name: true, description: true, icon: true, criterion: true, threshold: true },
    }),
    prisma.userAchievement.findMany({
      where: { userId },
      select: { achievementId: true, unlockedAt: true, displayOrder: true, homeDisplayOrder: true },
    }),
  ])

  const unlockedById = new Map(unlocked.map((row) => [row.achievementId, row.unlockedAt]))
  const progress = await getProgress(userId).catch(() => ({
    VERIFIED_ACCOUNT: 0,
    ID_VERIFIED: 0,
    FIRST_LISTING: 0,
    COMPLETED_TRADES: 0,
  }))

  return catalog.map((achievement) => ({
    ...achievement,
    progress: progress[achievement.criterion as AchievementCriterionValue] ?? 0,
    unlockedAt: unlockedById.get(achievement.id) ?? null,
    unlocked: unlockedById.has(achievement.id),
    displayOrder: unlocked.find((row) => row.achievementId === achievement.id)?.displayOrder ?? null,
    homeDisplayOrder: unlocked.find((row) => row.achievementId === achievement.id)?.homeDisplayOrder ?? null,
  }))
}

export async function setDisplayedAchievements(
  userId: string,
  achievementIds: string[],
  featuredAchievementId?: string | null,
) {
  const ids = [...new Set(achievementIds)]
  if (ids.length > 3) throw new Error("You can display up to 3 badges")

  const earned = await prisma.userAchievement.findMany({
    where: { userId, achievementId: { in: [...ids, ...(featuredAchievementId ? [featuredAchievementId] : [])] } },
    select: { achievementId: true },
  })
  const earnedSet = new Set(earned.map((row) => row.achievementId))
  if (achievementIds.some((achievementId) => !earnedSet.has(achievementId))) {
    throw new Error("Only earned achievements can be displayed")
  }
  if (featuredAchievementId && !earnedSet.has(featuredAchievementId)) {
    throw new Error("Only earned achievements can be set as the home badge")
  }

  await prisma.$transaction([
    prisma.userAchievement.updateMany({ where: { userId }, data: { displayOrder: null, homeDisplayOrder: null } }),
    ...ids.map((achievementId, displayOrder) => prisma.userAchievement.update({
      where: { userId_achievementId: { userId, achievementId } },
      data: { displayOrder },
    })),
    ...(featuredAchievementId
      ? [prisma.userAchievement.update({
          where: { userId_achievementId: { userId, achievementId: featuredAchievementId } },
          data: { homeDisplayOrder: 0 },
        })]
      : []),
  ])
}

export async function getProgress(userId: string): Promise<Record<AchievementCriterionValue, number>> {
  const [user, idVerified, firstListing, completedTrades] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { isVerified: true } }),
    isIdVerified(userId),
    prisma.taskCompletion.count({ where: { userId, task: "FIRST_LISTING", leaves: { gt: 0 } } }),
    prisma.tradeRequest.count({ where: { status: "COMPLETED", OR: [{ senderId: userId }, { receiverId: userId }] } }),
  ])

  return {
    VERIFIED_ACCOUNT: user?.isVerified ? 1 : 0,
    ID_VERIFIED: idVerified ? 1 : 0,
    FIRST_LISTING: firstListing,
    COMPLETED_TRADES: completedTrades,
  }
}

export function criterionLabel(criterion: AchievementCriterion | string): string {
  return {
    VERIFIED_ACCOUNT: "Verify your account",
    ID_VERIFIED: "Complete ID verification",
    FIRST_LISTING: "List your first item",
    COMPLETED_TRADES: "Complete verified trades",
  }[criterion] ?? criterion
}
