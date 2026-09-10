import type { PrismaClient } from "@/generated/prisma/client"
import { COMMITTING_STATUSES } from "@/lib/contracts"

/**
 * Offers, and the one thing that was missing from them: an end.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * An offer had no expiry. It sat PENDING until the receiver acted, and if they
 * never did, it sat PENDING forever. That was not a cosmetic gap:
 *
 *   - `availableLeaves()` subtracts every PENDING offer's `offeredLeaves` from
 *     the sender's balance. Leaves pledged to an offer nobody would ever answer
 *     were held indefinitely.
 *   - The app said otherwise. The offer screen's footnote reads "Marco has
 *     three days to reply." and its pending state reads "then it expires on its
 *     own." Both were false, and a promise the product makes and the database
 *     does not keep is the worst of the three possible states.
 *
 * ── THE WINDOW IS THREE DAYS ────────────────────────────────────────────────
 *
 * Three reasons, in the order they decided it:
 *
 *   1. The copy already committed to it, in two places, and the mobile client
 *      already computes its "Marco has until Tuesday" line as createdAt + 3
 *      days. Picking any other number would mean the server and the sentence on
 *      the sender's screen disagreed about the same deadline.
 *   2. The Leaves are HELD, not spent — the whole time an offer is open the
 *      sender cannot commit that balance anywhere else. A long window is a real
 *      cost to the person who did the reaching out, which argues down.
 *   3. Against which: this is not a trading desk. Somebody who opens the app
 *      twice a week has to get a chance to answer, which argues up. Three days
 *      is the shortest window that survives a weekend on either side of it.
 *
 * ── DERIVED FROM `createdAt`, WITH NO `expiresAt` COLUMN ────────────────────
 *
 * One less column, one less backfill, and the window lives in exactly one
 * place. The cost is real and worth naming: changing OFFER_EXPIRY_DAYS re-dates
 * every live offer rather than only new ones. At a three-day window and a lazy
 * sweep that blast radius is small, and if the window ever becomes a per-offer
 * or per-category thing it has to become a column — at which point this comment
 * is the note saying why it was not one to begin with.
 *
 * ── A LAZY SWEEP, BECAUSE THERE IS NO CRON ──────────────────────────────────
 *
 * The same arrangement `sweepLapsedContracts()` uses, and for the same reason:
 * nothing on this deployment runs on a schedule. So the sweep runs on the reads
 * that would otherwise act on stale data — every path that measures a balance,
 * and every path that asks whether an offer is still live. If it did not, a
 * sender would be told they had 40 fewer Leaves than they really did.
 */

type OfferDb = Pick<PrismaClient, "offer" | "deferredContract" | "notification">

/** The window, in days. See the long note above before changing it. */
export const OFFER_EXPIRY_DAYS = 3

const DAY_MS = 24 * 60 * 60 * 1000

/** When an offer created at `createdAt` stops being answerable. */
export function offerExpiresAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + OFFER_EXPIRY_DAYS * DAY_MS)
}

/** The cutoff a sweep compares `createdAt` against. */
export function offerExpiryCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - OFFER_EXPIRY_DAYS * DAY_MS)
}

/**
 * Moves PENDING offers past their window to EXPIRED, and releases what they held.
 *
 * ── EXPIRED IS ITS OWN STATUS, NOT A REUSE OF DECLINED ──────────────────────
 *
 * Three terminal states now, performed by three different parties and saying
 * three different things:
 *
 *   DECLINED   the receiver looked and said no.
 *   WITHDRAWN  the sender changed their mind.
 *   EXPIRED    nobody did anything.
 *
 * Collapsing the third into the first would tell a sender, permanently, that
 * they were refused by someone who in fact never opened the message. That is a
 * fact about another person that the database would be inventing.
 *
 * ── THE LEAVES COME BACK WITH NO SEPARATE STEP ──────────────────────────────
 *
 * `availableLeaves()` counts only PENDING rows, so the moment the status moves
 * the arithmetic changes. There is nothing to credit and nothing to get out of
 * step — which is also why this sweep can run from any read path without a
 * transaction around it.
 *
 * ── AND SO DOES THE PROMISE ─────────────────────────────────────────────────
 *
 * A deferred agreement proposed alongside an expiring offer goes DECLINED, for
 * the same reason it does when the offer is declined or withdrawn: nobody broke
 * anything, and the debtor's one contract slot has to come free or an offer
 * nobody ever read would lock them out of proposing for good.
 *
 * `scope` narrows the work. A balance read sweeps that sender's offers; an item
 * detail sweeps that listing's. Unscoped is every stale offer, which no request
 * path asks for today.
 */
export async function expireStaleOffers(
  db: OfferDb,
  scope: { senderId?: string; postId?: string } = {},
): Promise<number> {
  const cutoff = offerExpiryCutoff()

  const stale = await db.offer.findMany({
    where: {
      status: "PENDING",
      createdAt: { lt: cutoff },
      ...(scope.senderId ? { senderId: scope.senderId } : {}),
      ...(scope.postId ? { postId: scope.postId } : {}),
    },
    select: {
      id: true,
      senderId: true,
      offeredLeaves: true,
      post: { select: { title: true } },
      contracts: {
        where: { status: { in: [...COMMITTING_STATUSES] } },
        select: { id: true },
        take: 1,
      },
    },
  })
  if (stale.length === 0) return 0

  let expired = 0
  for (const offer of stale) {
    // Conditional on PENDING, so two concurrent sweeps produce one expiry and
    // one no-op rather than two. Same guard every other transition here uses.
    const moved = await db.offer.updateMany({
      where: { id: offer.id, status: "PENDING" },
      data: { status: "EXPIRED" },
    })
    // count === 0 means another request got there first — the receiver accepted
    // it a moment ago, or the sender withdrew it. Not an error, and emphatically
    // not a reason to expire a contract or send a notification for it.
    if (moved.count !== 1) continue
    expired += 1

    if (offer.contracts[0]) {
      await db.deferredContract.updateMany({
        where: { id: offer.contracts[0].id, status: "PENDING_ACCEPT" },
        data: { status: "DECLINED" },
      })
    }

    /*
     * The sender is told, because something of theirs changed while they were
     * not looking and their balance moved with it.
     *
     * Best-effort: a notification that fails to write must not roll back an
     * expiry that has already happened, or the offer would stay PENDING and
     * keep holding the Leaves — which is the exact harm this function exists to
     * end. The receiver is NOT notified: they were the one who did not answer,
     * and telling them so is a reproach rather than information.
     */
    try {
      await db.notification.create({
        data: {
          userId: offer.senderId,
          type: "OFFER_EXPIRED",
          message:
            `your offer on "${offer.post.title}" expired after ${OFFER_EXPIRY_DAYS} days` +
            (offer.offeredLeaves
              ? ` — ${offer.offeredLeaves} Leaves are back in your balance`
              : ""),
          link: `/dashboard/tradeplace`,
        },
      })
    } catch {
      // See above.
    }
  }

  return expired
}
