import prisma from "@/lib/prisma"

/**
 * Daily quests ("Daily Nest"): five per user per UTC calendar day --
 * 2 Easy, 2 Medium, 1 Hard -- refreshed every 24 hours at UTC midnight.
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

/** Leaves paid per completed quest in that tier: 2 Easy + 2 Medium + 1 Hard
 *  adds up to 2+2+3+3+5 = 15 Leaves for a fully-cleared day. Snapshotted onto
 *  QuestAssignment.rewardLeaves at assignment time, so a later change here
 *  never rewrites a past day. */
export const QUEST_REWARDS: Record<QuestTier, number> = {
  EASY: 2,
  MEDIUM: 3,
  HARD: 5,
}

/** How many quests are assigned per tier per day. */
export const QUEST_SLOTS: Record<QuestTier, number> = {
  EASY: 2,
  MEDIUM: 2,
  HARD: 1,
}

interface QuestDef {
  quest: QuestKind
  label: string
  description: string
}

/** One pool per tier. QuestKind values never repeat across tiers, which is
 *  what lets completeQuest() key a ledger row off `quest` alone. Each pool
 *  must hold at least QUEST_SLOTS[tier] entries. */
export const QUEST_POOL: Record<QuestTier, readonly QuestDef[]> = {
  EASY: [
    { quest: "SEND_OFFER", label: "Send a trade offer", description: "Propose a trade on any listing today." },
    { quest: "FOLLOW_TRADER", label: "Follow a trader", description: "Follow someone whose items you like." },
    { quest: "LEAVE_REVIEW", label: "Leave a review", description: "Review a trade you completed." },
  ],
  MEDIUM: [
    { quest: "LIST_ITEM", label: "List a new item", description: "Post something from your closet today." },
    { quest: "RECEIVE_OFFER", label: "Get an offer on your shelf", description: "Have one of your listings receive an offer." },
  ],
  HARD: [
    { quest: "COMPLETE_TRADE", label: "Complete a trade", description: "See a trade all the way through to completion." },
    { quest: "COMPLETE_BRIDGE_TRADE", label: "Complete a bridge trade", description: "Complete a trade that bridges a value gap with Leaves." },
    { quest: "COMPLETE_SAFEZONE_TRADE", label: "Meet at a Safe-Zone Hub", description: "Complete a trade you met for at a Safe-Zone Hub." },
  ],
} as const

/** UTC midnight of the day containing `at`. */
export function dayStartUtc(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
}

/** A cheap, stable per-(user, day, tier) index into a pool -- not a security
 *  boundary, just enough spread that two users don't always see the same
 *  quests in a tier with more options than slots. */
function poolIndex(userId: string, dayStart: Date, tier: QuestTier, poolSize: number): number {
  const key = `${userId}:${dayStart.toISOString()}:${tier}`
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  return hash % poolSize
}

/**
 * Picks the `count` pool entries that fill a tier's slots for this user
 * today: a stable rotation starting at a per-(user, day, tier) hashed
 * offset, wrapping around the pool. When the pool is no bigger than the
 * slot count (MEDIUM today: 2 entries, 2 slots) every entry is picked, in
 * pool order, every day -- there's nothing to rotate.
 */
function pickPoolEntries(userId: string, dayStart: Date, tier: QuestTier): QuestDef[] {
  const pool = QUEST_POOL[tier]
  const count = Math.min(QUEST_SLOTS[tier], pool.length)
  if (count >= pool.length) return [...pool]

  const start = poolIndex(userId, dayStart, tier, pool.length)
  return Array.from({ length: count }, (_, i) => pool[(start + i) % pool.length])
}

export interface QuestView {
  tier: QuestTier
  slot: number
  quest: QuestKind
  label: string
  description: string
  rewardLeaves: number
  completed: boolean
}

/** True when the DB already shows the action `quest` needs, done by `userId`
 *  no earlier than `dayStart`. Read-only; completeQuest() does the writing. */
