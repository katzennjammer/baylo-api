import type { PrismaClient } from "@/generated/prisma/client"

/**
 * The bridging fee's three movements. THE ONLY PLACE FEE LEAVES MOVE.
 *
 * ── THE HOLD IS A REAL DEBIT ────────────────────────────────────────────────
 *
 * The old Leaves-on-an-offer arrangement was arithmetic: `offeredLeaves` sat
 * on the row and availableLeaves() subtracted it, and nothing was written to
 * the ledger until settlement. That was fine while the ledger was a record of
 * settlements. A fee is a commitment with three possible ends, and each end
 * has to be a row you can point at -- "where did my 20 Leaves go?" needs an
 * answer that is not "look at the status of the offer".
 *
 * So `holdBridgeFee()` takes the Leaves OUT of `User.leaves` and writes
 * BRIDGE_FEE_HOLD for -fee. Both move in the caller's transaction, which is
 * what keeps SUM(User.leaves) == SUM(LeafTransaction.amount) true at every
 * commit. While the offer lives, the fee is in nobody's balance; the negative
 * HOLD row is the whole of its existence. `releaseBridgeFee()` and
 * `payBridgeFee()` are the two ways it stops being held, and exactly one of
 * them runs per hold.
 *
 * ── MUST RUN INSIDE A TRANSACTION ───────────────────────────────────────────
 *
 * Each function writes one ledger row and one balance change. Called outside a
 * transaction, a crash between them mints or destroys Leaves. Every caller
 * passes a `tx`, and the status write that decides the offer's fate is in the
 * same one -- an offer that reads DECLINED must have its fee back, and a fee
 * that is back must belong to a DECLINED offer, at every observable moment.
 *
 * ── CLOSED ONCE ─────────────────────────────────────────────────────────────
 *
 * The callers' status writes are conditional, so two racing declines produce
 * one release. On top of that, both closing functions refuse to run a second
 * time for the same offer: an offer whose ledger already carries a RELEASE or
 * a PAID row is closed, and a second row would double-pay. That guard is what
 * makes it safe for the offer-accept path and the trade-cancel path to both
 * know how to release the same hold.
 */

type FeeDb = Pick<PrismaClient, "user" | "leafTransaction">

const CLOSING_TYPES = ["BRIDGE_FEE_RELEASE", "BRIDGE_FEE_PAID"] as const

export type HoldResult =
  | { ok: true }
  /** Balance below the fee. `have` is the balance the transaction saw. */
  | { ok: false; have: number }

/**
 * Take `amount` off the proposer's balance and write the HOLD row.
 *
 * The balance is read INSIDE the transaction and the debit is refused when it
 * would go negative -- that is the server's balance check on propose, and it
 * is here rather than in the route so the check and the debit cannot be
 * separated by a concurrent spend.
 */
export async function holdBridgeFee(
  db: FeeDb,
  input: { userId: string; offerId: string; amount: number; at?: Date },
): Promise<HoldResult> {
  const { userId, offerId, amount } = input
  const at = input.at ?? new Date()

  const user = await db.user.findUnique({ where: { id: userId }, select: { leaves: true } })
  const have = user?.leaves ?? 0
  if (amount <= 0) return { ok: true }
  if (have < amount) return { ok: false, have }

  // Conditional on the balance still covering it: two proposals racing the
  // same balance both read `have`, and only one may take the Leaves.
  const moved = await db.user.updateMany({
    where: { id: userId, leaves: { gte: amount } },
    data: { leaves: { decrement: amount } },
  })
  if (moved.count !== 1) return { ok: false, have }

  await db.leafTransaction.create({
    data: {
      userId,
      type: "BRIDGE_FEE_HOLD",
      amount: -amount,
      description: `Bridging fee held (${amount} Leaves)`,
      offerId,
      eventAt: at,
    },
  })
  return { ok: true }
}

export type ReleaseReason = "declined" | "withdrawn" | "expired" | "rejected" | "cancelled"

