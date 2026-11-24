import { NextResponse } from "next/server"
import type { PrismaClient } from "@/generated/prisma/client"
import prisma from "@/lib/prisma"
import { ORG_CONTEXT_HEADER, resolveActingIdentity, type ActingIdentity } from "@/lib/organizations"

/**
 * Which side of an offer or trade this request acts for (26 Sep 2026).
 *
 * ── A SHOP'S SIDE IS ITS BACKING ROW'S ──────────────────────────────────────
 *
 * An offer on a shop's listing has `receiverId` = the org's backing User row,
 * and so does the TradeRequest an accept creates. That row cannot sign in, so
 * every "caller must be a participant" check -- `offer.receiverId !==
 * session.user.id` and its siblings on the trade, settlement and meetup routes
 * -- refused every member of the shop, and a shop's offers sat until the
 * sender withdrew them or the clock did.
 *
 * Acting as a shop (X-Baylo-Org, re-checked against an ACTIVE membership by
 * resolveActingIdentity() on every request, the same call resolveInbox() and
 * resolveListingOwners() make), the shop's side is this request's. Any ACTIVE
 * member, owner or staff, the same people who may post and reply as the shop.
 *
 * ── THE PARTICIPANT IS WHO THE ROUTE ACTS AS, EVERYWHERE AFTER THE GATE ─────
 *
 * `participantId` replaces `session.user.id` for everything that is about the
 * TRADE: whose fee is held, whose swap code is "mine", whose standing the
 * premium gate reads, who the notification and the system message are from.
 * The human stays the key for rate limits, like every limiter.
 *
 * ── THE SHOP IS TRIED FIRST, THE PERSON STILL COUNTS ────────────────────────
 *
 * The header rides every request, so a person acting as a shop who opens one
 * of their OWN trades is still its participant -- the same reason
 * resolveListingOwners() keeps the person's listings theirs. There is no
 * ambiguity to break: a trade between a shop and one of its own members is
 * refused before it can exist (see shopMemberSelfTrade below).
 *
 * ── A DEAD CONTEXT IS REFUSED ───────────────────────────────────────────────
 *
 * 403 ORG_CONTEXT_REFUSED, like the inbox. Falling back to the person would
 * answer a removed staff member's accept tap with "Forbidden" at best, and at
 * worst act on a personal trade under a screen that says it is the shop's.
 */

export type TradeParticipantResult =
  | {
      ok: true
      /** The side this request acts as: the person, or the acting shop's backing row. */
      participantId: string
      isSender: boolean
      /** The other side. */
      partnerId: string
      acting: ActingIdentity
    }
  | { ok: false; kind: "org_refused"; message: string }
  | { ok: false; kind: "not_participant" }

export async function resolveTradeParticipant(
  humanUserId: string,
  headers: Pick<Headers, "get">,
  sides: { senderId: string; receiverId: string },
  /** Restrict to one side, for the routes only the receiver (or sender) may call. */
  only?: "sender" | "receiver",
): Promise<TradeParticipantResult> {
  const result = await resolveActingIdentity(prisma, humanUserId, headers.get(ORG_CONTEXT_HEADER))
  if (!result.ok) {
    return {
      ok: false,
      kind: "org_refused",
      message:
        "You are not a member of that organisation",
    }
  }

  const { actingUserId } = result.acting
  const candidates = actingUserId === humanUserId ? [humanUserId] : [actingUserId, humanUserId]
  for (const id of candidates) {
    if (only !== "receiver" && sides.senderId === id) {
      return { ok: true, participantId: id, isSender: true, partnerId: sides.receiverId, acting: result.acting }
    }
    if (only !== "sender" && sides.receiverId === id) {
      return { ok: true, participantId: id, isSender: false, partnerId: sides.senderId, acting: result.acting }
    }
  }
  return { ok: false, kind: "not_participant" }
}

/**
 * The pre-v1 routes' refusal for a failed resolveTradeParticipant(): 403 with
 * ORG_CONTEXT_REFUSED for a dead shop context, plain "Forbidden" otherwise --
 * exactly what the routes answered before for a non-participant.
 */
export function legacyParticipantRefusal(result: Extract<TradeParticipantResult, { ok: false }>) {
  return result.kind === "org_refused"
    ? NextResponse.json({ error: result.message, code: "ORG_CONTEXT_REFUSED" }, { status: 403 })
    : NextResponse.json({ error: "Forbidden" }, { status: 403 })
}

/**
 * Whose trades the Trades tab lists: the acting shop's backing row, or the
 * person. Inbox semantics, not listing-owner semantics -- the tab is ONE
 * account's list, so in shop mode it is the shop's and only the shop's, the
 * way the shop's Messages are. `null` is a dead context, refused by the caller.
 */
