import type { PrismaClient } from "@/generated/prisma/client"
import { bracketOf } from "@/lib/brackets"
import {
  tradeReward,
  TRADE_REWARD_DAILY_CAP_LEAVES,
  TRADE_REWARD_REPEAT_PAIR_DAYS,
  TRADE_REWARD_SAME_ITEM_DAYS,
} from "@/lib/trade-rules"

/**
 * The trade completion reward. ISSUANCE: the one way new Leaves enter the
 * system apart from the signup grant and the task rewards.
 *
 * Each party to a completed trade earns `tradeReward(bracket of the item THEY
 * gave)` -- see @/lib/trade-rules for the formula and for why it takes a
 * bracket and not a value. The row is TRADE_REWARD, positive, on the earner,
 * pointing at the trade; both `leaves` and `lifetimeLeaves` move, exactly as a
 * task reward does. It replaced the flat 20-Leaf VERIFIED_SWAP task on 16 Sep
 * 2026.
 *
 * ── DENIALS ARE SILENT IN THE LEDGER, LOUD IN THE RESPONSE ──────────────────
 *
 * A party the anti-farming gates refuse gets no row at all -- not a zero row.
 * TaskCompletion writes zero rows because a later backfill would otherwise
 * re-pay; there is no backfill for this reward (it is paid inside the
 * settlement transaction or not at all), so a zero row would only be noise in
 * a table whose every other row is a Leaf movement. The reason is returned to
 * the caller instead, and the completed screen says it.
 *
 * ── MUST RUN INSIDE THE SETTLEMENT TRANSACTION ──────────────────────────────
 *
 * The status write that makes the trade COMPLETED is conditional, and this
 * runs after it in the same transaction, so a trade is rewarded once or not
 * at all. The `already_awarded` check is belt and braces for a replay.
 */

type RewardDb = Pick<PrismaClient, "user" | "leafTransaction" | "tradeRequest" | "item">

const DAY_MS = 24 * 60 * 60 * 1000

export type RewardReason =
  | "awarded"
  /** The trade named one listing in both columns -- nothing was given. */
  | "placeholder"
  /** The given item carries no valueLeaves, so it has no bracket. */
  | "unvalued"
  /** These two users completed another trade inside the pair window. */
  | "repeat_pair"
  /** The given item was in a completed trade inside the item window. */
  | "same_item"
  /** This party has collected the daily cap already. */
  | "daily_cap"
  | "already_awarded"

export interface RewardOutcome {
  userId: string
  /** The Leaves credited. 0 for every reason but "awarded". */
  amount: number
  reason: RewardReason
  /** The bracket the amount was derived from, when there was one. */
  givenBracket: number | null
}

export interface RewardableTrade {
  id: string
  senderId: string
  receiverId: string
  offeredItemId: string
  requestedItemId: string
  /** When it completed. The anchor for every window below. */
  completedAt: Date
}

/**
 * Reward both parties of a just-completed trade. One call, two outcomes, so a
 * settlement site cannot pay one side and forget the other.
 */
export async function awardTradeRewards(
  db: RewardDb,
  trade: RewardableTrade,
): Promise<{ sender: RewardOutcome; receiver: RewardOutcome }> {
  const [sender, receiver] = await Promise.all([
    awardOne(db, trade, "sender"),
    awardOne(db, trade, "receiver"),
  ])
  return { sender, receiver }
}

