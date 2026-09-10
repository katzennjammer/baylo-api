import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import pusher from "@/lib/pusher"
import { COMMITTING_STATUSES } from "@/lib/contracts"
import { leafBalances } from "@/lib/leaves"
import { expireStaleOffers } from "@/lib/offers"
import { ok, unauthenticated, notFound, conflict } from "@/lib/v1/envelope"
import { parseJsonBody } from "@/lib/v1/body"

export const dynamic = "force-dynamic"

/**
 * POST /api/v1/offers/[id]/withdraw — the SENDER takes their offer back.
 *
 * ── WHY THIS ROUTE HAD TO EXIST ─────────────────────────────────────────────
 *
 * There was no way out of a sent offer. PATCH /api/offers/[id] is the
 * RECEIVER's accept/decline and 403s the sender; there was no DELETE; and
 * `OfferStatus` had only PENDING / ACCEPTED / DECLINED, so there was not even a
 * state to move to. A sender was held until the other person acted, and the
 * consequences were not cosmetic:
 *
 *   - `availableLeaves()` subtracts every PENDING offer's `offeredLeaves` from
 *     the sender's balance. Leaves pledged to an offer nobody ever answered were
 *     held indefinitely, and the sender could not release them.
 *   - Sending an offer to a stranger who abandons the app cost the sender a
 *     permanent slice of their balance with no recourse.
 *
 * WITHDRAWN is a distinct status rather than a reuse of DECLINED, because they
 * are performed by different people and say different things: DECLINED is "they
 * looked and said no", WITHDRAWN is "I changed my mind". Collapsing them would
 * make a sender's own retraction read, forever, as a refusal by someone else.
 *
 * ── WHAT COMES BACK WITH IT ─────────────────────────────────────────────────
 *
 * The pledged Leaves, immediately and with no separate release step:
 * `availableLeaves()` counts only PENDING rows, so the moment the status moves
 * the arithmetic changes. That is why the balance is returned in the response —
 * it is the number the sender came here to change, and making them refetch it
 * would leave the screen showing the old one.
 *
 * A deferred agreement proposed alongside the offer goes DECLINED, for the same
 * reason it does when the receiver declines: it is off the table, nobody broke
 * a promise, and the debtor's one contract slot has to come free or a withdrawn
 * offer would lock them out of proposing for good.
 *
 * ── ONE THING IT DELIBERATELY DOES NOT DO ───────────────────────────────────
 *
 * It does not delete the chat message the offer created. The conversation
 * happened; the other person read "I'll trade you my chair" and may have replied
 * to it, and erasing the message would leave their reply answering nothing. The
 * offer card in that thread reports WITHDRAWN, which is the truthful rendering.
 */

const bodySchema = z.strictObject({})

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const viewerId = session.user.id
  const { id } = await params

  const parsed = await parseJsonBody(req, bodySchema)
  if (!parsed.ok) return parsed.response

  // An offer past its window is already over. Sweeping first means this reports
  // "already expired" rather than performing a withdrawal of something that
  // should not have been withdrawable — and the Leaves come back either way.
  await expireStaleOffers(prisma)

  const offer = await prisma.offer.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      senderId: true,
      receiverId: true,
      offeredLeaves: true,
      post: { select: { title: true } },
      contracts: {
        where: { status: { in: [...COMMITTING_STATUSES] } },
        select: { id: true },
        take: 1,
      },
    },
  })
  if (!offer) return notFound("Offer not found")

  // ONLY THE SENDER. A receiver "withdrawing" someone else's offer is a decline,
  // and it has its own route — 404 rather than 403, the same disclosure rule the
  // rest of v1 follows.
  if (offer.senderId !== viewerId) return notFound("Offer not found")

  /*
   * Only a live offer.
   *
   * An ACCEPTED one is a trade now; there is no unilateral exit from a deal the
   * other person has already agreed to, and the items may already have changed
   * hands. That is the same rule /contracts/[id]/decline applies to an ACTIVE
   * agreement, and for the same reason.
   */
  if (offer.status !== "PENDING") {
    return conflict(
      offer.status === "ACCEPTED"
        ? "This offer was already accepted and is a trade now."
        : `This offer is already ${offer.status.toLowerCase()}.`,
      { status: offer.status },
    )
  }

  // Conditional on PENDING, so two taps produce one withdrawal and one 409
  // rather than two — the same guard the contract routes use.
  const moved = await prisma.offer.updateMany({
    where: { id: offer.id, status: "PENDING" },
    data: { status: "WITHDRAWN" },
  })
  if (moved.count !== 1) {
    return conflict("This offer was just resolved by another request")
  }

  // The promise goes with it. See the header.
  if (offer.contracts[0]) {
    await prisma.deferredContract.updateMany({
      where: { id: offer.contracts[0].id, status: "PENDING_ACCEPT" },
      data: { status: "DECLINED" },
    })
  }

  // Read AFTER the status moved, so it reflects the released Leaves rather than
  // the balance the sender already had on screen.
  const balances = await leafBalances(prisma, viewerId)

  // The receiver's open offer card has to stop being actionable. Best-effort, in
  // the same shape the accept/decline path uses — a dropped realtime event means
  // a stale card until the next fetch, never a wrong database state.
  pusher
    .trigger(`private-user-${offer.receiverId}`, "offer-updated", {
      offerId: offer.id,
      status: "WITHDRAWN",
    })
    .catch(() => {})

  return ok(
    {
      offer: { id: offer.id, status: "WITHDRAWN" },
      viewer: { leaves: balances.leaves, availableLeaves: balances.available },
    },
    {
      releasedLeaves: offer.offeredLeaves ?? 0,
      contractDeclined: offer.contracts.length > 0,
    },
  )
}
