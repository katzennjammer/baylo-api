import type { PrismaClient } from "@/generated/prisma/client"
import { releaseBridgeFee, type ReleaseReason } from "@/lib/bridge-fee"

/**
 * A trade is ending without completing: give the bridging fee back.
 *
 * ── ONE FUNCTION, BECAUSE THERE ARE FOUR WAYS A TRADE DIES ──────────────────
 *
 * Either party cancels; the receiver rejects; a rival trade is auto-rejected
 * when the item is committed elsewhere; an admin steps in. Each of those is a
 * separate handler, and each of them must return the fee -- a trade that ends
 * with Leaves still in escrow is Leaves that belong to nobody, and nothing
 * afterwards will ever look for them again.
 *
 * `bridgeFeePaidBySender` is READ, not re-derived. See the column's note: the
 * brackets can move after a trade is agreed, and the refund must reach whoever
 * actually paid rather than whoever the current values imply.
 *
 * Returns what was released and to whom, or null when there was no fee. Safe
 * to call on any trade, including one that never had one.
 *
 * MUST RUN INSIDE A TRANSACTION, with the status write that ends the trade.
 * The once-only guard in releaseBridgeFee() means a second call writes
 * nothing, so a retry cannot double-refund; what the transaction adds is that
 * a rolled-back cancellation cannot leave a refund behind.
 */
type FeeDb = Pick<PrismaClient, "user" | "leafTransaction">

export async function releaseTradeFee(
  db: FeeDb,
  trade: {
    id: string
    senderId: string
    receiverId: string
    bridgeFeeLeaves: number | null
    bridgeFeePaidBySender: boolean | null
  },
  reason: ReleaseReason,
): Promise<{ userId: string; amount: number } | null> {
  const amount = trade.bridgeFeeLeaves ?? 0
  if (amount <= 0 || trade.bridgeFeePaidBySender === null) return null

  const userId = trade.bridgeFeePaidBySender ? trade.senderId : trade.receiverId

  // The hold is keyed on the deal's id in the ledger -- that is where it was
  // written and what the once-only guard checks. Since schema v2 a deal is one
  // Trade row from offer to completion, so that id IS this trade's id; there is
  // no longer an offer to find first (the old lookup re-found it by sender +
  // listing + ACCEPTED, which was not unique).
  const released = await releaseBridgeFee(db, {
    userId,
    tradeId: trade.id,
    amount,
    reason,
  })
  return released ? { userId, amount } : null
}

/** The columns releaseTradeFee() needs, for a caller's `select`. */
export const TRADE_FEE_SELECT = {
  id: true,
  senderId: true,
  receiverId: true,
  bridgeFeeLeaves: true,
  bridgeFeePaidBySender: true,
} as const
