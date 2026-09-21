import type { PrismaClient } from "@/generated/prisma/client"
import { releaseBridgeFee } from "@/lib/bridge-fee"

/**
 * Offers, and the one thing that was missing from them: an end.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * An offer had no expiry. It sat PENDING until the receiver acted, and if they
 * never did, it sat PENDING forever. That was not a cosmetic gap:
 *
 *   - Leaves committed to an offer nobody would ever answer were held
 *     indefinitely. That was `offeredLeaves` then and it is the BRIDGING FEE
 *     now, which is a stronger version of the same problem: the fee has
 *     actually left the proposer's balance (see @/lib/bridge-fee), so an offer
 *     that never ends is Leaves that never come back.
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

type OfferDb = Pick<PrismaClient, "offer" | "notification" | "user" | "leafTransaction">

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
 * ── THE FEE COMES BACK, AND IT IS A WRITE NOW ───────────────────────────────
 *
 * It used to be arithmetic: `availableLeaves()` counted only PENDING rows, so
 * moving the status was the whole of the release and this sweep could run from
 * any read path without a transaction. The bridging fee is a real debit, so
 * expiry has to CREDIT it back and write a BRIDGE_FEE_RELEASE row — and the
 * status change and the credit have to be one transaction, or an offer can
 * read EXPIRED with its fee still in escrow.
 *
 * That is the cost of the hold being real, and it is paid here: one small
 * transaction per expiring offer, on a path that finds one stale offer on a
 * quiet day and none most of the time. The conditional status write inside it
 * is still what makes two concurrent sweeps produce one expiry.
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
      bridgeFeeLeaves: true,
      offeredBracket: true,
      targetBracket: true,
      post: { select: { id: true, title: true } },
    },
  })
  if (stale.length === 0) return 0

  let expired = 0
  for (const offer of stale) {
    /*
     * ONLY A PROPOSER-PAID FEE IS IN ESCROW.
     *
     * `bridgeFeeLeaves` is the quoted price of the bridge and is set in both
     * directions. It is HELD only when the proposer is the payer -- when they
     * offered the lower-bracket item. An offer of something HIGHER quotes a fee
     * the receiver would have paid on accepting, and an offer that expires was
     * never accepted, so nothing was ever taken and there is nothing to give
     * back. Refunding it would mint Leaves from a price tag.
     */
    const proposerPaid =
      offer.offeredBracket !== null &&
      offer.targetBracket !== null &&
      offer.offeredBracket < offer.targetBracket
    const fee = proposerPaid ? offer.bridgeFeeLeaves ?? 0 : 0

    // The status and the refund together. Conditional on PENDING, so two
    // concurrent sweeps produce one expiry and one no-op rather than two, and
    // the transaction means the refund cannot outlive a rolled-back expiry or
    // the reverse.
    const released = await runExpiry(db, offer.id, offer.senderId, fee)
    // false means another request got there first — the receiver accepted it a
    // moment ago, or the sender withdrew it. Not an error, and emphatically not
    // a reason to send a notification for it.
    if (!released) continue
    expired += 1

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
            `Your offer on "${offer.post.title}" expired after ${OFFER_EXPIRY_DAYS} days` +
            (fee > 0
              ? ` — your ${fee}-Leaf bridging fee is back in your balance`
              : offer.offeredLeaves
                ? ` — ${offer.offeredLeaves} Leaves are back in your balance`
                : ""),
          link: `/dashboard/tradeplace`,
          entityType: "item",
          entityId: offer.post.id,
        },
      })
    } catch {
      // See above.
    }
  }

  return expired
}

/**
 * One offer's expiry: the conditional status write and, when there is a fee,
 * the refund, in one transaction. Returns true when THIS call expired it.
 *
 * Split out so the loop above reads as the policy it is. The narrow `OfferDb`
 * is what lets `expireStaleOffers` run against a transaction client from a
 * caller that already has one -- but a nested `$transaction` is not something
 * every client supports, so this takes the interactive path only when the
 * client offers one and falls back to sequential writes otherwise. The
 * fallback's failure mode is the one the old code had for the status alone,
 * and it is confined to a caller that is already inside a transaction of its
 * own -- where the enclosing rollback covers both writes anyway.
 */
async function runExpiry(
  db: OfferDb,
  offerId: string,
  senderId: string,
  fee: number,
): Promise<boolean> {
  const work = async (tx: OfferDb) => {
    const moved = await tx.offer.updateMany({
      where: { id: offerId, status: "PENDING" },
      data: { status: "EXPIRED" },
    })
    if (moved.count !== 1) return false
    if (fee > 0) {
      await releaseBridgeFee(tx, { userId: senderId, offerId, amount: fee, reason: "expired" })
    }
    return true
  }

  const client = db as OfferDb & { $transaction?: (fn: (tx: OfferDb) => Promise<boolean>) => Promise<boolean> }
  if (typeof client.$transaction === "function") return client.$transaction(work)
  return work(db)
}

/**
 * `Offer.offeredItems` is a JSON string written by a client. Parsed defensively.
 *
 * Anything that is not an object with a non-empty string `id` is dropped, and a
 * malformed blob yields `[]` rather than throwing. Since 16 Sep 2026 a new
 * offer always holds exactly one entry; older rows may hold several, and the
 * FIRST is the one every shipped client ever sent and the one the chat card
 * drew, so that is the one the accept path reads.
 *
 * It lived in @/lib/contracts, which was where the DPA value arithmetic
 * happened to need it. That file is gone; the function is about offers.
 */
export function parseOfferedItemIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((x): x is { id?: unknown } => !!x && typeof x === "object")
      .map((x) => x.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
  } catch {
    return []
  }
}