async function questSatisfied(userId: string, quest: QuestKind, dayStart: Date): Promise<boolean> {
  switch (quest) {
    case "SEND_OFFER":
      return (await prisma.offer.findFirst({
        where: { senderId: userId, createdAt: { gte: dayStart } },
        select: { id: true },
      })) !== null
    case "RECEIVE_OFFER":
      return (await prisma.offer.findFirst({
        where: { receiverId: userId, createdAt: { gte: dayStart } },
        select: { id: true },
      })) !== null
    case "FOLLOW_TRADER":
      return (await prisma.follow.findFirst({
        where: { followerId: userId, createdAt: { gte: dayStart } },
        select: { id: true },
      })) !== null
    case "LEAVE_REVIEW":
      return (await prisma.review.findFirst({
        where: { reviewerId: userId, createdAt: { gte: dayStart } },
        select: { id: true },
      })) !== null
    case "LIST_ITEM":
      return (await prisma.item.findFirst({
        where: { userId, createdAt: { gte: dayStart } },
        select: { id: true },
      })) !== null
    case "COMPLETE_TRADE":
      return (await prisma.tradeRequest.findFirst({
        where: {
          status: "COMPLETED", updatedAt: { gte: dayStart },
          OR: [{ senderId: userId }, { receiverId: userId }],
        },
        select: { id: true },
      })) !== null
    case "COMPLETE_BRIDGE_TRADE":
      return (await prisma.tradeRequest.findFirst({
        where: {
          status: "COMPLETED", updatedAt: { gte: dayStart },
          bridgeFeeLeaves: { gt: 0 },
          OR: [{ senderId: userId }, { receiverId: userId }],
        },
        select: { id: true },
      })) !== null
    case "COMPLETE_SAFEZONE_TRADE":
      return (await prisma.tradeRequest.findFirst({
        where: {
          status: "COMPLETED", updatedAt: { gte: dayStart },
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
      data: { userId, type: "QUEST_REWARD", amount, description: "Daily quest completed", eventAt: at },
    })
    await tx.user.update({
      where: { id: userId },
      data: { leaves: { increment: amount }, lifetimeLeaves: { increment: amount } },
    })
  })
}

/**
 * The entry point: ensures today's five assignments exist (2 Easy, 2
 * Medium, 1 Hard), checks each unclaimed one against real DB state, pays out
 * anything newly satisfied, and returns the day's quests as the client
 * should see them. Safe to call on every GET /api/v1/quests -- idempotent,
 * and cheap once a day's rows exist.
 */
export async function reconcileQuests(userId: string, at: Date = new Date()): Promise<QuestView[]> {
  const dayStart = dayStartUtc(at)

  const existing = await prisma.questAssignment.findMany({
    where: { userId, dayStart },
  })
  const byKey = new Map(existing.map((a) => [`${a.tier}:${a.slot}`, a]))

  const wanted = QUEST_TIERS.flatMap((tier) =>
    Array.from({ length: QUEST_SLOTS[tier] }, (_, slot) => ({ tier, slot })),
  )
  const missing = wanted.filter(({ tier, slot }) => !byKey.has(`${tier}:${slot}`))

  if (missing.length > 0) {
    const picksByTier = new Map(QUEST_TIERS.map((tier) => [tier, pickPoolEntries(userId, dayStart, tier)]))
    // createMany + skipDuplicates: the @@unique([userId, dayStart, tier, slot])
    // constraint is the real guard against a concurrent request assigning the
    // day twice, the same pattern claimCompletion() in @/lib/tasks uses.
    await prisma.questAssignment.createMany({
      data: missing.map(({ tier, slot }) => ({
        userId, dayStart, tier, slot,
        quest: picksByTier.get(tier)![slot].quest,
        rewardLeaves: QUEST_REWARDS[tier],
      })),
      skipDuplicates: true,
    })
    const refreshed = await prisma.questAssignment.findMany({ where: { userId, dayStart } })
    for (const a of refreshed) byKey.set(`${a.tier}:${a.slot}`, a)
  }

  const views: QuestView[] = []
  for (const { tier, slot } of wanted) {
    const a = byKey.get(`${tier}:${slot}`)
    if (!a) continue // createMany lost a race and this reconcile didn't refetch its winner; next call fills it

    let completed = a.completedAt !== null
    if (!completed && (await questSatisfied(userId, a.quest as QuestKind, dayStart))) {
      await completeQuest(userId, a.id, a.rewardLeaves, at)
      completed = true
    }

    const def = QUEST_POOL[tier].find((q) => q.quest === a.quest)!
    views.push({
      tier, slot, quest: a.quest as QuestKind, label: def.label, description: def.description,
      rewardLeaves: a.rewardLeaves, completed,
    })
  }

  return views
}
