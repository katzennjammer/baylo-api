import { NextResponse } from "next/server"
import type { Prisma } from "@/generated/prisma/client"
import prisma from "@/lib/prisma"
import { ORG_CONTEXT_HEADER, resolveActingIdentity, type ActingIdentity } from "@/lib/organizations"

/**
 * Whose inbox a messaging or notification request reads and writes (25 Sep 2026).
 *
 * ── A SHOP'S INBOX IS ITS BACKING ROW'S ─────────────────────────────────────
 *
 * Messaging a shop writes an ordinary Message with `receiverId` = the org's
 * backing User row, and a NEW_MESSAGE notification to that row. The backing
 * account cannot sign in, so until this module every one of those rows was
 * stored and unreachable: /api/messages, the conversation list and the bell all
 * keyed on `session.user.id` and nothing else.
 *
 * Acting as a shop (X-Baylo-Org, re-checked against an ACTIVE membership by
 * resolveActingIdentity() on every request), the inbox IS the backing row:
 * the conversation list is the shop's, reading a thread marks the shop's
 * messages read, and a reply goes out with `senderId` = the backing row, so the
 * customer sees the shop's name and logo -- the same way a listing posted as
 * the shop shows the shop as its author.
 *
 * ── A SHARED INBOX. NO ASSIGNMENT, NO PER-MESSAGE OWNERSHIP ─────────────────
 *
 * Any ACTIVE member, owner or staff, reads and replies. One member opening a
 * thread clears its unread count for all of them, because it is one inbox.
 *
 * ── WHO TYPED IT IS NOT RECORDED ────────────────────────────────────────────
 *
 * Message has no column for the human author, so a reply sent as the shop is
 * attributable to the shop and not to the member who wrote it. That is the
 * decision for the customer-facing attribution; for moderation it is a gap,
 * and closing it needs a migration (an `authorUserId` on Message).
 *
 * ── A DEAD CONTEXT IS REFUSED, NOT SILENTLY DROPPED ─────────────────────────
 *
 * Unlike /api/v1/home, which falls back to the person so that losing a shop
 * never blanks the app, these routes answer 403 ORG_CONTEXT_REFUSED. Falling
 * back here would show a removed staff member their PERSONAL inbox under a
 * screen that still says it is the shop's, or send their reply under the wrong
 * name. The client clears its context on that code and refetches as the person.
 */

export type InboxResult =
  | { ok: true; inboxId: string; acting: ActingIdentity }
  | { ok: false; message: string }

export async function resolveInbox(
  humanUserId: string,
  headers: Pick<Headers, "get">,
): Promise<InboxResult> {
  const result = await resolveActingIdentity(prisma, humanUserId, headers.get(ORG_CONTEXT_HEADER))
  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === "membership_pending"
          ? "Accept the invitation before acting for this organisation"
          : "You are not a member of that organisation",
    }
  }
  return { ok: true, inboxId: result.acting.actingUserId, acting: result.acting }
}

/**
 * Which of a shop's notifications its bell shows: an ALLOWLIST (25 Sep 2026).
 *
 * The backing row receives notifications whose destination does not work for
 * a shop yet, and a bell that offers them is a bell that leads to broken
 * screens. So in shop mode only rows whose tap lands somewhere that works AS
 * THE SHOP are listed, counted and marked read. The rest are NOT deleted: they
 * stay unread on the backing row and appear the day their type is added here.
 *
 * AN ALLOWLIST AND NOT A DENYLIST, so a notification type added later is kept
 * out of the shop's bell until somebody has checked its destination as a shop.
 *
 *   IN   NEW_MESSAGE, entityType null   a direct message. Opens the thread,
 *                                       which is the shop's inbox and replies
 *                                       as the shop.
 *   IN   FOLLOW_REQUEST                 "started following you" (follows are
 *                                       ACCEPTED at once). Opens the follower's
 *                                       profile, which is all the row is about.
 *   IN   NEW_MESSAGE, "conversation"    an offer on a shop listing. Opens the
 *                                       shop's thread, whose offer card opens
 *                                       offer-review, which reads the SHOP's
 *                                       Trades list and accepts as the shop
 *                                       (org trading, @/lib/trade-participant,
 *                                       26 Sep 2026).
 *   IN   TRADE_REQUEST                  a direct request to the shop. Opens the
 *                                       Trades tab, which is the shop's.
 *   IN   TRADE_CANCELLED                the other side cancelled. No entity
 *                                       pair, so informational -- the same row
 *                                       a person gets.
 *   IN   MEETUP_PROPOSED, MEETUP_AGREED the meetup screen, whose routes accept
 *                                       the shop as a participant.
 *   OUT  NEW_MESSAGE, "item"            a comment on a shop listing. Replying
 *                                       from the comments sheet posts as the
 *                                       PERSON, against the rule that the shop
 *                                       answers as the shop.
 *   OUT  LISTING_* (listing_review)     expiry, value review, takedown, appeal.
 *                                       Kept out until checked on a device: the
 *                                       item screen and its owner controls now
 *                                       honour the acting shop (see
 *                                       @/lib/listing-owner, 25 Sep 2026), which
 *                                       was the reason these were excluded.
 *   OUT  CATEGORY_MATCH                 the point of a match is an offer, and an
 *                                       offer from there goes out as the person.
 *   OUT  TRADE_COMPLETED, NEW_REVIEW    open rate-trade / reviews, which are
 *                                       still the PERSON's: a shop cannot leave
 *                                       or read a review as itself yet.
 *   OUT  TRADE_ACCEPTED, TRADE_REJECTED, addressed to the offer's SENDER, and a
 *        OFFER_EXPIRED                  shop never sends one: shop-initiated
 *                                       offers are deliberately not built. Kept
 *                                       out until they are and are checked.
 *   --   ID_*, ORG_INVITE, REPORT_*,    addressed to people, never to a backing
 *        FOLLOW_ACCEPTED, org review    row, so there is nothing to filter.
 *
 * `entityType: null` IS precise for direct messages on a shop: POST
 * /api/messages writes none, and the pre-v1 backfill that gave old message
 * rows a "conversation" pair predates every organisation.
 *
 * Returned as ONE clause for an `AND`, never spread: the keyset cursor's
 * olderThan() is an `OR` too, and spreading both would drop one of them.
 */
export function shopBellWhere(): Prisma.NotificationWhereInput {
  return {
    OR: [
      { type: "NEW_MESSAGE", entityType: null },
      { type: "NEW_MESSAGE", entityType: "conversation" },
      { type: "FOLLOW_REQUEST" },
      { type: "TRADE_REQUEST" },
      { type: "TRADE_CANCELLED" },
      { type: "MEETUP_PROPOSED" },
      { type: "MEETUP_AGREED" },
    ],
  }
}

/** The pre-v1 routes' refusal. Same code the v1 envelope carries. */
export function legacyOrgRefusal(message: string) {
  return NextResponse.json({ error: message, code: "ORG_CONTEXT_REFUSED" }, { status: 403 })
}