async function awardOne(
  db: RewardDb,
  trade: RewardableTrade,
  side: "sender" | "receiver",
): Promise<RewardOutcome> {
  const userId = side === "sender" ? trade.senderId : trade.receiverId
  const partnerId = side === "sender" ? trade.receiverId : trade.senderId
  // The sender GAVE offeredItem; the receiver GAVE requestedItem.
  const givenItemId = side === "sender" ? trade.offeredItemId : trade.requestedItemId
  const none = (reason: RewardReason, givenBracket: number | null = null): RewardOutcome => ({
    userId, amount: 0, reason, givenBracket,
  })

  if (trade.offeredItemId === trade.requestedItemId) return none("placeholder")

  const given = await db.item.findUnique({ where: { id: givenItemId }, select: { valueLeaves: true } })
  if (!given || given.valueLeaves === null) return none("unvalued")
  const givenBracket = bracketOf(given.valueLeaves)
  const amount = tradeReward(givenBracket)

  const existing = await db.leafTransaction.findFirst({
    where: { userId, tradeId: trade.id, type: "TRADE_REWARD" },
    select: { id: true },
  })
  if (existing) return none("already_awarded", givenBracket)

  // Gate 1 -- the pair. Any other COMPLETED trade between these two inside
  // the window, either direction, judged on when THAT trade completed.
  const pairSince = new Date(trade.completedAt.getTime() - TRADE_REWARD_REPEAT_PAIR_DAYS * DAY_MS)
  const priorPair = await db.tradeRequest.findFirst({
    where: {
      id: { not: trade.id },
      status: "COMPLETED",
      updatedAt: { gte: pairSince, lte: trade.completedAt },
      OR: [
        { senderId: userId, receiverId: partnerId },
        { senderId: partnerId, receiverId: userId },
      ],
    },
    select: { id: true },
  })
  if (priorPair) return none("repeat_pair", givenBracket)

  // Gate 2 -- the item. The same Item id in any other COMPLETED trade inside
  // the window, on either side. An item keeps its id through relisting, which
  // is exactly what lets this catch a ring the pair rule cannot see.
  const itemSince = new Date(trade.completedAt.getTime() - TRADE_REWARD_SAME_ITEM_DAYS * DAY_MS)
  const priorItem = await db.tradeRequest.findFirst({
    where: {
      id: { not: trade.id },
      status: "COMPLETED",
      updatedAt: { gte: itemSince, lte: trade.completedAt },
      OR: [{ offeredItemId: givenItemId }, { requestedItemId: givenItemId }],
    },
    select: { id: true },
  })
  if (priorItem) return none("same_item", givenBracket)

  // Gate 3 -- the daily cap, over the rolling day ending at this completion.
  const daySince = new Date(trade.completedAt.getTime() - DAY_MS)
  const today = await db.leafTransaction.aggregate({
    where: { userId, type: "TRADE_REWARD", eventAt: { gte: daySince, lte: trade.completedAt } },
    _sum: { amount: true },
  })
  if ((today._sum.amount ?? 0) + amount > TRADE_REWARD_DAILY_CAP_LEAVES) {
    return none("daily_cap", givenBracket)
  }

  await db.leafTransaction.create({
    data: {
      userId,
      type: "TRADE_REWARD",
      amount,
      description: `Trade reward: gave a bracket ${givenBracket} item`,
      tradeId: trade.id,
      eventAt: trade.completedAt,
    },
  })
  await db.user.update({
    where: { id: userId },
    data: { leaves: { increment: amount }, lifetimeLeaves: { increment: amount } },
  })

  return { userId, amount, reason: "awarded", givenBracket }
}

/**
 * Take a completed trade's rewards back from both parties. The REWARD only:
 * the bridging fee stays with the receiver, because the items changed hands
 * in person and the fee priced that, not the reward.
 *
 * Writes TRADE_REWARD_REVERSAL for -amount per rewarded party, and is the one
 * path that decrements `lifetimeLeaves` -- the reward was not earned, so the
 * rank figure it moved moves back. `leaves` may go negative if the Leaves
 * were already spent; availableLeaves() clamps the spendable figure at zero
 * and the account simply cannot bridge until it earns again.
 *
 * Once per party: a reversal already on the ledger for (user, trade) is not
 * written twice.
 */
export async function reverseTradeRewards(
  db: RewardDb,
  tradeId: string,
  at: Date = new Date(),
): Promise<{ userId: string; amount: number }[]> {
  const rewards = await db.leafTransaction.findMany({
    where: { tradeId, type: "TRADE_REWARD" },
    select: { userId: true, amount: true },
  })
  const reversed: { userId: string; amount: number }[] = []

  for (const r of rewards) {
    const already = await db.leafTransaction.findFirst({
      where: { tradeId, userId: r.userId, type: "TRADE_REWARD_REVERSAL" },
      select: { id: true },
    })
    if (already) continue

    await db.leafTransaction.create({
      data: {
        userId: r.userId,
        type: "TRADE_REWARD_REVERSAL",
        amount: -r.amount,
        description: `Trade reward reversed by an admin (${r.amount} Leaves)`,
        tradeId,
        eventAt: at,
      },
    })
    await db.user.update({
      where: { id: r.userId },
      data: { leaves: { decrement: r.amount }, lifetimeLeaves: { decrement: r.amount } },
    })
    reversed.push({ userId: r.userId, amount: r.amount })
  }
  return reversed
}

/** The one-line reason a denied party is shown. Null when they were paid. */
export function rewardDenialCopy(outcome: RewardOutcome, partnerName: string): string | null {
  switch (outcome.reason) {
    case "awarded":
      return null
    case "repeat_pair":
      return `No trade reward this time — you traded with ${partnerName} in the last ${TRADE_REWARD_REPEAT_PAIR_DAYS} days.`
    case "same_item":
      return `No trade reward this time — that item was traded in the last ${TRADE_REWARD_SAME_ITEM_DAYS} days.`
    case "daily_cap":
      return `No trade reward this time — you've reached today's ${TRADE_REWARD_DAILY_CAP_LEAVES}-Leaf limit.`
    case "unvalued":
      return "No trade reward — the item you gave has no value on record."
    case "placeholder":
    case "already_awarded":
      return null
  }
}
