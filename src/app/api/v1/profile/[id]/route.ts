import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { preciseAccessItemIds } from "@/lib/item-visibility"
import { blockDirection } from "@/lib/blocking"
import { getLeafRank } from "@/lib/task-constants"
import { loadTrustTiers } from "@/lib/trust-tiers"
import { ORG_PUBLIC_SELECT, orgBadge } from "@/lib/organizations"
import { ok, unauthenticated, invalid, notFound } from "@/lib/v1/envelope"
import { parseQuery, paginationShape } from "@/lib/v1/query"
import { decodeCursor, encodeCursor, olderThan, paginate } from "@/lib/v1/cursor"
import { V1_ITEM_SELECT, V1_ITEM_OWNER_SELECT, v1ItemStatsSelect, v1Item, type V1ItemRow } from "@/lib/v1/item"

export const dynamic = "force-dynamic"

/**
 * GET /api/v1/profile/[id] — somebody else's profile.
 *
 * FIVE queries, not the four the shapes proposed. The proposal claimed pickup
 * access "comes free here". It does not: these items belong to someone else,
 * and the viewer may be an ACCEPTED counterparty on one of them, which is
 * exactly the case that earns precise coordinates. Dropping the lookup would
 * under-share rather than over-share — safe, but wrong for the one person
 * entitled to the address.
 *
 *   1  user row with nested counts
 *   2  follow edge, both directions
 *   3  items page
 *   4  pickup access for that page
 *   5  reviews received
 *
 * The shape is deliberately NOT /profile/me minus a few fields. The omissions
 * are the point and they are enumerated below: no email, no spendable `leaves`,
 * no tasks, no impact. `lifetimeLeaves` IS public — it is what the rank badge
 * is built from.
 */

