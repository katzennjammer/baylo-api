import prisma from "@/lib/prisma"
import { isPremium, isVip } from "@/lib/premium"

/**
 * The daily free-Leaves allowance for a live subscriber, per the bracket
 * tiers in @/lib/brackets: 5 Leaves/day for Premium (brackets 7-8), 10 for VIP
 * (brackets 9-10). A subscriber who is BOTH -- vipUntil live regardless of
 * premiumUntil -- is paid VIP_DAILY_LEAVES once, never both: the two are one
 * ladder, not two faucets, the same reason enforcePremiumForListing() checks
 * vip before premium instead of stacking their effects.
 */
export const PREMIUM_DAILY_LEAVES = 5
export const VIP_DAILY_LEAVES = 10

function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
}

/**
 * Credits today's free Leaves for a live Premium or VIP subscriber, at most
 * once per UTC calendar day. Call it from a screen the subscriber actually
 * opens -- today that is GET /api/v1/profile/me -- rather than a cron job:
 * the same lazy-sweep shape as the (now-retired) contract default sweep, so
 * there is nothing to run when nobody is looking and nothing to catch up on a
 * schedule that could fall behind.
 *
 * Returns the amount credited, 0 if nothing was (no live subscription, or
 * already claimed today). Never throws on "nothing to do" -- only a real
 * failure to reach the database should look like one.
 *
 * ── THE CONCURRENCY GUARD ────────────────────────────────────────────────────
 * The same shape as claimSignupGrant() in @/lib/verification: the WHERE
 * clause is the guard, not a read-then-write. Two simultaneous calls both
 * issue the same conditional UPDATE; Postgres serialises them on the row, and
 * the loser's updateMany matches zero rows and writes nothing. Reading
 * lastTierGrantAt first and branching on it in JavaScript would let both
 * concurrent calls read "not yet today" and both pay.
 */
export async function claimDailyTierGrant(userId: string, at: Date = new Date()): Promise<number> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { premiumUntil: true, vipUntil: true, lastTierGrantAt: true },
  })
  if (!user) return 0

  const vip = isVip(user.vipUntil, at)
  const premium = isPremium(user.premiumUntil, at)
  if (!vip && !premium) return 0

  const today = startOfUtcDay(at)
  if (user.lastTierGrantAt != null && user.lastTierGrantAt >= today) return 0

  const amount = vip ? VIP_DAILY_LEAVES : PREMIUM_DAILY_LEAVES

  return prisma.$transaction(async (tx) => {
    // The flag and both balances move in ONE statement, so the claim and the
    // credit cannot come apart -- same invariant claimSignupGrant() keeps.
    const claimed = await tx.user.updateMany({
      where: {
        id: userId,
        OR: [{ lastTierGrantAt: null }, { lastTierGrantAt: { lt: today } }],
      },
      data: {
        lastTierGrantAt: at,
        leaves: { increment: amount },
        lifetimeLeaves: { increment: amount },
      },
    })
    if (claimed.count !== 1) return 0

    await tx.leafTransaction.create({
      data: {
        userId,
        type: "TIER_DAILY_GRANT",
        amount,
        description: vip ? "VIP daily Leaves" : "Premium daily Leaves",
        eventAt: at,
      },
    })

    return amount
  })
}
