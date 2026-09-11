import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok, unauthenticated, notFound, forbidden, conflict, invalid } from "@/lib/v1/envelope"
import { parseJsonBody } from "@/lib/v1/body"
import { v1Hub } from "@/lib/safe-zones"
import { MEETUP_SELECT, allHubs, listingHubIds, proposableHub, v1MeetupPlan } from "@/lib/meetup"

export const dynamic = "force-dynamic"

/**
 * GET  /api/v1/trades/[id]/meetup — the picker's list, and the standing plan.
 * POST /api/v1/trades/[id]/meetup — propose a place and time, or counter one.
 *
 * ══ WHAT THIS FILLS ═════════════════════════════════════════════════════════
 *
 * Between accepting a trade and meeting for it there was nothing. The hub was
 * claimed at confirm/submit — after the meeting — so two people who had just
 * agreed to swap had no way in the app to settle where or when, and Messages is
 * still a placeholder, so there was no fallback either.
 *
 * ══ A COUNTER IS A PROPOSAL, SO THERE IS NO DECLINE ═════════════════════════
 *
 * POST from the other side overwrites the plan and clears `meetupAgreedAt`.
 * That is the whole disagreement mechanism, and it is deliberately the only one:
 * a bare decline empties the table and leaves both parties where they started,
 * with nothing to react to. Countering always leaves something on it.
 *
 * The cost is that the LAST proposal wins, including over an already-agreed one.
 * That is correct — plans change, and re-proposing is how you say so — but it
 * means an agreed plan can be reopened by one side. It is not silent: the
 * agreement is cleared, so both rows go back to reading "waiting on you", and
 * the other party is notified.
 *
 * ══ AGREEING DOES NOT ISSUE CODES ═══════════════════════════════════════════
 *
 * Nothing here touches the confirmation codes, and the two flows stay
 * independent on purpose. Codes live 15 minutes; minting a pair when a meeting
 * is agreed for next Saturday would expire them days before anybody could read
 * one out. Codes are issued by arriving at the code screen, which is what
 * POST …/confirm/start has always meant.
 */

/**
 * How far ahead a meeting may be arranged.
 *
 * A bound is needed in both directions — an unbounded DateTime accepts the year
 * 9999, and a typo in a date picker is the ordinary way that gets written. Ninety
 * days is well past any real swap and short enough that a mistake is visible.
 */
const MAX_DAYS_AHEAD = 90

/**
 * How far in the past a proposal may sit before it is refused.
 *
 * NOT ZERO. A clock a few minutes fast, or somebody proposing "now" as they
 * stand together, would fail a strict `> now` check for no reason a user could
 * understand. Fifteen minutes of slack costs nothing; a date genuinely in the
 * past is still refused, which is the case worth catching.
 */
const PAST_SLACK_MS = 15 * 60 * 1000

const bodySchema = z.strictObject({
  hubId: z.string().min(1).max(64),
  /**
   * ISO-8601, and a real instant rather than free text.
   *
   * "sat afternoon ha" is what a text field collects, and two people who have
   * exchanged that have not agreed on anything a reminder, a sort, or the other
   * person's calendar can act on. The note field below is where that kind of
   * detail belongs, alongside a time that means something.
   */
  at: z.string().datetime({ offset: true }),
  note: z.string().trim().max(200).optional(),
})

