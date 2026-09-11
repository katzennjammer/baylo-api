import type { PrismaClient } from "@/generated/prisma/client"
import { SAFE_ZONE_HUB_SELECT, v1Hub, type SafeZoneHubRow, type V1Hub } from "./safe-zones"

/**
 * The meetup PLAN — arranging where and when, after accepting and before meeting.
 *
 * ══ WHY THIS IS NOT `safeZoneHubId` ═════════════════════════════════════════
 *
 * There are two hub facts on a trade and they are not the same fact:
 *
 *   the CLAIM   `TradeRequest.safeZoneHubId`, written at confirm/submit, after
 *               both codes match. It means "we met here" and it is what the
 *               SAFEZONE_MEETUP award reads — the condition is literally
 *               `safeZoneHubId IS NOT NULL`.
 *   the PLAN    `TradeRequest.meetupHubId`, written here. It means "let us meet
 *               here" and it awards nothing at all.
 *
 * Collapsing them into one column would mint 10 Leaves at the moment one person
 * SUGGESTED a place — for a meeting that had not happened, on the say-so of one
 * side. The plan is a convenience; only the exchanged codes are evidence. What
 * the plan is allowed to do is become the DEFAULT for the claim at confirmation,
 * so nobody is asked the same question twice.
 *
 * ══ THE PLAN IS WIDER THAN THE CLAIM, AND THAT IS DELIBERATE ════════════════
 *
 * Any ACTIVE hub can be proposed. The claim — `resolveMeetupHub()` — still
 * requires a hub BOTH listings named in advance, because that pre-commitment is
 * what the SAFEZONE_MEETUP award rests on, and nothing here weakens it.
 *
 * The two rules used to be the same rule. That made the picker a dead end for
 * two people who each named five different public places: ten hubs either of
 * them would plausibly accept, and nowhere to propose. A listing's hubs are the
 * owner saying "I will meet at any of these"; they are not the only places the
 * owner will ever go. So the intersection is the SUGGESTED set — it sorts first
 * and is marked as such — and anything outside it is allowed but flagged as new
 * to the other person, who agrees or counters. That is what a two-party
 * proposal is for.
 *
 * What falls out at confirmation is exactly what the claim rule already says: a
 * plan the claim would reject is DROPPED there, not fatal (see confirm/submit).
 * A meeting at a hub only one listing named — or neither — simply earns no
 * Leaves. Nobody is refused a place to meet over a reward they were never
 * promised.
 */

export type V1MeetupPlan = {
  hub: V1Hub
  at: string
  note: string | null
  /** "sender" | "receiver" — which side put this on the table. */
  proposedBy: "sender" | "receiver"
  /** Null while one proposal stands unanswered. */
  agreedAt: string | null
}

type MeetupColumns = {
  meetupHubId: string | null
  meetupHub: SafeZoneHubRow | null
  meetupAt: Date | null
  meetupNote: string | null
  meetupProposedBySender: boolean | null
  meetupAgreedAt: Date | null
}

/** The four columns, wherever a trade is selected for the wire. */
export const MEETUP_SELECT = {
  meetupHubId: true,
  meetupHub: { select: SAFE_ZONE_HUB_SELECT },
  meetupAt: true,
  meetupNote: true,
  meetupProposedBySender: true,
  meetupAgreedAt: true,
} as const

/**
 * Row to wire, or null when there is no plan.
 *
 * READS THE GROUP, NOT ONE COLUMN. The three legal states move all four columns
 * together (see the schema block), so a half-written plan is not something this
 * should render prettily — `meetupHub` and `meetupAt` are both required for the
 * object to mean anything, and without them the honest answer is "no plan".
 */
export function v1MeetupPlan(t: MeetupColumns): V1MeetupPlan | null {
  if (!t.meetupHub || !t.meetupAt) return null
  return {
    hub: v1Hub(t.meetupHub),
    at: t.meetupAt.toISOString(),
    note: t.meetupNote,
    proposedBy: t.meetupProposedBySender ? "sender" : "receiver",
    agreedAt: t.meetupAgreedAt ? t.meetupAgreedAt.toISOString() : null,
  }
}

/** Clears all four. The one spelling of "no plan", so no site invents its own. */
export const NO_MEETUP_PLAN = {
  meetupHubId: null,
  meetupAt: null,
  meetupNote: null,
  meetupProposedBySender: null,
  meetupAgreedAt: null,
} as const

/**
 * The hubs BOTH listings in a trade named — the picker's SUGGESTED set, not its
 * whole list. See `proposableHub()` for why the two are different.
 *
 * ONE QUERY. At most MAX_ITEM_HUBS * 2 = 10 rows come back and the intersection
 * is taken in memory, which is cheaper and clearer than asking the database for
 * a GROUP BY … HAVING COUNT(*) = 2 over a ten-row scan.
 *
 * A PURE-LEAVES TRADE STORES THE SAME LISTING IN BOTH ITEM COLUMNS. The
 * intersection of a set with itself is that set, so this needs no special case:
 * the picker offers that one listing's hubs, which is the right answer, and it
 * is the same answer `resolveMeetupHub()` gives when it checks the claim.
 *
 * INACTIVE HUBS ARE RETURNED AND FLAGGED, not filtered out. The caller decides,
 * and the two callers decide differently — see `proposableHub()`.
 */
