import prisma from "@/lib/prisma"

/**
 * Daily quests: five a day -- 2 Easy, 2 Medium, 1 Hard -- refreshed every
 * midnight UTC.
 *
 * ── ONE CHECK, TWO CALLERS: THE EVENT AND THE READ ─────────────────────────
 *
 * `reconcileQuests()` is the only thing that decides a quest is done. It
 * recomputes completion from real rows (an Offer sent, an Item listed, a
 * TradeRequest completed) and pays anything newly satisfied. It has two
 * callers:
 *
 *   EVENT  `settleQuestsAsync()`, called from each route that writes a row a
 *          quest counts: POST /api/offers (sender and receiver), POST
 *          /api/items, POST /api/follows, POST /api/reviews, and trade
 *          settlement in confirm/submit (both parties). It checks only the
 *          kinds that action can satisfy, AFTER the action has committed.
 *   READ   GET /api/v1/quests, which checks everything. It is the display and
 *          the BACKFILL for anything an event missed. The event is
 *          fire-and-forget and best-effort, exactly like awardTaskAsync().
 *
 * Until 25 Sep 2026 the read was the only caller, so a quest paid out only if
 * its owner happened to open the Quests screen before midnight UTC. Somebody
 * who completed a trade and never looked lost the Leaves.
 *
 * Both callers take the same claim guard in completeQuest(), so an event and
 * a read racing each other pay once.
 *
 * ── NOT FOR ORGANISATION ACCOUNTS ───────────────────────────────────────────
 *
 * The event side skips org-backed User rows (`isOrgAccount`), so a staff
 * member's listing posted for an org, which lands on the org's row, does not
 * start paying daily quests into an account no person controls. The same
 * reasoning sends FIRST_LISTING to the human in POST /api/items. Whether orgs
 * should have quests at all is an open product decision, not a default. See
 * settleQuestsAsync().
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
 *
 * ── DAILY, AND STACKED ON TOP OF THE TASK CAP, ON PURPOSE ───────────────────
 *
 * Quests were weekly (one per tier, 3 total) until 24 Sep 2026, then moved to
 * daily -- 2 Easy + 2 Medium + 1 Hard, 15 Leaves/day if every one is done.
 * That is up to 105 Leaves/week from quests ALONE, and it is not capped
 * against WEEKLY_TASK_LEAF_CAP (100): quests write QUEST_REWARD ledger rows,
 * tasks write TASK_REWARD, and taskLeavesEarnedInWindow() in @/lib/tasks sums
 * only the latter. This is a deliberate product decision, not a gap that
 * needs closing -- see the PM decision this header is written against.
 *
 * ── A KNOWN, ACCEPTED GAP: NO PARTNER-DIVERSITY GUARD ───────────────────────
 *
 * SEND_OFFER, RECEIVE_OFFER, SEND_BRIDGE_OFFER, FOLLOW_TRADER and LEAVE_REVIEW are satisfied by
 * ANY qualifying row in the period, with no equivalent of the task system's
 * PARTNER_GATED / NEW_PARTNER_WINDOW_DAYS guard against two colluding
 * accounts bouncing the same trivial action back and forth. At daily cadence
 * that is a standing, low-value farm (at most a few Leaves/day per colluding
 * pair) rather than the kind of gap SAFEZONE_MEETUP had -- Leaves are not
 * real money and every quest still requires a genuine row to exist -- but it
 * is real, and worth the same PARTNER_GATED treatment @/lib/tasks uses if
 * quests are ever made to pay more than a few Leaves each.
 */

export type QuestTier = "EASY" | "MEDIUM" | "HARD"
export type QuestKind =
  | "SEND_OFFER" | "FOLLOW_TRADER" | "LEAVE_REVIEW"
  | "LIST_ITEM" | "RECEIVE_OFFER" | "SEND_BRIDGE_OFFER"
  | "COMPLETE_TRADE" | "COMPLETE_BRIDGE_TRADE" | "COMPLETE_SAFEZONE_TRADE"

export const QUEST_TIERS: readonly QuestTier[] = ["EASY", "MEDIUM", "HARD"]

/** Leaves paid per completed quest, by tier. Snapshotted onto
 *  QuestAssignment.rewardLeaves at assignment time, so a later change here
 *  never rewrites a past day. */
export const QUEST_REWARDS: Record<QuestTier, number> = {
  EASY: 2,
  MEDIUM: 3,
  HARD: 5,
}

/** How many quests are assigned per tier, per day. 2 + 2 + 1 = 5 total,
 *  2*2 + 2*3 + 1*5 = 15 Leaves if every one is completed. */
