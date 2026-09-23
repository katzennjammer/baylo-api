import prisma from "@/lib/prisma"

/**
 * Weekly quests: three per user, one per tier, refreshed every Monday
 * 00:00 UTC.
 *
 * ── WHY RECONCILE, NOT AN EVENT HOOK AT EVERY MUTATION SITE ─────────────────
 *
 * The task-reward system (@/lib/tasks) started exactly this way --
 * `reconcileTasks()` was "the only award path" before event-driven hooks were
 * added at the trade-settlement and item-creation sites for immediacy. Quests
 * take the earlier, safer shape on purpose: `reconcileQuests()` recomputes
 * completion from real rows (an Offer sent, an Item listed, a TradeRequest
 * completed) every time GET /api/v1/quests is called, rather than requiring a
 * new call from inside items/offers/reviews/follows/trade-settlement code.
 * That keeps this feature's blast radius to two new files and an API route --
 * nothing about the offer or trade paths changes -- at the cost of a quest
 * showing "done" on next load rather than the instant it happens. If that
 * turns out to matter, add hooks the same way tasks did; reconcileQuests()
 * remains correct as the backfill either way.
 *
 * ── EVERY QUEST IS A REAL ACTION ─────────────────────────────────────────────
 *
 * The manuscript frames Baylo's Point System as a reward system rather than
 * gamification specifically because Leaves are paid for genuine platform
 * actions, never for engagement metrics like time-in-app. Every entry in
 * QUEST_POOL is something the system already tracks elsewhere (an Offer row,
 * an Item row, a completed TradeRequest); there is no "open the app" or
 * "spend N minutes" quest, and there should never be one.
 *
 * "File a report" was considered and deliberately excluded, for the same
 * reason WEEKLY_TASK_LEAF_CAP exists on the task side: paying Leaves for
 * reports would incentivize filing frivolous ones to farm the quest.
 */

export type QuestTier = "EASY" | "MEDIUM" | "HARD"
export type QuestKind =
  | "SEND_OFFER" | "FOLLOW_TRADER" | "LEAVE_REVIEW"
  | "LIST_ITEM" | "RECEIVE_OFFER"
  | "COMPLETE_TRADE" | "COMPLETE_BRIDGE_TRADE" | "COMPLETE_SAFEZONE_TRADE"

export const QUEST_TIERS: readonly QuestTier[] = ["EASY", "MEDIUM", "HARD"]

/** Leaves paid per tier. Snapshotted onto QuestAssignment.rewardLeaves at
 *  assignment time, so a later change here never rewrites a past week. */
export const QUEST_REWARDS: Record<QuestTier, number> = {
  EASY: 5,
  MEDIUM: 10,
  HARD: 20,
}

interface QuestDef {
  quest: QuestKind
  label: string
  description: string
}

/** One pool per tier. QuestKind values never repeat across tiers, which is
 *  what lets completeQuest() key a ledger row off `quest` alone. */
export const QUEST_POOL: Record<QuestTier, readonly QuestDef[]> = {
  EASY: [
    { quest: "SEND_OFFER", label: "Send a trade offer", description: "Propose a trade on any listing this week." },
    { quest: "FOLLOW_TRADER", label: "Follow a trader", description: "Follow someone whose items you like." },
    { quest: "LEAVE_REVIEW", label: "Leave a review", description: "Review a trade you completed." },
  ],
  MEDIUM: [
    { quest: "LIST_ITEM", label: "List a new item", description: "Post something from your closet this week." },
    { quest: "RECEIVE_OFFER", label: "Get an offer on your shelf", description: "Have one of your listings receive an offer." },
  ],
  HARD: [
    { quest: "COMPLETE_TRADE", label: "Complete a trade", description: "See a trade all the way through to completion." },
    { quest: "COMPLETE_BRIDGE_TRADE", label: "Complete a bridge trade", description: "Complete a trade that bridges a value gap with Leaves." },
    { quest: "COMPLETE_SAFEZONE_TRADE", label: "Meet at a Safe-Zone Hub", description: "Complete a trade you met for at a Safe-Zone Hub." },
  ],
} as const

/** Monday 00:00 UTC of the week containing `at`. Sunday counts as day 7 of
 *  the PRECEDING week, matching ISO week semantics, not JS's Sunday-first. */
export function weekStartUtc(at: Date): Date {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
  const isoDay = d.getUTCDay() === 0 ? 7 : d.getUTCDay() // Mon=1 .. Sun=7
  d.setUTCDate(d.getUTCDate() - (isoDay - 1))
  return d
}

/** A cheap, stable per-(user, week, tier) index into a pool -- not a security
 *  boundary, just enough spread that two users don't always see the same
 *  quest in a tier with more than one option. */
function poolIndex(userId: string, weekStart: Date, tier: QuestTier, poolSize: number): number {
  const key = `${userId}:${weekStart.toISOString()}:${tier}`
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  return hash % poolSize
}

/**
 * Picks which pool entry fills `tier` for this user this week.
 *
 * MEDIUM is the one tier with real personalisation: a user who has never
 * listed anything gets LIST_ITEM rather than a coin flip, because nudging an
 * empty shelf toward its first listing is a genuine, stated goal of the
 * reward system, not a manipulative metric. Every other slot is a stable
 * pseudo-random pick over the pool -- "personalised" only in the sense that
 * users see a mix, not that it reads behaviour to manipulate them.
 */
async function pickQuest(userId: string, weekStart: Date, tier: QuestTier): Promise<QuestDef> {
  const pool = QUEST_POOL[tier]

  if (tier === "MEDIUM") {
    const hasListed = await prisma.item.findFirst({ where: { userId }, select: { id: true } })
    if (!hasListed) return pool.find((q) => q.quest === "LIST_ITEM")!
  }

  return pool[poolIndex(userId, weekStart, tier, pool.length)]
}