const RELEASE_COPY: Record<ReleaseReason, string> = {
  declined: "offer declined",
  withdrawn: "offer withdrawn",
  expired: "offer expired",
  rejected: "trade declined",
  cancelled: "trade cancelled",
}

/**
 * Give the held fee back to the proposer. Returns false when the hold was
 * already closed (released or paid) -- not an error, and the caller writes
 * nothing further.
 */
export async function releaseBridgeFee(
  db: FeeDb,
  input: { userId: string; offerId: string; tradeId?: string | null; amount: number; reason: ReleaseReason; at?: Date },
): Promise<boolean> {
  const { userId, offerId, amount, reason } = input
  if (amount <= 0) return false
  if (await isClosed(db, offerId)) return false

  await db.user.update({ where: { id: userId }, data: { leaves: { increment: amount } } })
  await db.leafTransaction.create({
    data: {
      userId,
      type: "BRIDGE_FEE_RELEASE",
      amount,
      description: `Bridging fee returned (${amount} Leaves) — ${RELEASE_COPY[reason]}`,
      offerId,
      tradeId: input.tradeId ?? null,
      eventAt: input.at ?? new Date(),
    },
  })
  return true
}

/**
 * Pay the held fee to the receiver on completion. Same once-only guard.
 *
 * `lifetimeLeaves` is NOT touched: the fee moves between two users, and the
 * rank figure counts only Leaves that entered the system.
 */
export async function payBridgeFee(
  db: FeeDb,
  input: { receiverId: string; proposerName: string; offerId: string; tradeId: string; amount: number; at?: Date },
): Promise<boolean> {
  const { receiverId, offerId, tradeId, amount } = input
  if (amount <= 0) return false
  if (await isClosed(db, offerId)) return false

  await db.user.update({ where: { id: receiverId }, data: { leaves: { increment: amount } } })
  await db.leafTransaction.create({
    data: {
      userId: receiverId,
      type: "BRIDGE_FEE_PAID",
      amount,
      description: `Bridging fee received from ${input.proposerName} (${amount} Leaves)`,
      offerId,
      tradeId,
      eventAt: input.at ?? new Date(),
    },
  })
  return true
}

async function isClosed(db: FeeDb, offerId: string): Promise<boolean> {
  const closing = await db.leafTransaction.findFirst({
    where: { offerId, type: { in: [...CLOSING_TYPES] } },
    select: { id: true },
  })
  return closing !== null
}

/**
 * Leaves this user has in escrow right now: the fees on their PENDING offers
 * plus the fees on their live trades (an ACCEPTED offer's fee has moved to the
 * trade row, see TradeRequest.bridgeFeeLeaves, so each hold is counted once).
 * What the wallet shows as "held on pending offers".
 *
 * Read from the ROWS, not the ledger. The ledger-side figure is the escrow
 * total the reconciliation computes, and the two agreeing is one of its three
 * checks -- see scripts/lib/ledger-invariant.ts.
 */
export async function heldBridgeFees(
  db: Pick<PrismaClient, "offer" | "tradeRequest">,
  userId: string,
): Promise<number> {
  const [offers, trades] = await Promise.all([
    db.offer.aggregate({
      where: { senderId: userId, status: "PENDING", bridgeFeeLeaves: { not: null } },
      _sum: { bridgeFeeLeaves: true },
    }),
    db.tradeRequest.aggregate({
      where: {
        senderId: userId,
        status: { in: [...LIVE_TRADE_STATUSES] },
        bridgeFeeLeaves: { not: null },
      },
      _sum: { bridgeFeeLeaves: true },
    }),
  ])
  return (offers._sum.bridgeFeeLeaves ?? 0) + (trades._sum.bridgeFeeLeaves ?? 0)
}

/** Trade statuses whose fee is still in escrow. */
export const LIVE_TRADE_STATUSES = ["PENDING", "ACCEPTED", "CONFIRMING"] as const