export const QUEST_TIER_COUNT: Record<QuestTier, number> = {
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
 *  what lets completeQuest() key a ledger row off `quest` alone. Every tier
 *  has more pool entries than its daily QUEST_TIER_COUNT, so pickQuests()
 *  below rotates through each pool rather than trivially assigning all of it. */
export const QUEST_POOL: Record<QuestTier, readonly QuestDef[]> = {
  EASY: [
    { quest: "SEND_OFFER", label: "Send a trade offer", description: "Propose a trade on any listing today." },
    { quest: "FOLLOW_TRADER", label: "Follow a trader", description: "Follow someone whose items you like." },
    { quest: "LEAVE_REVIEW", label: "Leave a review", description: "Review a trade you completed." },
  ],
  MEDIUM: [
    { quest: "LIST_ITEM", label: "List a new item", description: "Post something from your closet today." },
    { quest: "RECEIVE_OFFER", label: "Get an offer on your shelf", description: "Have one of your listings receive an offer." },
    { quest: "SEND_BRIDGE_OFFER", label: "Bridge a value gap", description: "Send an offer with an item one bracket below the listing." },
  ],
  HARD: [
    { quest: "COMPLETE_TRADE", label: "Complete a trade", description: "See a trade all the way through to completion." },
    { quest: "COMPLETE_BRIDGE_TRADE", label: "Complete a bridge trade", description: "Complete a trade that bridges a value gap with Leaves." },
    { quest: "COMPLETE_SAFEZONE_TRADE", label: "Meet at a Safe-Zone Hub", description: "Complete a trade you met for at a Safe-Zone Hub." },
  ],
} as const

/** Midnight UTC of the day containing `at`. */
export function dayStartUtc(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
}

/** A cheap, stable per-(user, day, tier) index into a pool -- not a security
 *  boundary, just enough spread that two users don't always see the same
 *  rotation. */
function poolSeed(userId: string, periodStart: Date, tier: QuestTier): number {
  const key = `${userId}:${periodStart.toISOString()}:${tier}`
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  return hash
}

/**
 * Picks `count` DISTINCT pool entries for `tier`, deterministic per
 * (userId, periodStart) so a page reload the same day shows the same quests.
 *
 * Rotates a starting index through the pool rather than sampling randomly:
 * with `count === pool.length` (MEDIUM today) it trivially returns the whole
 * pool in rotated order, and with `count < pool.length` (EASY, HARD) taking
 * `count` consecutive entries from a hashed start, wrapping around, can never
 * repeat an entry within the same day.
 */
function pickQuests(userId: string, periodStart: Date, tier: QuestTier): QuestDef[] {
  const pool = QUEST_POOL[tier]
  const count = Math.min(QUEST_TIER_COUNT[tier], pool.length)
  const start = poolSeed(userId, periodStart, tier) % pool.length
  return Array.from({ length: count }, (_, i) => pool[(start + i) % pool.length])
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
 *  no earlier than `periodStart`. Read-only; completeQuest() does the writing.
 *
 *  The three trade quests key off `completedAt`, the moment settlement
 *  committed, and NOT `updatedAt`. Any later write to a finished trade moves
 *  `updatedAt` (a hide flag, for instance), and until 25 Sep 2026 that made an
 *  old trade count toward today's quest. A trade completed before the column
 *  existed has NULL there and never matches, which is correct for a check
 *  that only asks about today. */
async function questSatisfied(userId: string, quest: QuestKind, periodStart: Date): Promise<boolean> {
  switch (quest) {
    case "SEND_OFFER":
      return (await prisma.offer.findFirst({
        where: { senderId: userId, createdAt: { gte: periodStart } },
        select: { id: true },
      })) !== null
    case "RECEIVE_OFFER":
      return (await prisma.offer.findFirst({
        where: { receiverId: userId, createdAt: { gte: periodStart } },
        select: { id: true },
      })) !== null
    case "FOLLOW_TRADER":
      return (await prisma.follow.findFirst({
        where: { followerId: userId, createdAt: { gte: periodStart } },
        select: { id: true },
      })) !== null
    case "LEAVE_REVIEW":
      return (await prisma.review.findFirst({
        where: { reviewerId: userId, createdAt: { gte: periodStart } },
        select: { id: true },
      })) !== null
    case "LIST_ITEM":
      return (await prisma.item.findFirst({
        where: { userId, createdAt: { gte: periodStart } },
        select: { id: true },
      })) !== null
    case "SEND_BRIDGE_OFFER":
      return (await prisma.offer.findFirst({
        where: { senderId: userId, createdAt: { gte: periodStart }, bridgeFeeLeaves: { not: null } },
        select: { id: true },
      })) !== null
    case "COMPLETE_TRADE":
      return (await prisma.tradeRequest.findFirst({
        where: {
          status: "COMPLETED", completedAt: { gte: periodStart },
          OR: [{ senderId: userId }, { receiverId: userId }],
        },
        select: { id: true },
      })) !== null
    case "COMPLETE_BRIDGE_TRADE":
      return (await prisma.tradeRequest.findFirst({
        where: {
          status: "COMPLETED", completedAt: { gte: periodStart },
          bridgeFeeLeaves: { gt: 0 },
          OR: [{ senderId: userId }, { receiverId: userId }],
        },
        select: { id: true },
      })) !== null
    case "COMPLETE_SAFEZONE_TRADE":
      return (await prisma.tradeRequest.findFirst({
        where: {
          status: "COMPLETED", completedAt: { gte: periodStart },
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
 * @/lib/verification: two concurrent reconciles both issue the same
 * conditional UPDATE, the loser's updateMany matches nothing, and only the
 * winner writes the ledger row.
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
 * The entry point: ensures today's five assignments exist, checks each
 * unclaimed one against real DB state, pays out anything newly satisfied, and
 * returns the day's quests as the client should see them. Safe to call on
 * every GET /api/v1/quests -- idempotent, and cheap once a day's rows exist
 * (one findMany plus up to five read-only satisfaction checks).
 *
 * `only` narrows the satisfaction checks to the kinds an event can have
 * changed. An offer being sent cannot complete "List a new item", so the event
 * path does not pay for the query that would ask. Omitted, every unclaimed
 * quest is checked; that is the read path.
 */
export async function reconcileQuests(
  userId: string,
  at: Date = new Date(),
  only?: readonly QuestKind[],
): Promise<QuestView[]> {
  const periodStart = dayStartUtc(at)

  const wanted = QUEST_TIERS.flatMap((tier) =>
    pickQuests(userId, periodStart, tier).map((def) => ({ tier, def })),
  )

  const existing = await prisma.questAssignment.findMany({ where: { userId, periodStart } })
  const byQuest = new Map(existing.map((a) => [a.quest as QuestKind, a]))

  const missing = wanted.filter((w) => !byQuest.has(w.def.quest))
  if (missing.length > 0) {
    // createMany + skipDuplicates: the @@unique([userId, periodStart, quest])
    // constraint is the real guard against a concurrent request assigning the
    // day twice, the same pattern claimCompletion() in @/lib/tasks uses.
    await prisma.questAssignment.createMany({
      data: missing.map(({ tier, def }) => ({
        userId, periodStart, tier, quest: def.quest, rewardLeaves: QUEST_REWARDS[tier],
      })),
      skipDuplicates: true,
    })
    const refreshed = await prisma.questAssignment.findMany({ where: { userId, periodStart } })
    for (const a of refreshed) byQuest.set(a.quest as QuestKind, a)
  }

  const views: QuestView[] = []
  for (const { tier, def } of wanted) {
    const a = byQuest.get(def.quest)
    if (!a) continue // createMany lost a race and this reconcile didn't refetch its winner; next call fills it

    let completed = a.completedAt !== null
    const checked = !only || only.includes(def.quest)
    if (!completed && checked && (await questSatisfied(userId, def.quest, periodStart))) {
      await completeQuest(userId, a.id, a.rewardLeaves, at)
      completed = true
    }

    views.push({
      tier, quest: def.quest, label: def.label, description: def.description,
      rewardLeaves: a.rewardLeaves, completed,
    })
  }

  return views
}

/** The kinds a completed trade can satisfy, for the settlement hook. */
export const TRADE_QUESTS: readonly QuestKind[] = [
  "COMPLETE_TRADE", "COMPLETE_BRIDGE_TRADE", "COMPLETE_SAFEZONE_TRADE",
]

/**
 * The event side: check `kinds` for `userId` now that the action behind them
 * has committed. Fire-and-forget, and best-effort like awardTaskAsync() in
 * @/lib/tasks. A failure here must never fail the offer, listing or trade
 * that triggered it, and GET /api/v1/quests is the backfill for a miss.
 *
 * CALL IT AFTER THE COMMIT, never inside the action's transaction.
 * reconcileQuests() reads through the global client, so it cannot see rows a
 * still-open transaction has written, and would find the quest unsatisfied.
 *
 * Organisation accounts are skipped. See "NOT FOR ORGANISATION ACCOUNTS" in the
 * header. The check is one indexed lookup, and it is the only thing standing
 * between a staff member's org listing and a daily Leaf allowance on the org's
 * row.
 */
export function settleQuestsAsync(userId: string, kinds: readonly QuestKind[]): void {
  void (async () => {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { isOrgAccount: true } })
    if (!user || user.isOrgAccount) return
    await reconcileQuests(userId, new Date(), kinds)
  })().catch((err) => {
    console.error("[quests] event settle failed; GET /api/v1/quests will backfill", err)
  })
}
