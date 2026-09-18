import { NextRequest } from "next/server"
import { bracketOf, valueNeedsPremium } from "@/lib/brackets"
import { valueCap } from "@/lib/trade-rules"
import { valueRejectionSentence } from "@/lib/value-rejection"
import { ownerAppealState } from "@/lib/appeals"
import { isPremium } from "@/lib/premium"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { preciseAccessItemIds } from "@/lib/item-visibility"
import { visibleItemWhere } from "@/lib/blocking"
import { loadTrustTiers } from "@/lib/trust-tiers"
import { expireStaleOffers } from "@/lib/offers"
import { ok, unauthenticated, notFound } from "@/lib/v1/envelope"
import { parseQuery } from "@/lib/v1/query"
import { V1_ITEM_SELECT, V1_ITEM_OWNER_SELECT, V1_ITEM_SAFEZONE_SELECT, v1ItemStatsSelect, v1Item, type V1ItemRow } from "@/lib/v1/item"

export const dynamic = "force-dynamic"

/**
 * GET /api/v1/items/[id] — item detail, plus everything the viewer needs to
 * make an offer without a second request.
 *
 * FIVE queries, not the three the shapes proposed. The proposal counted "pickup
 * access plus any existing offer" as one step — they are two different tables —
 * and it did not account for the viewer's Leaf balance, which the offer sheet
 * needs. Four of the five run concurrently, so it costs two round trips of
 * latency, but it is five queries and this comment is not going to call it three.
 *
 *   1  item with owner
 *   2  pickup access
 *   3  any existing pending offer from this viewer
 *   4  the viewer's tradeable items, for the offer sheet's picker
 *   5  the viewer's Leaf balance
 *   6  the owner's trust tier (two aggregates, inside loadTrustTiers)
 *
 * ON (6), ADDED FOR THE ITEM DETAIL SCREEN. This route used to send
 * `owner.trustTier: null` — the field existed and was never populated, because
 * resolving it costs three aggregates and no screen drew the badge. The mobile
 * detail screen does, and this is the one screen where the badge earns those
 * queries: it is where somebody decides whether to go and meet a stranger.
 *
 * DELIBERATELY NOT THE CLIENT-SIDE FALLBACK. `resolveTier()` in the app can
 * derive a tier from `totalTrades` and `rating` without a round trip, and its
 * own comment says it reads high — it works off a denormalised counter that has
 * drifted above the real completed count, and it cannot see DPA defaults at
 * all. An inflated trust badge is worse than no badge on this screen, so the
 * server answers or nobody does.
 *
 * One owner, so the aggregates are over a single id and this is cheap. It runs
 * in the same Promise.all as 2-5 and costs no extra round trip of latency.
 *
 * 404 rather than 403 for a REMOVED item or one the viewer may not read. A 403
 * confirms the row exists, and a hidden listing should not confirm it exists —
 * this matches what the current /api/items/[id] already does.
 */

const querySchema = z.strictObject({})

/**
 * The owner-facing account of a listing's moderation state.
 *
 *   state "waiting"    PENDING_REVIEW: an admin has not answered yet.
 *   state "rejected"   VALUE_REJECTED: answered no; the owner chooses.
 *   state "hidden"     moderationHiddenAt set: a takedown. Takes precedence
 *                      over the value states because it is the one the owner
 *                      cannot undo by editing.
 *   null               nothing to explain.
 *
 * Both values AND both brackets, like the admin queue: the owner is being
 * asked to move the number inside a bracket, and the bracket is the unit the
 * cap is expressed in. `capBracket` is the highest bracket that goes live
 * without a review, straight from valueCap().
 *
 * `appeal` is the appeal against the decision currently in force, if any --
 * see ownerAppealState(). `canAppeal` is the only field a client needs to
 * draw or hide the button; `status` is why.
 */
