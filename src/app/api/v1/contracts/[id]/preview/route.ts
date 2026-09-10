import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { loadStanding } from "@/lib/reputation-gate"
import {
  sweepLapsedContracts,
  netValueTo,
  offerAsTradeSides,
  parseOfferedItemIds,
} from "@/lib/contracts"
import { ok, unauthenticated, notFound } from "@/lib/v1/envelope"
import { parseQuery } from "@/lib/v1/query"
import { V1_CONTRACT_SELECT, V1_CONTRACT_PARTIES_SELECT, v1Contract, type V1ContractRow } from "@/lib/v1/contract"

export const dynamic = "force-dynamic"

/**
 * GET /api/v1/contracts/[id]/preview — what the creditor sees before accepting.
 *
 * THIS ENDPOINT IS THE FEATURE'S ONLY REAL DEFENCE, and it is worth being blunt
 * about why. Nothing downstream of acceptance can compel payment: there is no
 * repossession, no reversal, no way to take the item back. Once the creditor
 * says yes, the debtor's incentive to pay is reputational, and reputation only
 * works on someone who intends to keep trading. Against a debtor who does not,
 * the platform has nothing.
 *
 * So the moment of protection is BEFORE the yes, and it consists entirely of
 * showing the creditor what they are actually agreeing to. That is what turns
 * an unenforceable promise into an informed decision — not a promise that is
 * any more enforceable, but a decision the creditor made with the debtor's
 * record in front of them. The four statistics below are the record:
 *
 *   completedTrades  — has this person finished anything at all?
 *   outstandingDebt  — how much are they already promising other people?
 *   onTimeRate       — when they have promised before, did they deliver?
 *   pastDefaults     — how many times has someone in your position lost?
 *
 * A creditor who accepts after reading this has made a bet they can see. A
 * creditor who was never shown it was simply exposed. That is the entire
 * difference the endpoint makes, and it is why the accept endpoint should never
 * have shipped without it.
 *
 * Both parties may read it. The debtor seeing their own record exactly as the
 * creditor will is good faith, not a leak — every figure here is derived from
 * the debtor's own contracts and trades.
 *
 * ── IT WORKS WITH NO TRADE, AND THE REASON MATTERS ──────────────────────────
 *
 * A contract may now hang off an OFFER, which means this endpoint can be asked
 * about a promise attached to something that is not a trade yet. Nothing that
 * actually protects the creditor changes: `debtorStats` and `debtor` come from
 * `loadStanding(debtorId)`, which has never touched the trade — it counts the
 * debtor's completed trades, their open contracts and their defaults, all of
 * which are properties of the person rather than of this deal.
 *
 * What has to be re-derived is the `trade` block — which item each party walks
 * away with, and the value difference — and an Offer carries exactly those three
 * facts in a different shape. `offerAsTradeSides()` reduces it, so the value
 * arithmetic below is the same subtraction in both cases rather than a second
 * copy that can drift.
 *
 * `trade.id` is null and `trade.status` reports the OFFER's status in that
 * case. Both are labelled on the wire by `subject`, so a client renders "this
 * promise is attached to an offer that is still pending" rather than inferring
 * it from a null.
 */