export async function sharedHubs(
  db: Pick<PrismaClient, "itemSafeZone">,
  offeredItemId: string,
  requestedItemId: string,
): Promise<SafeZoneHubRow[]> {
  const rows = await db.itemSafeZone.findMany({
    where: { itemId: { in: [offeredItemId, requestedItemId] } },
    select: { itemId: true, hubId: true, hub: { select: SAFE_ZONE_HUB_SELECT } },
  })

  const byHub = new Map<string, { items: Set<string>; hub: SafeZoneHubRow }>()
  for (const r of rows) {
    const entry = byHub.get(r.hubId) ?? { items: new Set<string>(), hub: r.hub as SafeZoneHubRow }
    entry.items.add(r.itemId)
    byHub.set(r.hubId, entry)
  }

  const wanted = new Set([offeredItemId, requestedItemId])
  return [...byHub.values()]
    .filter((e) => [...wanted].every((id) => e.items.has(id)))
    .map((e) => e.hub)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export type ProposableHub =
  | { ok: true; hub: SafeZoneHubRow }
  | { ok: false; code: "SAFEZONE_HUB_INVALID" | "SAFEZONE_HUB_CLOSED"; message: string }

/**
 * Can this hub be PROPOSED for a future meeting?
 *
 * Any hub that exists and is open. `SAFEZONE_HUB_INVALID` is now only "no such
 * hub" — an id the client did not get from GET …/meetup — and the client's
 * add-a-hub route out is no longer the answer to it, because there is no longer
 * a hub the proposer is forbidden from naming.
 *
 * ══ STRICTER THAN THE CLAIM ON `isActive`, AND DELIBERATELY SO ══════════════
 *
 * `resolveMeetupHub()` accepts a hub that was deactivated after both listings
 * named it: the parties pre-committed while it was open, they have already met,
 * and refusing the award afterwards would punish them for an administrative
 * decision taken in between. That reasoning is about the PAST and it does not
 * transfer to the future.
 *
 * A closed hub is not a place two people can arrange to meet NEXT SATURDAY.
 * Accepting one here would send them to a shuttered mall and then, because the
 * claim rule is lenient, still pay the award. So a plan requires an active hub;
 * a claim does not. Same table, two questions, two answers.
 *
 * ══ LOOSER THAN THE CLAIM ON PRE-COMMITMENT, ALSO DELIBERATELY ══════════════
 *
 * The claim needs both listings to have named the hub. The plan does not — see
 * the file header. The asymmetry is safe because the plan defaults into the
 * claim only through `resolveMeetupHub()` at confirm/submit, which still applies
 * the strict rule and drops what fails it.
 *
 * A plan already agreed at a hub that closes afterwards is left alone. Nothing
 * sweeps it — the parties have arranged something and the app is not in a
 * position to know whether they have since sorted it out between themselves.
 */
export function proposableHub(hubId: string, active: SafeZoneHubRow[]): ProposableHub {
  const hub = active.find((h) => h.id === hubId)
  if (!hub) {
    return {
      ok: false,
      code: "SAFEZONE_HUB_INVALID",
      message: "That Safe-Zone hub does not exist. Pick one from the list.",
    }
  }
  if (!hub.isActive) {
    return {
      ok: false,
      code: "SAFEZONE_HUB_CLOSED",
      message: `${hub.name} is closed at the moment. Pick another hub.`,
    }
  }
  return { ok: true, hub }
}

/**
 * Every hub in the table, open or shut, in the picker's alphabetical order.
 *
 * INACTIVE HUBS ARE INCLUDED so that `proposableHub()` can tell "closed" from
 * "does not exist" — the client branches on the two differently. The GET
 * handler filters to active before it answers; the POST handler passes the
 * whole list to the check.
 */
export async function allHubs(db: Pick<PrismaClient, "safeZoneHub">): Promise<SafeZoneHubRow[]> {
  const rows = await db.safeZoneHub.findMany({
    select: SAFE_ZONE_HUB_SELECT,
    orderBy: { name: "asc" },
  })
  return rows as SafeZoneHubRow[]
}

/**
 * Which hubs each of the two listings named — the facts the picker sorts and
 * badges on. `shared` is their intersection, the same set `sharedHubs()`
 * returns, computed here from the same rows so the two cannot disagree.
 *
 * A PURE-LEAVES TRADE STORES THE SAME LISTING IN BOTH ITEM COLUMNS, and that
 * needs no special case: both sets are that listing's hubs and so is the
 * intersection.
 */
export async function listingHubIds(
  db: Pick<PrismaClient, "itemSafeZone">,
  yourItemId: string,
  theirItemId: string,
): Promise<{ yours: string[]; theirs: string[]; shared: string[] }> {
  const rows = await db.itemSafeZone.findMany({
    where: { itemId: { in: [yourItemId, theirItemId] } },
    select: { itemId: true, hubId: true },
  })
  const yours = rows.filter((r) => r.itemId === yourItemId).map((r) => r.hubId)
  const theirs = rows.filter((r) => r.itemId === theirItemId).map((r) => r.hubId)
  const theirSet = new Set(theirs)
  return { yours, theirs, shared: yours.filter((id) => theirSet.has(id)) }
}