export async function resolveTradeViewer(
  humanUserId: string,
  headers: Pick<Headers, "get">,
): Promise<{ ok: true; viewerId: string } | { ok: false; message: string }> {
  const result = await resolveActingIdentity(prisma, humanUserId, headers.get(ORG_CONTEXT_HEADER))
  if (!result.ok) {
    return {
      ok: false,
      message:
        "You are not a member of that organisation",
    }
  }
  return { ok: true, viewerId: result.acting.actingUserId }
}

/**
 * A trade between a shop and one of its own members (26 Sep 2026). REFUSED,
 * on propose and on accept.
 *
 * Until shops could accept, the pair was harmless: a member's offer on their
 * own shop's listing could only sit there. Once a member can accept as the
 * shop, one person controls both sides, and settlement would move the shop's
 * items and Leaves to the member -- and pay the person side a TRADE_REWARD for
 * a trade with themselves. So a trade between a shop and its OWNER is refused
 * (schema v2: the owner is the only member a shop has).
 *
 * Either order: the person may be the sender or the receiver.
 */
export async function isShopMemberPair(
  db: Pick<PrismaClient, "organization">,
  a: string,
  b: string,
): Promise<boolean> {
  const found = await db.organization.findFirst({
    where: {
      OR: [
        { ownerId: a, orgUserId: b },
        { ownerId: b, orgUserId: a },
      ],
    },
    select: { id: true },
  })
  return found !== null
}

export const SHOP_MEMBER_SELF_TRADE = "SHOP_MEMBER_SELF_TRADE"
export const SHOP_MEMBER_SELF_TRADE_MESSAGE =
  "You can't trade with a shop you belong to. Trades between a shop and its own members aren't allowed."

/** The pre-v1 routes' 403 for isShopMemberPair(). */
export function shopMemberSelfTradeRefusal() {
  return NextResponse.json(
    { error: SHOP_MEMBER_SELF_TRADE_MESSAGE, code: SHOP_MEMBER_SELF_TRADE },
    { status: 403 },
  )
}

// ── Offers SENT by a shop (16 Nov 2026) ─────────────────────────────────────
//
// Until now an offer made in shop mode went out as the PERSON: POST /api/offers
// read session.user.id and ignored X-Baylo-Org, so the screen said "shop" while
// the person's items, Leaves and Premium were used. An offer now goes out as
// the ACTING identity (resolveActingIdentity), and these helpers hold the rules
// that only matter once a shop can be a sender.

/**
 * Every account one person can send offers from: themselves and each shop they
 * own (schema v2: the owner is a shop's only member). Used for the
 * one-pending-offer-per-person rule. Names are only ever shown back to that
 * same person, never to anybody else.
 */
export async function sendingAccountsOf(
  db: Pick<PrismaClient, "organization" | "user">,
  humanUserId: string,
): Promise<{ id: string; name: string }[]> {
  const [me, shops] = await Promise.all([
    db.user.findUnique({ where: { id: humanUserId }, select: { name: true } }),
    db.organization.findMany({ where: { ownerId: humanUserId }, select: { orgUserId: true, name: true } }),
  ])
  return [
    { id: humanUserId, name: me?.name ?? "your personal profile" },
    ...shops.map((s) => ({ id: s.orgUserId, name: s.name })),
  ]
}

/**
 * Two accounts behind the SAME person: a person and their own shop (either
 * way), or two shops with one owner. A trade between them is one person on both
 * sides, so it is refused like isShopMemberPair() -- which this extends to the
 * shop-to-shop case that only exists once shops can send.
 */
export async function isSameOwnerPair(
  db: Pick<PrismaClient, "organization">,
  a: string,
  b: string,
): Promise<boolean> {
  if (a === b) return true
  const shops = await db.organization.findMany({
    where: { orgUserId: { in: [a, b] } },
    select: { orgUserId: true, ownerId: true },
  })
  const ownerOf = (id: string) => shops.find((s) => s.orgUserId === id)?.ownerId ?? id
  return ownerOf(a) === ownerOf(b)
}

export const SAME_OWNER_TRADE_MESSAGE =
  "You can't trade between your own accounts. Your personal profile and your shops count as one person."

/** 403 for isSameOwnerPair(): the same code as the shop-member refusal. */
export function sameOwnerTradeRefusal() {
  return NextResponse.json(
    { error: SAME_OWNER_TRADE_MESSAGE, code: SHOP_MEMBER_SELF_TRADE },
    { status: 403 },
  )
}

/** Only a VERIFIED shop may send offers; the same rule as posting. */
export const SHOP_NOT_VERIFIED = "SHOP_NOT_VERIFIED"
export const SHOP_NOT_VERIFIED_MESSAGE =
  "Only verified shops can send offers. Your shop's verification isn't approved yet, so switch to your personal profile to send this offer."
