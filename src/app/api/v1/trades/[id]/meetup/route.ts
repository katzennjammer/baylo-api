import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import type { Prisma } from "@/generated/prisma/client"
import { ok, unauthenticated, notFound, forbidden, conflict, fail, invalid } from "@/lib/v1/envelope"
import { parseJsonBody } from "@/lib/v1/body"
import { resolveTradeParticipant } from "@/lib/trade-participant"
import { v1Hub } from "@/lib/safe-zones"
import { MEETUP_SELECT, allHubs, listingHubIds, proposableHub, v1MeetupPlan } from "@/lib/meetup"
import { notifyMeetupChanged } from "@/lib/meetup-events"

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
 * A counter overwrites the plan and clears `meetupAgreedAt`. That is the whole
 * disagreement mechanism, and it is deliberately the only one: a bare decline
 * empties the table and leaves both parties where they started, with nothing to
 * react to. Countering always leaves something on it.
 *
 * ══ A COUNTER MUST NAME WHAT IT REPLACES ════════════════════════════════════
 *
 * Until 8 Oct 2026 any POST overwrote whatever stood, and a two-phone test
 * showed what that costs: B's screen still read "Choose a hub" after A had
 * suggested one, B picked, and A's suggestion vanished under B's without
 * either of them being told. A "fresh" pick and a counter looked identical.
 *
 * So the body now says which it is. Without `replaces` it is a FRESH pick and
 * is only legal on an empty table or over the caller's own unanswered
 * suggestion ("Change suggestion"). With `replaces` it is a COUNTER, and it
 * lands only if the plan standing is still the one it names — hub, instant,
 * and side. That includes reopening an AGREED plan: allowed, because plans
 * change, but only by somebody who saw the agreement and countered it, never
 * by a stale screen. Everything else is a 409 carrying the plan that IS
 * standing, so the client can show it with Agree / Suggest another.
 *
 * The precondition is the WHERE of a single UPDATE, not a read followed by a
 * write: two suggestions sent at the same moment cannot both match it, so
 * exactly one wins and the other gets the 409.
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
  /**
   * The standing plan this counters, as the caller's screen showed it. Present
   * means "Suggest another"; absent means a fresh pick. See the header.
   */
  replaces: z
    .strictObject({
      hubId: z.string().min(1).max(64),
      at: z.string().datetime({ offset: true }),
      proposedBy: z.enum(["sender", "receiver"]),
    })
    .optional(),
})

/**
 * The 409 for "that is not the plan standing any more", with the plan that is.
 *
 * `meta.rule` rather than new top-level codes, for the reason the hub check
 * below gives: /api/v1's code union is closed. The client branches on it.
 *   MEETUP_PENDING_FROM_PARTNER  the other side has an unanswered suggestion
 *   MEETUP_ALREADY_AGREED        the plan is agreed; reopening it is a counter
 *   MEETUP_CHANGED               the plan the counter named has been replaced
 */
type PlanRule = "MEETUP_PENDING_FROM_PARTNER" | "MEETUP_ALREADY_AGREED" | "MEETUP_CHANGED"

const PLAN_CONFLICT_MESSAGE: Record<PlanRule, string> = {
  MEETUP_PENDING_FROM_PARTNER: "The other trader already suggested a meeting. Agree to it, or suggest another.",
  MEETUP_ALREADY_AGREED: "You have both agreed a meeting already. Have another look before changing it.",
  MEETUP_CHANGED: "That plan changed before your suggestion went through. Have another look.",
}

