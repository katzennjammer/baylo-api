import { createHash } from "node:crypto"
import type { PrismaClient } from "@/generated/prisma/client"
import { availableLeaves } from "@/lib/leaves"

/**
 * Featured boosts: an owner pays Leaves to put a listing in Home's Featured
 * section for a fixed window. THE ONLY PLACE BOOST LEAVES MOVE.
 *
 * ── A SINK, WRITTEN LIKE EVERY OTHER LEAF MOVEMENT ──────────────────────────
 *
 * The cost leaves `User.leaves` and goes to nobody. It is still one balance
 * change and one FEATURE_BOOST ledger row in one transaction -- the shape
 * holdBridgeFee() uses -- so SUM(User.leaves) == SUM(LeafTransaction.amount)
 * holds at every commit, and scripts/lib/ledger-invariant.ts counts the row
 * with the other net-issuance types.
 *
 * ── WHAT CAN BE BOOSTED ─────────────────────────────────────────────────────
 *
 * The owner's own AVAILABLE, non-perishable, not-taken-down listing that is
 * not already featured. Perishables have their own section (Exclusive) and a
 * clock of their own; a boost that outlived the listing's window would be
 * Leaves spent on an item the sweep is about to expire.
 *
 * NO STACKING. A second boost on a listing whose window is still open is
 * refused, not extended: extending would let a large balance buy a permanent
 * slot, which is exactly what the section's cap exists to prevent.
 */

export const BOOST_COST_LEAVES = 2
export const BOOST_HOURS = 24

/**
 * How many listings the Featured section shows at once, per category.
 *
 * More than this may be featured; the section shows eight of them, and which
 * eight changes every hour. See featuredRotation().
 */
export const FEATURED_VISIBLE_CAP = 8

/**
 * How many active boosts one category's rotation reads. A ceiling on the id
 * scan, not a product rule: a category would need this many paid boosts live
 * AT ONCE to reach it. Past it, the oldest boosts are the ones considered, so
 * the rotation stays deterministic rather than depending on row order.
 */
export const FEATURED_SCAN_CAP = 2000

const HOUR_MS = 60 * 60 * 1000

/** The UTC hour `now` falls in, as a whole number. The rotation's clock. */
export function rotationHour(now: Date = new Date()): number {
  return Math.floor(now.getTime() / HOUR_MS)
}

/**
 * THE ROTATION: every active boost in the category, shuffled into an order
 * that is FIXED FOR THE HOUR and different the next, and the section shows
 * the first FEATURED_VISIBLE_CAP.
 *
 * Each id's place is sha256("<hour>:<category>:<id>"). So:
 *
 *   - DETERMINISTIC. Same hour, same category, same set of boosts => the same
 *     order on every request, every server instance, every refresh. Nothing is
 *     random and nothing is stored; the order is a pure function of its inputs.
 *   - RESHUFFLED HOURLY. The hour is in the hash, so at the top of the next
 *     UTC hour every id draws a fresh, independent place.
 *   - BLIND TO MONEY AND TIMING. featuredAt, balance and how often someone has
 *     boosted before play no part: every live boost has the same chance at
 *     the eight each hour. What stacking would buy is refused at purchase
 *     (see "NO STACKING" above).
 *   - STABLE UNDER CHURN WITHIN THE HOUR. An id's key does not depend on the
 *     other ids, so a boost arriving or lapsing mid-hour adds or removes one
 *     entry without reordering everybody else.
 *
 * FAIR IN EXPECTATION, NOT GUARANTEED. Each hour is an independent draw, so
 * with more than eight live boosts a given listing can miss every draw in its
 * window. Measured by simulation, for listings that live their full 24 hours:
 * about 0% never shown at 24 live boosts per category, 1.6% at 48, 12.5% at 96.
 */
export function featuredRotation<T extends { id: string }>(
  rows: readonly T[],
  category: string,
  now: Date = new Date(),
): T[] {
  const hour = rotationHour(now)
  return rows
    .map((row) => ({
      row,
      key: createHash("sha256").update(`${hour}:${category}:${row.id}`).digest("hex"),
    }))
    // Fixed-width hex compares correctly as a string; a collision falls back
    // to the id so the order is total.
    .sort((a, b) =>
      a.key === b.key ? (a.row.id < b.row.id ? -1 : 1) : a.key < b.key ? -1 : 1,
    )
    .map((x) => x.row)
}

/**
 * The read predicate. `featuredUntil > now` IS REQUIRED ALONGSIDE THE FLAG:
 * the flag is what the sweep maintains, the timestamp is the truth, and a read
 * that trusted the flag alone would keep serving a lapsed boost until
 * something swept.
 */
export function activeFeaturedWhere(now: Date = new Date()) {
  return {
    isFeatured: true,
    featuredUntil: { gt: now },
    status: "AVAILABLE" as const,
    isPerishable: false,
    moderationHiddenAt: null,
  }
}

/**
 * Clear the flag on every boost whose window has passed. Returns how many.
 *
 * A LAZY SWEEP, the same arrangement as expirePerishableItems() in
 * @/lib/perishable: this deployment has no scheduler, so the read paths call
 * it first and scripts/expire-featured.ts is the same function behind a
 * command for when one exists. Unlike that sweep this is plain Prisma -- the
 * cutoff is a constant, not a per-row sum of two columns -- so no raw SQL and
 * no schema qualification to get wrong.
 *
 * Replayable: it compares against `featuredUntil`, never "now minus 24h", and
 * a second run finds nothing. `featuredUntil` and `featuredAt` are left as
 * they were, so the row still says when its last boost ran.
 */