/** The trade columns both handlers need. */
const TRADE_SELECT = {
  id: true,
  status: true,
  senderId: true,
  receiverId: true,
  offeredItemId: true,
  requestedItemId: true,
  ...MEETUP_SELECT,
} as const

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const viewerId = session.user.id
  const { id } = await params

  const trade = await prisma.tradeRequest.findUnique({ where: { id }, select: TRADE_SELECT })
  if (!trade) return notFound("Trade not found")
  if (trade.senderId !== viewerId && trade.receiverId !== viewerId) {
    return forbidden("That trade is not yours")
  }

  /*
   * ── EVERY OPEN HUB IS ON THE TABLE; THE SHARED ONES ARE THE SUGGESTION ──────
   *
   * The list used to be the intersection of the two listings' hubs, and for two
   * people who had each named five different places that was an empty list and
   * nowhere to meet. Now it is every active hub, and the three id lists say
   * which of them each listing already named. The client sorts the shared ones
   * first and badges the rest as new to the other person; the reward still
   * needs a shared one (see `proposableHub()` in lib/meetup.ts).
   *
   * ── AN EMPTY INTERSECTION IS STILL WORTH SAYING ───────────────────────────
   *
   * It is no longer a dead end, but it is the state in which no possible meeting
   * earns the Safe-Zone reward, and the fix is one hub on one listing. Both
   * parties can fix it and each can only fix it on their own side — so the
   * client needs `yourItemId` to send the viewer to their own hub editor, and
   * `theirs` to say which places would become shared the moment they were added.
   */
  const viewerIsSender = trade.senderId === viewerId
  const yourItemId = viewerIsSender ? trade.offeredItemId : trade.requestedItemId
  const theirItemId = viewerIsSender ? trade.requestedItemId : trade.offeredItemId

  const [hubs, named] = await Promise.all([
    allHubs(prisma),
    listingHubIds(prisma, yourItemId, theirItemId),
  ])

  return ok({
    /** Every hub that can be proposed right now — active only. */
    hubs: hubs.filter((h) => h.isActive).map((h) => v1Hub(h)),
    /** Both listings named these. Sort first; the only ones that earn Leaves. */
    sharedHubIds: named.shared,
    /** The viewer's own listing names these. */
    yourHubIds: named.yours,
    /** The other listing names these — proposing one is not new to them. */
    theirHubIds: named.theirs,
    plan: v1MeetupPlan(trade),
    /** Which side the viewer is on, so the client can read `plan.proposedBy`. */
    you: viewerIsSender ? "sender" : "receiver",
    yourItemId,
  })
}

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
  const { hubId, note } = parsed.data

  const trade = await prisma.tradeRequest.findUnique({ where: { id }, select: TRADE_SELECT })
  if (!trade) return notFound("Trade not found")
  if (trade.senderId !== viewerId && trade.receiverId !== viewerId) {
    return forbidden("That trade is not yours")
  }

  /*
   * ACCEPTED ONLY, and both neighbours are excluded for their own reason.
   * PENDING has no deal yet — arranging to meet over a swap the other side has
   * not agreed to is a plan for a thing that may never exist. CONFIRMING means
   * the codes are live and they are already standing together, at which point
   * rearranging the venue is not what either of them needs.
   */
  if (trade.status !== "ACCEPTED") {
    return conflict(
      trade.status === "PENDING"
        ? "That swap has not been accepted yet."
        : "That trade has moved past arranging a meeting.",
    )
  }

  const at = new Date(parsed.data.at)
  const now = Date.now()
  if (at.getTime() < now - PAST_SLACK_MS) {
    return invalid("That time has already passed. Pick a time from now on.")
  }
  if (at.getTime() > now + MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000) {
    return invalid(`Pick a time within the next ${MAX_DAYS_AHEAD} days.`)
  }

  // Any hub that exists and is open. NOT the pre-commitment test the claim
  // applies — the plan is deliberately wider than the claim, and the claim
  // path still applies the strict rule on its own. See proposableHub().
  //
  // The specific reason travels in `meta.rule` rather than as a new top-level
  // error code: /api/v1's code union is closed and stable by design, and these
  // are two ways for one request to be wrong about one field. The client
  // branches on `rule` — SAFEZONE_HUB_CLOSED wants "pick another", while
  // SAFEZONE_HUB_INVALID means the client's list is stale and wants a refetch.
  const check = proposableHub(hubId, await allHubs(prisma))
  if (!check.ok) return invalid(check.message, { rule: check.code })

  const viewerIsSender = trade.senderId === viewerId

  const updated = await prisma.tradeRequest.update({
    where: { id },
    data: {
      meetupHubId: hubId,
      meetupAt: at,
      meetupNote: note && note.length > 0 ? note : null,
      meetupProposedBySender: viewerIsSender,
      // A new proposal is unanswered by definition, including when it replaces
      // one that had been agreed. The whole group moves together.
      meetupAgreedAt: null,
    },
    select: TRADE_SELECT,
  })

  const partnerId = viewerIsSender ? trade.receiverId : trade.senderId

  // The actor is carried in `actorId` and rendered by the client, the same way
  // every other notification on this table reads ("<name> made you an offer").
  // Putting the proposer's name in the message too would say it twice.
  await prisma.notification.create({
    data: {
      userId: partnerId,
      type: "MEETUP_PROPOSED",
      message: `suggested meeting at ${check.hub.name}`,
      actorId: viewerId,
      // "meetup", NOT "trade" — a trade notification opens the confirmation
      // codes, and those live 15 minutes. See the enum's note.
      entityType: "meetup",
      entityId: trade.id,
    },
  }).catch(() => {
    // The plan is written and that is the outcome the caller asked for. A failed
    // notification must not turn a successful arrangement into an error the
    // client will retry, which would then write the same plan twice.
  })

  return ok({ plan: v1MeetupPlan(updated) })
}