export interface QuestView {
  tier: QuestTier
  quest: QuestKind
  label: string
  description: string
  rewardLeaves: number
  completed: boolean
}

/** True when the DB already shows the action `quest` needs, done by `userId`
 *  no earlier than `weekStart`. Read-only; completeQuest() does the writing. */
async function questSatisfied(userId: string, quest: QuestKind, weekStart: Date): Promise<boolean> {
  switch (quest) {
    case "SEND_OFFER":
      return (await prisma.offer.findFirst({
        where: { senderId: userId, createdAt: { gte: weekStart } },
        select: { id: true },
      })) !== null
    case "RECEIVE_OFFER":
      return (await prisma.offer.findFirst({
        where: { receiverId: userId, createdAt: { gte: weekStart } },
        select: { id: true },
      })) !== null
    case "FOLLOW_TRADER":
      return (await prisma.follow.findFirst({
        where: { followerId: userId, createdAt: { gte: weekStart } },
        select: { id: true },
      })) !== null
    case "LEAVE_REVIEW":
      return (await prisma.review.findFirst({
        where: { reviewerId: userId, createdAt: { gte: weekStart } },
        select: { id: true },
      })) !== null
    case "LIST_ITEM":
      return (await prisma.item.findFirst({
        where: { userId, createdAt: { gte: weekStart } },
        select: { id: true },
      })) !== null
    case "COMPLETE_TRADE":
      return (await prisma.tradeRequest.findFirst({
        where: {
          status: "COMPLETED", updatedAt: { gte: weekStart },
          OR: [{ senderId: userId }, { receiverId: userId }],
        },
        select: { id: true },
      })) !== null
    case "COMPLETE_BRIDGE_TRADE":
      return (await prisma.tradeRequest.findFirst({
        where: {
          status: "COMPLETED", updatedAt: { gte: weekStart },
          bridgeFeeLeaves: { gt: 0 },
          OR: [{ senderId: userId }, { receiverId: userId }],
        },
        select: { id: true },
      })) !== null
    case "COMPLETE_SAFEZONE_TRADE":
      return (await prisma.tradeRequest.findFirst({
        where: {
          status: "COMPLETED", updatedAt: { gte: weekStart },
          safeZoneHubId: { not: null },
          OR: [{ senderId: userId }, { receiverId: userId }],
        },
        select: { id: true },
      })) !== null
  }
}

/**
 * Pays out one assignment. The WHERE clause (`completedAt: null`) is the
 * concurrency guard, the same shape as claimSignupGrant() in
 * @/lib/verification and claimDailyTierGrant() in @/lib/tier-grant: two
 * concurrent reconciles both issue the same conditional UPDATE, the loser's
 * updateMany matches nothing, and only the winner writes the ledger row.
 */
async function completeQuest(userId: string, assignmentId: string, amount: number, at: Date): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.questAssignment.updateMany({
      where: { id: assignmentId, completedAt: null },
      data: { completedAt: at },
    })
    if (claimed.count !== 1) return

    await tx.leafTransaction.create({
      data: { userId, type: "QUEST_REWARD", amount, description: "Weekly quest completed", eventAt: at },
    })
    await tx.user.update({
      where: { id: userId },
      data: { leaves: { increment: amount }, lifetimeLeaves: { increment: amount } },
    })
  })
}

/**
 * The entry point: ensures this week's three assignments exist, checks each
 * unclaimed one against real DB state, pays out anything newly satisfied, and
 * returns the week's quests as the client should see them. Safe to call on
 * every GET /api/v1/quests -- idempotent, and cheap once a week's rows exist
 * (three unique-keyed lookups plus up to three read-only satisfaction checks).
 */
export async function reconcileQuests(userId: string, at: Date = new Date()): Promise<QuestView[]> {
  const weekStart = weekStartUtc(at)

  const existing = await prisma.questAssignment.findMany({
    where: { userId, weekStart },
  })
  const byTier = new Map(existing.map((a) => [a.tier as QuestTier, a]))

  const missing = QUEST_TIERS.filter((t) => !byTier.has(t))
  if (missing.length > 0) {
    const picks = await Promise.all(missing.map((tier) => pickQuest(userId, weekStart, tier)))
    // createMany + skipDuplicates: the @@unique([userId, weekStart, tier])
    // constraint is the real guard against a concurrent request assigning the
    // week twice, the same pattern claimCompletion() in @/lib/tasks uses.
    await prisma.questAssignment.createMany({
      data: missing.map((tier, i) => ({
        userId, weekStart, tier,
        quest: picks[i].quest,
        rewardLeaves: QUEST_REWARDS[tier],
      })),
      skipDuplicates: true,
    })
    const refreshed = await prisma.questAssignment.findMany({ where: { userId, weekStart } })
    for (const a of refreshed) byTier.set(a.tier as QuestTier, a)
  }

  const views: QuestView[] = []
  for (const tier of QUEST_TIERS) {
    const a = byTier.get(tier)
    if (!a) continue // createMany lost a race and this reconcile didn't refetch its winner; next call fills it

    let completed = a.completedAt !== null
    if (!completed && (await questSatisfied(userId, a.quest as QuestKind, weekStart))) {
      await completeQuest(userId, a.id, a.rewardLeaves, at)
      completed = true
    }

    const def = QUEST_POOL[tier].find((q) => q.quest === a.quest)!
    views.push({
      tier, quest: a.quest as QuestKind, label: def.label, description: def.description,
      rewardLeaves: a.rewardLeaves, completed,
    })
  }

  return views
}