export async function expireFeaturedItems(
  db: Pick<PrismaClient, "item">,
  scope: { userId?: string } = {},
  now: Date = new Date(),
): Promise<number> {
  const { count } = await db.item.updateMany({
    where: {
      isFeatured: true,
      featuredUntil: { lte: now },
      ...(scope.userId ? { userId: scope.userId } : {}),
    },
    data: { isFeatured: false },
  })
  return count
}

/** Whether this listing's boost is live right now. Pure; for the wire shape. */
export function isFeaturedNow(
  row: { isFeatured?: boolean; featuredUntil?: Date | null },
  now: Date = new Date(),
): boolean {
  return !!row.isFeatured && !!row.featuredUntil && row.featuredUntil.getTime() > now.getTime()
}

export type BoostRefusal =
  /** Not the caller's, gone, or taken down. One answer, so ids cannot be probed. */
  | "not_found"
  | "perishable"
  | "not_available"
  | "already_featured"
  | "insufficient_leaves"

export type BoostResult =
  | { ok: true; featuredAt: Date; featuredUntil: Date; balance: number }
  | { ok: false; reason: BoostRefusal; have?: number }

/** Thrown inside the transaction to roll it back; caught by boostItem(). */
class BoostRollback extends Error {
  constructor(readonly result: Extract<BoostResult, { ok: false }>) {
    super(result.reason)
  }
}

type BoostDb = Pick<PrismaClient, "$transaction">

/**
 * Charge `ownerId` BOOST_COST_LEAVES and feature `itemId` for BOOST_HOURS.
 *
 * ONE TRANSACTION, THREE CONDITIONAL WRITES, and any of them failing rolls the
 * others back -- nobody pays for a boost that did not happen, and no listing
 * is featured that was not paid for:
 *
 *   1  the item flips only if it is still this owner's, AVAILABLE,
 *      non-perishable, visible and not already featured. Conditional, so two
 *      racing taps produce one boost and one "already featured".
 *   2  the balance is checked with availableLeaves() -- Leaves pledged to a
 *      PENDING offer are not spendable here either -- and the decrement is
 *      conditional on the balance still covering it, as in holdBridgeFee().
 *   3  the FEATURE_BOOST row, for -cost.
 *
 * The caller must run expireStaleOffers({ senderId }) first, per the note on
 * availableLeaves(): this function does not sweep from inside its own
 * transaction, for the reason given there.
 */
export async function boostItem(
  db: BoostDb,
  input: { itemId: string; ownerId: string; now?: Date },
): Promise<BoostResult> {
  const { itemId, ownerId } = input
  const now = input.now ?? new Date()
  const featuredUntil = new Date(now.getTime() + BOOST_HOURS * 60 * 60 * 1000)
  const cost = BOOST_COST_LEAVES

  try {
    return await db.$transaction(async (tx) => {
      const item = await tx.item.findFirst({
        where: { id: itemId, userId: ownerId, moderationHiddenAt: null },
        select: { title: true, status: true, isPerishable: true, isFeatured: true, featuredUntil: true },
      })
      if (!item) throw new BoostRollback({ ok: false, reason: "not_found" })
      if (item.isPerishable) throw new BoostRollback({ ok: false, reason: "perishable" })
      if (item.status !== "AVAILABLE") throw new BoostRollback({ ok: false, reason: "not_available" })
      if (isFeaturedNow(item, now)) throw new BoostRollback({ ok: false, reason: "already_featured" })

      // 1 -- the claim on the listing, re-asserting everything read above.
      const claimed = await tx.item.updateMany({
        where: {
          id: itemId,
          userId: ownerId,
          status: "AVAILABLE",
          isPerishable: false,
          moderationHiddenAt: null,
          OR: [{ featuredUntil: null }, { featuredUntil: { lte: now } }],
        },
        data: { isFeatured: true, featuredAt: now, featuredUntil },
      })
      if (claimed.count !== 1) throw new BoostRollback({ ok: false, reason: "already_featured" })

      // 2 -- the debit.
      const have = await availableLeaves(tx, ownerId)
      if (have < cost) throw new BoostRollback({ ok: false, reason: "insufficient_leaves", have })
      const moved = await tx.user.updateMany({
        where: { id: ownerId, leaves: { gte: cost } },
        data: { leaves: { decrement: cost } },
      })
      if (moved.count !== 1) throw new BoostRollback({ ok: false, reason: "insufficient_leaves", have })

      // 3 -- the ledger row.
      await tx.leafTransaction.create({
        data: {
          userId: ownerId,
          type: "FEATURE_BOOST",
          amount: -cost,
          description: `Featured "${item.title}" for ${BOOST_HOURS} hours`,
          eventAt: now,
        },
      })

      const after = await tx.user.findUnique({ where: { id: ownerId }, select: { leaves: true } })
      return { ok: true as const, featuredAt: now, featuredUntil, balance: after?.leaves ?? 0 }
    })
  } catch (err) {
    if (err instanceof BoostRollback) return err.result
    throw err
  }
}