async function ownerReview(item: {
  id: string
  status: string
  moderationHiddenAt: Date | null
  valueLeaves: number | null
  suggestedLeaves: number | null
  valueRejectionReason: string | null
}) {
  const hidden = item.moderationHiddenAt !== null
  const state = hidden
    ? ("hidden" as const)
    : item.status === "PENDING_REVIEW"
      ? ("waiting" as const)
      : item.status === "VALUE_REJECTED"
        ? ("rejected" as const)
        : null
  if (state === null) return null
  const suggested = item.suggestedLeaves
  return {
    state,
    hiddenAt: item.moderationHiddenAt,
    requestedLeaves: item.valueLeaves,
    suggestedLeaves: suggested,
    requestedBracket: item.valueLeaves === null ? null : bracketOf(item.valueLeaves),
    suggestedBracket: suggested === null ? null : bracketOf(suggested),
    capBracket: suggested === null ? null : valueCap(suggested).maxBracketWithoutReview,
    reasonCode: state === "rejected" ? item.valueRejectionReason : null,
    reason: state === "rejected" ? valueRejectionSentence(item.valueRejectionReason) : null,
    appeal: await ownerAppealState(prisma, item),
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const viewerId = session.user.id
  const { id } = await params

  // No query parameters are accepted here; anything sent is a mistake worth
  // surfacing rather than ignoring.
  const parsed = parseQuery(req, querySchema)
  if (!parsed.ok) return parsed.response

  // ── 1 ──
  //
  // findFirst with visibleItemWhere(), not findUnique by id. The block and the
  // takedown are part of the WHERE, so a listing the viewer may not see simply
  // does not come back and the 404 below covers it — rather than being fetched
  // and then rejected by a second `if`, which is the shape that eventually
  // grows a path around it.
  //
  // THE OWNER IS EXEMPT FROM THAT WHERE (18 Sep 2026). visibleItemWhere() says
  // "not hidden, owner not blocked, owner not suspended", and every clause of
  // it is about somebody ELSE looking. Applied to the owner it produced the
  // one outcome worse than a takedown: a tile on their own shelf that answered
  // "Item not found" when tapped, with nothing anywhere saying why. An owner
  // reads their own listing in every state, and the `review` block below is
  // where the state is explained.
  const item = await prisma.item.findFirst({
    where: { id, OR: [{ userId: viewerId }, visibleItemWhere(viewerId)] },
    select: {
      ...V1_ITEM_SELECT,
      imageHash: true,
      updatedAt: true,
      user: { select: V1_ITEM_OWNER_SELECT },
      ...v1ItemStatsSelect(viewerId),
      // Detail only, never the feed. Still one query -- a nested select, not a
      // second round trip -- so the count in the header above holds.
      //
      // The hub coordinate that comes back through here is PRECISE, and that is
      // correct: it is a mall entrance, not a seller's house. The seller's own
      // pickup point in this same response is still filtered by resolvePickup()
      // exactly as it is everywhere else. Two location fields, two different
      // rules, and the difference is whether anybody lives there.
      ...V1_ITEM_SAFEZONE_SELECT,
    },
  })

  // 404 for absent, REMOVED, moderator-hidden, and blocked-either-way alike.
  // Deliberately one answer for all four: a 403 on the blocked case would tell
  // the blocked party that the listing exists and therefore that they have been
  // blocked, which hands a harasser a signal to switch accounts.
  /*
   * REMOVED is delisted. PENDING_REVIEW is a listing whose owner asked for a
   * value more than one bracket above the suggestion and which an admin has
   * not approved -- it exists, it is theirs, and NOBODY ELSE MAY SEE IT. The
   * discovery queries all filter `status: AVAILABLE`, so this detail route is
   * the one place it could leak, which is why the owner check is explicit here
   * rather than left to the same `visibleItemWhere` that handles blocks.
   */
  if (!item || item.status === "REMOVED") return notFound("Item not found")
  if (
    (item.status === "PENDING_REVIEW" || item.status === "VALUE_REJECTED") &&
    item.userId !== viewerId
  ) {
    return notFound("Item not found")
  }

  const isOwner = item.userId === viewerId

  // `viewer.existingOfferId` below is what puts the app on §5.2's pending-offer
  // screen instead of the composer, so a lapsed offer has to be EXPIRED before
  // it is read or somebody is held on a screen about an offer that is over.
  // Scoped to this viewer AND this listing: the narrowest sweep that fixes the
  // field this route actually serves.
  if (!isOwner) await expireStaleOffers(prisma, { senderId: viewerId, postId: item.id })

  // ── 2, 3, 4, 5, 6 ── concurrent: none depends on another.
  const [access, existingOffer, tradeable, viewerRow, tiers] = await Promise.all([
    preciseAccessItemIds(viewerId, [item.id]),
    isOwner
      ? Promise.resolve(null)
      : prisma.offer.findFirst({
          where: { postId: item.id, senderId: viewerId, status: "PENDING" },
          select: { id: true },
          orderBy: { createdAt: "desc" },
        }),
    isOwner
      ? Promise.resolve([])
      : prisma.item.findMany({
          where: { userId: viewerId, status: "AVAILABLE", moderationHiddenAt: null },
          select: { id: true, title: true, images: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 50,
        }),
    prisma.user.findUnique({
      where: { id: viewerId },
      select: { leaves: true, premiumUntil: true },
    }),
    // The same function the contract gates enforce with, so the badge on this
    // screen can never promise something the server would then refuse.
    loadTrustTiers(prisma, [{ id: item.userId, rating: item.user.rating }]),
  ])

  const shaped = v1Item(item as unknown as V1ItemRow, viewerId, access, tiers)

  const firstImage = (raw: string): string | null => {
    try {
      const parsedImages: unknown = JSON.parse(raw)
      return Array.isArray(parsedImages) && typeof parsedImages[0] === "string"
        ? parsedImages[0]
        : null
    } catch {
      return null
    }
  }

  return ok({
    item: { ...shaped, imageHash: item.imageHash, updatedAt: item.updatedAt },
    // What happened to this listing, for its owner. NULL for everyone else
    // and for a listing nothing has happened to. The client draws the review
    // screen from this block alone -- both values, both brackets, the cap it
    // can edit back inside, the reason, and whether an appeal is possible --
    // so that the explanation for "why can nobody see my listing" is one
    // request and not three.
    review: isOwner ? await ownerReview(item) : null,
    viewer: {
      isOwner,
      // An owner cannot offer on their own listing, and neither can anyone once
      // it has left AVAILABLE.
      canOffer: !isOwner && item.status === "AVAILABLE",
      // Why the offer control is LOCKED for this viewer, when it is. The only
      // value today is "premium": the listing sits in PREMIUM_MIN_BRACKET or
      // above and the viewer has no live subscription. Sent as a reason rather
      // than folded into `canOffer` because the two draw different controls --
      // `canOffer: false` is an inert button ("not available"), a lock is an
      // explanation with the listing left fully in view. Advisory: the same
      // check runs in enforcePremiumForListing() on every POST /api/offers.
      //
      // Not computed for the owner. A person cannot offer on their own listing
      // whatever bracket it is in, and a padlock on your own item would read as
      // a claim about you.
      offerLock:
        !isOwner && valueNeedsPremium(item.valueLeaves) && !isPremium(viewerRow?.premiumUntil)
          ? ("premium" as const)
          : null,
      leaves: viewerRow?.leaves ?? 0,
      tradeableItems: tradeable.map((t) => ({
        id: t.id,
        title: t.title,
        image: firstImage(t.images),
      })),
      existingOfferId: existingOffer?.id ?? null,
    },
  })
}