const querySchema = z.strictObject({})

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const viewerId = session.user.id
  const { id } = await params

  const parsed = parseQuery(req, querySchema)
  if (!parsed.ok) return parsed.response

  // Sweep this contract first, so a preview never shows ACTIVE for something
  // whose deadline passed while nobody was looking.
  await sweepLapsedContracts(prisma, { contractId: id })

  const contract = await prisma.deferredContract.findUnique({
    where: { id },
    select: {
      ...V1_CONTRACT_SELECT,
      ...V1_CONTRACT_PARTIES_SELECT,
      trade: {
        select: {
          id: true,
          status: true,
          senderId: true,
          receiverId: true,
          offeredLeaves: true,
          offeredItem: { select: { id: true, title: true, valueLeaves: true } },
          requestedItem: { select: { id: true, title: true, valueLeaves: true } },
        },
      },
      offer: {
        select: {
          id: true,
          status: true,
          senderId: true,
          receiverId: true,
          offeredLeaves: true,
          offeredItems: true,
          post: { select: { id: true, title: true, valueLeaves: true } },
        },
      },
    },
  })
  if (!contract) return notFound("Contract not found")
  if (contract.debtorId !== viewerId && contract.creditorId !== viewerId) {
    return notFound("Contract not found")
  }

  // The debtor's standing, swept and derived fresh. loadStanding() re-runs the
  // sweep scoped to the debtor, which also catches their OTHER lapsed contracts
  // — a creditor deciding on this proposal needs those counted as defaults.
  const debtor = await loadStanding(contract.debtorId)

  /*
   * The deal this promise is about, from whichever side carries it.
   *
   * Exactly one of `trade` / `offer` is loaded — `contractSubject()`'s rule —
   * and both are reduced to the same three answers so everything below reads
   * the same either way.
   */
  const trade = contract.trade
  const offer = contract.offer

  let sides: Parameters<typeof netValueTo>[0]
  let subjectId: string | null
  let subjectStatus: string
  let subjectKind: "trade" | "offer"
  let leavesMovingNow: number | null
  let debtorReceives: { id: string; title: string; valueLeaves: number | null } | null
  let debtorGives: { id: string; title: string; valueLeaves: number | null } | null

  if (trade) {
    // Which item each party actually walks away with, so the creditor can see
    // the trade they are being asked to underwrite rather than two ids.
    const debtorIsSender = trade.senderId === contract.debtorId
    sides = trade
    subjectId = trade.id
    subjectStatus = trade.status
    subjectKind = "trade"
    leavesMovingNow = trade.offeredLeaves
    debtorReceives = debtorIsSender ? trade.requestedItem : trade.offeredItem
    debtorGives = debtorIsSender ? trade.offeredItem : trade.requestedItem
  } else if (offer) {
    // On an offer the debtor is always the SENDER — the propose route refuses
    // any other party — so the sides are not conditional the way a trade's are.
    const itemIds = parseOfferedItemIds(offer.offeredItems)
    const offeredRows = itemIds.length
      ? await prisma.item.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, title: true, valueLeaves: true },
        })
      : []

    sides = offerAsTradeSides({
      senderId: offer.senderId,
      receiverId: offer.receiverId,
      offeredLeaves: offer.offeredLeaves,
      post: offer.post,
      offeredItems: offeredRows,
    })
    subjectId = offer.id
    subjectStatus = offer.status
    subjectKind = "offer"
    leavesMovingNow = offer.offeredLeaves
    // The sender receives the listing and gives what they put up. Several
    // offered items are reported as the first plus a count in the title, because
    // this block is one line on the creditor's screen and the full list is on
    // the offer itself.
    debtorReceives = { ...offer.post, title: offer.post.title }
    debtorGives =
      offeredRows.length === 0
        ? null
        : offeredRows.length === 1
          ? offeredRows[0]
          : {
              id: offeredRows[0].id,
              title: `${offeredRows[0].title} and ${offeredRows.length - 1} more`,
              valueLeaves: offeredRows.every((r) => r.valueLeaves !== null)
                ? offeredRows.reduce((n, r) => n + (r.valueLeaves ?? 0), 0)
                : null,
            }
  } else {
    // Neither. `contractSubject()` documents why this is a bug rather than a
    // state to render around; here it is a 404 rather than a throw, because a
    // creditor should not meet a stack trace on the screen that protects them.
    return notFound("Contract not found")
  }

  const net = netValueTo(sides, contract.debtorId)

  return ok({
    contract: v1Contract(contract as V1ContractRow, viewerId),

    /** The four statistics the decision rests on. */
    debtorStats: {
      completedTrades: debtor.completedTrades,
      outstandingDebt: debtor.outstandingDebt,
      // Null when this debtor has never finished a contract. A client MUST
      // render that as "no history" and not as 0% — a first-time debtor is
      // unproven, not proven bad, and the two deserve different answers.
      onTimeFulfillmentRate: debtor.onTimeRate,
      pastDefaults: debtor.lifetimeDefaults,
    },

    /** Context for reading those four numbers. */
    debtor: {
      id: debtor.userId,
      name: contract.debtor?.name ?? null,
      avatar: contract.debtor?.avatar ?? null,
      tier: debtor.tier,
      baseTier: debtor.baseTier,
      rating: debtor.rating,
      finishedContracts: debtor.finishedContracts,
      hasUnsettledDefault: debtor.hasUnsettledDefault,
      debtCeiling: debtor.limits.maxOutstandingDebtLeaves,
    },

    /**
     * Kept under the name `trade` so a shipped client that reads it keeps
     * working, and labelled with `subject` so a new one can tell the difference.
     * `id` is the trade's or the offer's; `status` likewise. See the header.
     */
    trade: {
      id: subjectId,
      status: subjectStatus,
      subject: subjectKind,
      offeredLeaves: leavesMovingNow,
      debtorReceives,
      debtorGives,
      valueDifferenceLeaves: net,
    },

    /**
     * What the creditor is actually agreeing to, spelled out rather than left
     * to be inferred from the fields above. `noItemReturn` is not a disclaimer
     * bolted on — it is the true statement of what the platform will do if this
     * goes wrong, and a creditor who has not been told it has not been informed.
     */
    terms: {
      youReceiveNow: debtorGives,
      youGiveNow: debtorReceives,
      theyOweYou: contract.amountLeaves,
      byDeadline: contract.deadline,
      extensionsPossible: contract.extensionUsed ? 0 : 1,
      onDefault: [
        "The debt remains owed in full and keeps collecting from their earnings.",
        "They are blocked from starting new trades until it is settled.",
        "Their trust tier drops and the default is shown on their profile permanently.",
      ],
      noItemReturn:
        "The item does not come back. This platform cannot repossess or reverse a swap — " +
        "if they never pay, you keep the reputational record and nothing else.",
    },
  })
}