const querySchema = z.strictObject({ ...paginationShape })

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
  const { limit } = parsed.data
  const cursor = decodeCursor(parsed.data.cursor)
  if (parsed.data.cursor && !cursor) return invalid("Malformed cursor")

  // ── 0 ── the block check, before anything is read.
  //
  // A profile is not in the spec's list of surfaces a block hides ("feed,
  // browse, search"), and it is included anyway, because a profile page IS a
  // listing surface: it renders the user's items, their rating and their trade
  // count. Hiding someone's listings everywhere except the one page that
  // aggregates them would be an enforcement with a hole in the middle.
  //
  // 404, matching the deleted-account branch below and for the same reason a
  // blocked item detail 404s: a 403 would confirm the account exists and, to
  // the blocked party, that they have been blocked.
  if (await blockDirection(viewerId, id) !== "none") {
    return notFound("Profile not found")
  }

  // ── 1 ──
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true, name: true, avatar: true, bio: true, location: true,
      rating: true, totalTrades: true, lifetimeLeaves: true,
      isVerified: true, createdAt: true, deletedAt: true,
      isOrgAccount: true,
      /**
       * The organisation this profile IS, when it is one. Null for a person.
       *
       * The staff count comes nested off it rather than as a sixth query,
       * because it is the number that REPLACES followers/following in the org
       * header -- so it is needed on exactly the reads where `organization` is
       * non-null, and never otherwise.
       *
       * ACTIVE members only. A pending invitation is somebody who has not
       * agreed to appear on a public profile, and counting them would put a
       * number on the page that includes people who said nothing.
       */
      organization: {
        select: {
          ...ORG_PUBLIC_SELECT,
          createdAt: true,
          // The storefront's own fields. Here and not in ORG_PUBLIC_SELECT,
          // which every listing card pays for -- a card has no use for a
          // banner or a paragraph.
          bannerUrl: true,
          description: true,
          _count: { select: { members: { where: { status: "ACTIVE" } } } },
          /**
           * The VIEWER'S OWN membership, if any -- at most one row, by the
           * (organizationId, userId) unique. It decides whether the client
           * shows the staff roster (members only; GET .../members already
           * 404s everyone else) and the owner's Edit shop button. ACTIVE only,
           * for the reason activeOrgsFor() gives: an invitation is not a grant.
           */
          members: {
            where: { userId: viewerId, status: "ACTIVE" },
            select: { role: true },
            take: 1,
          },
        },
      },
      _count: {
        select: {
          items: { where: { status: "AVAILABLE", moderationHiddenAt: null } },
          reviewsReceived: true,
          followers: { where: { status: "ACCEPTED" } },
          following: { where: { status: "ACCEPTED" } },
        },
      },
    },
  })

  // A deleted account is anonymised, not removed. It must not be browsable —
  // 404 here matches resolveSession(), which refuses to authenticate one.
  if (!user || user.deletedAt) return notFound("Profile not found")

  const [tiers, displayedAchievements] = await Promise.all([
    loadTrustTiers(prisma, [{ id: user.id, rating: user.rating }]),
    prisma.$queryRaw<Array<{
      id: string
      name: string
      icon: string
      imageUrl: string | null
      displayOrder: number | null
    }>>`
      SELECT ua."achievementId" AS id,
             a."name",
             a."icon",
             a."imageUrl",
             ua."displayOrder"
      FROM "UserAchievement" ua
      JOIN "Achievement" a ON a.id = ua."achievementId"
      WHERE ua."userId" = ${user.id}
        AND ua."displayOrder" IS NOT NULL
      ORDER BY ua."displayOrder" ASC, ua."unlockedAt" DESC
    `,
  ])

  // ── 1b ── an organisation's completed trades, counted from the trades.
  //
  // ORGANISATIONS ONLY, so a person's profile still costs the five queries the
  // header promises. The storefront's "Trades completed" stat is a claim a
  // shop makes to strangers, so it is counted from COMPLETED rows on either
  // side rather than read from User.totalTrades, which the types note says
  // has drifted above the real count on live rows.
  const orgCompletedTrades = user.organization
    ? await prisma.tradeRequest.count({
        where: { status: "COMPLETED", OR: [{ senderId: id }, { receiverId: id }] },
      })
    : null

  // ── 2 ── the follow edge in both directions, in one query.
  const edges = await prisma.follow.findMany({
    where: {
      OR: [
        { followerId: viewerId, followeeId: id },
        { followerId: id, followeeId: viewerId },
      ],
    },
    select: { followerId: true, followeeId: true, status: true },
  })
  const mine = edges.find((e) => e.followerId === viewerId)
  const theirs = edges.find((e) => e.followerId === id)

  // ── 3 ── their inventory. AVAILABLE only: what they own is not public.
  const itemRows = await prisma.item.findMany({
    where: {
      userId: id,
      status: "AVAILABLE",
      // The block is already handled above; this is the moderator takedown.
      moderationHiddenAt: null,
      ...(olderThan(cursor) ?? {}),
    },
    select: {
      ...V1_ITEM_SELECT,
      user: { select: V1_ITEM_OWNER_SELECT },
      ...v1ItemStatsSelect(viewerId),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  })
  const { page, nextCursor } = paginate(itemRows, limit, (r) => encodeCursor(r.createdAt, r.id))

  // ── 4 ──
  const access = await preciseAccessItemIds(viewerId, page.map((r) => r.id))

  // ── 5 ──
  const reviews = await prisma.review.findMany({
    where: { revieweeId: id },
    select: {
      id: true, rating: true, comment: true, createdAt: true, tradeId: true,
      reviewer: { select: { id: true, name: true, avatar: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 20,
  })

  return ok(
    {
      user: {
        id: user.id,
        name: user.name,
        avatar: user.avatar,
        bio: user.bio,
        location: user.location,
        rating: user.rating,
        totalTrades: user.totalTrades,
        lifetimeLeaves: user.lifetimeLeaves,
        rank: { label: getLeafRank(user.lifetimeLeaves).label },
        // NULL FOR AN ORGANISATION, whatever the tier map says. Same rule
        // v1Item() enforces on the feed card, and the same reason: the org
        // badge REPLACES the trust-tier badge rather than sitting beside it,
        // and a shape that can carry both is one where a client renders both.
        trustTier: user.organization ? null : tiers.get(user.id) ?? null,
        /**
         * The organisation block, or null for a person. THE CLIENT BRANCHES ON
         * THIS and on nothing else: a square logo instead of a round avatar, a
         * building-store placeholder instead of initials, the verified badge
         * instead of the trust tier, and the staff count instead of
         * followers/following.
         *
         * Everything else on the profile -- the posts grid, Follow, Message,
         * the tabs -- is untouched, which is why this is an extra field rather
         * than a different response shape. A client that does not know about it
         * renders a person, which is what it did before.
         */
        org: user.organization
          ? {
              ...orgBadge(user.organization),
              createdAt: user.organization.createdAt,
              staffCount: user.organization._count.members,
              bannerUrl: user.organization.bannerUrl,
              description: user.organization.description,
              completedTrades: orgCompletedTrades ?? 0,
              /** "OWNER" | "STAFF" when the viewer is an ACTIVE member, else null. */
              viewerRole: user.organization.members[0]?.role ?? null,
            }
          : null,
        isVerified: user.isVerified,
        createdAt: user.createdAt,
        // NOT returned, and deliberately: email, leaves, tasks, impact.
      },
      counts: {
        listed: user._count.items,
        // The maintained column, incremented by settlement. Counting COMPLETED
        // trades here would be a sixth query for a number already stored.
        completedTrades: user.totalTrades,
        reviews: user._count.reviewsReceived,
        followers: user._count.followers,
        following: user._count.following,
        /**
         * ACTIVE staff, or null for a person.
         *
         * Sent BESIDE followers/following rather than instead of them, even
         * though the org header renders it in their place. An organisation
         * really does have followers -- people follow shops -- and zeroing the
         * real numbers to express a layout decision would make the API lie
         * about the data to save the client an `if`. Which number to show is
         * the client's choice; what is true is this endpoint's job.
         */
        staff: user.organization ? user.organization._count.members : null,
      },
      follow: {
        status: mine?.status ?? "NONE",
        followsYou: theirs?.status === "ACCEPTED",
      },
      items: page.map((r) => v1Item(r as unknown as V1ItemRow, viewerId, access)),
      reviews,
      displayedAchievements,
    },
    { nextCursor },
  )
}
