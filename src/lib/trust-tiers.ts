import type { PrismaClient } from "@/generated/prisma/client"
import { getTrustTier, type TrustTier } from "@/lib/reputation"

/**
 * The trust tier for many users at once — what a badge is allowed to claim
 * about each of them.
 *
 * ── WHY IT IS NOT `getTrustTier(user.totalTrades, user.rating)` ─────────────
 *
 * `User.totalTrades` DRIFTS. It is a denormalised counter and it sits above
 * the real COMPLETED count on live rows — one user reads 3 there and has 2
 * real completed trades, which is the difference between "Rising Trader" on
 * their badge and "New Trader" at the gate. Every gate in this codebase counts
 * TradeRequest rows instead; so does this.
 *
 * ── WHY IT IS BATCHED ───────────────────────────────────────────────────────
 *
 * `loadStanding()` answers for ONE user in two queries. A feed page needs one
 * number about twenty people, and twenty times two queries on the hottest
 * endpoint in the app is not a trade anyone would make. This is the same rule
 * over a whole page in TWO queries total.
 *
 * ── WHAT IT LOST ON 16 SEP 2026 ─────────────────────────────────────────────
 *
 * This was `loadEffectiveTiers()` in @/lib/contracts, and it charged DPA
 * defaults against the badge: an unsettled default floored a user's tier, and
 * every past default cost a rung. Deferred agreements are gone — the bridging
 * fee covers the gap a promise used to — so there are no defaults to charge
 * and the effective tier IS the base tier. The third aggregate that read
 * DeferredContract went with them, and the file moved here because nothing
 * about tiers was ever really about contracts.
 *
 * `ratings` is passed in rather than queried because every caller already has
 * it — the owner block selects `rating` — and a query for a column already in
 * hand is the kind of thing that turns one endpoint into seventeen.
 */

type TierDb = Pick<PrismaClient, "tradeRequest">

export async function loadTrustTiers(
  db: TierDb,
  users: readonly { id: string; rating: number }[],
): Promise<Map<string, TrustTier>> {
  const out = new Map<string, TrustTier>()
  if (users.length === 0) return out

  const ids = [...new Set(users.map((u) => u.id))]

  const [sent, received] = await Promise.all([
    // Completed trades, counted from the rows. Prisma cannot group on "either
    // of two columns", so the two sides are counted separately and added. That
    // is identical to the single-user count({ OR: [...] }) for every row where
    // sender and receiver differ, which is every row — a self-trade has no
    // meaning here and no path in the API creates one.
    db.tradeRequest.groupBy({
      by: ["senderId"],
      where: { status: "COMPLETED", senderId: { in: ids } },
      _count: { _all: true },
    }),
    db.tradeRequest.groupBy({
      by: ["receiverId"],
      where: { status: "COMPLETED", receiverId: { in: ids } },
      _count: { _all: true },
    }),
  ])

  const trades = new Map<string, number>()
  for (const row of sent) {
    trades.set(row.senderId, (trades.get(row.senderId) ?? 0) + row._count._all)
  }
  for (const row of received) {
    trades.set(row.receiverId, (trades.get(row.receiverId) ?? 0) + row._count._all)
  }

  for (const user of users) {
    out.set(user.id, getTrustTier(trades.get(user.id) ?? 0, user.rating))
  }
  return out
}