function planConflict(rule: PlanRule, plan: ReturnType<typeof v1MeetupPlan>) {
  return conflict(PLAN_CONFLICT_MESSAGE[rule], { rule, plan })
}

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
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const { id } = await params

  const trade = await prisma.trade.findUnique({ where: { id }, select: TRADE_SELECT })
  // A deal still in its offer phase is not a trade yet (schema v2).
  if (!trade || trade.status === null) return notFound("Trade not found")
  // Either side: the person, or the shop they are acting as. See
  // @/lib/trade-participant.
  const who = await resolveTradeParticipant(session.user.id, req.headers, trade)
  if (!who.ok) {
    return who.kind === "org_refused" ? fail("ORG_CONTEXT_REFUSED", who.message) : forbidden("That trade is not yours")
  }
  const viewerId = who.participantId

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
  // offeredItemId is set on every trade (a schema v2 CHECK); `as string` for the type.
  const yourItemId = viewerIsSender ? (trade.offeredItemId as string) : trade.requestedItemId
  const theirItemId = viewerIsSender ? trade.requestedItemId : (trade.offeredItemId as string)

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
  const { id } = await params

  const parsed = await parseJsonBody(req, bodySchema)
  if (!parsed.ok) return parsed.response
  const { hubId, note } = parsed.data

  const trade = await prisma.trade.findUnique({ where: { id }, select: TRADE_SELECT })
  // A deal still in its offer phase is not a trade yet (schema v2).
  if (!trade || trade.status === null) return notFound("Trade not found")
  // Either side: the person, or the shop they are acting as. See
  // @/lib/trade-participant.
  const who = await resolveTradeParticipant(session.user.id, req.headers, trade)
  if (!who.ok) {
    return who.kind === "org_refused" ? fail("ORG_CONTEXT_REFUSED", who.message) : forbidden("That trade is not yours")
  }
  const viewerId = who.participantId

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
  const replaces = parsed.data.replaces

  /*
   * The precondition, as a WHERE. Read above only to choose WHICH condition
   * applies; whether it still holds is decided by the UPDATE itself.
   */
  let guard: Prisma.TradeWhereInput
  if (replaces) {
    // A counter: lands only on the exact plan the caller's screen showed.
    guard = {
      meetupHubId: replaces.hubId,
      meetupAt: new Date(replaces.at),
      meetupProposedBySender: replaces.proposedBy === "sender",
    }
  } else if (trade.meetupHubId === null) {
    guard = { meetupHubId: null }
  } else if (trade.meetupProposedBySender === viewerIsSender && trade.meetupAgreedAt === null) {
    // "Change suggestion": your own, still unanswered.
    guard = { meetupProposedBySender: viewerIsSender, meetupAgreedAt: null }
  } else {
    return planConflict(
      trade.meetupAgreedAt ? "MEETUP_ALREADY_AGREED" : "MEETUP_PENDING_FROM_PARTNER",
      v1MeetupPlan(trade),
    )
  }

  const written = await prisma.trade.updateMany({
    // status too: the trade can move to CONFIRMING between the read and here.
    where: { id, status: "ACCEPTED", ...guard },
    data: {
      meetupHubId: hubId,
      meetupAt: at,
      meetupNote: note && note.length > 0 ? note : null,
      meetupProposedBySender: viewerIsSender,
      // A new proposal is unanswered by definition, including when it replaces
      // one that had been agreed. The whole group moves together.
      meetupAgreedAt: null,
    },
  })

  const updated = await prisma.trade.findUnique({ where: { id }, select: TRADE_SELECT })
  if (!updated) return notFound("Trade not found")

  if (written.count === 0) {
    // Somebody else's write got there first. Say what is standing NOW.
    if (updated.status !== "ACCEPTED") return conflict("That trade has moved past arranging a meeting.")
    const partnerPending =
      updated.meetupHubId !== null &&
      updated.meetupAgreedAt === null &&
      updated.meetupProposedBySender !== viewerIsSender
    return planConflict(partnerPending ? "MEETUP_PENDING_FROM_PARTNER" : "MEETUP_CHANGED", v1MeetupPlan(updated))
  }

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

  // The partner's phone learns NOW, not on its next pull. See lib/meetup-events.
  await notifyMeetupChanged(partnerId, { tradeId: trade.id, kind: "proposed", actorId: viewerId })

  return ok({ plan: v1MeetupPlan(updated) })
}
