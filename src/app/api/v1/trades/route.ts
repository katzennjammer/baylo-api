import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { leafBalances } from "@/lib/leaves"
import { expireStaleOffers } from "@/lib/offers"
import { ok, unauthenticated, invalid, fail } from "@/lib/v1/envelope"
import { resolveTradeViewer } from "@/lib/trade-participant"
import { parseQuery, paginationShape, MAX_LIMIT } from "@/lib/v1/query"
import { decodeCursor, encodeCursor, paginate, cursorDate } from "@/lib/v1/cursor"
import { SAFE_ZONE_HUB_SELECT, v1Hub, type SafeZoneHubRow } from "@/lib/safe-zones"
import { MEETUP_SELECT, v1MeetupPlan } from "@/lib/meetup"
import { MAX_CODE_ATTEMPTS } from "@/lib/swap-code"
import { ITEM_IMAGES, toImageUrls, type ImagesLike } from "@/lib/item-images"

export const dynamic = "force-dynamic"

/**
 * GET /api/v1/trades?tab=active|history — the trades screen.
 *
 * FIVE Prisma calls, not the four the shapes proposed. The proposal counted
 * "viewer balance plus pending-offer sum" as one step; it is two calls
 * (user.findUnique + trade.aggregate), and they live behind leafBalances() so
 * the over-commit clamp stays in one place rather than being inlined here.
 * Reported honestly rather than rounded down:
 *
 *   1,2  viewer balance and committed-leaves sum (leafBalances)
 *   3    trades page
 *   4    offers
 *   5    pending incoming count
 *
 * There used to be a sixth, for the values of the items inside the offers'
 * client-written `offeredItems` JSON. Since schema v2 the offered item is a
 * real relation on the deal's row, as both items on a trade always were.
 *
 * Offers and trades are one Trade row per deal since schema v2: "trades" are
 * the rows in their trade phase (`status` set) and "offers" the rows still in
 * their offer phase (`offerStatus` PENDING).
 *
 * `kind` is the whole point of D2. The client is never told that
 * offeredItemId === requestedItemId means anything, because here it does not
 * mean anything — `offeredLeaves` is a real column now and `kind` is derived
 * from it, not from an id-equality trick.
 */

const ACTIVE_STATES = ["PENDING", "ACCEPTED", "CONFIRMING"] as const
const HISTORY_STATES = ["COMPLETED", "REJECTED", "CANCELLED"] as const

const querySchema = z.strictObject({
  ...paginationShape,
  tab: z.enum(["active", "history"]).optional().default("active"),
})

/** First image of an item, or null. Stored as a JSON string. */
function firstImage(raw: ImagesLike): string | null {
  return toImageUrls(raw)[0] ?? null
}

/**
 * The item shape every row on this route carries.
 *
 * `valueLeaves` IS ON IT NOW. It was not, and its absence was the single thing
 * that made this endpoint unable to describe what it is about: the Trades screen
 * is a screen about value gaps — "your Vans 440 for his Air Max 480", "his
 * guitar 1,450 for your chair 760" — and without the numbers every one of those
 * lines degraded to two bare titles.
 *
 * It costs nothing. `valueLeaves` is a column on the same rows already being
 * selected; this is one more field on an existing SELECT, not a join and not a
 * query. NULLABLE, and null means "never valued" rather than "worth nothing" —
 * listings that predate the valuation model have it, and a client that renders
 * a null as 0 is stating a falsehood the wire did not.
 */
const ITEM_BRIEF = {
  id: true,
  title: true,
  images: ITEM_IMAGES,
  status: true,
  valueLeaves: true,
} as const
const USER_BRIEF = { id: true, name: true, avatar: true } as const

export async function GET(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()

  // Whose list: acting as a shop (X-Baylo-Org, ACTIVE membership) it is the
  // SHOP's -- its trades, its offers, its balance -- and only the shop's, the
  // way the shop's Messages are (26 Sep 2026). Every query below keys on
  // `viewerId`, so this one line is the whole switch. A dead context is
  // refused, not silently answered with the person's list under a screen that
  // says it is the shop's. See @/lib/trade-participant.
  const viewer = await resolveTradeViewer(session.user.id, req.headers)
  if (!viewer.ok) return fail("ORG_CONTEXT_REFUSED", viewer.message)
  const viewerId = viewer.viewerId

  const parsed = parseQuery(req, querySchema)
  if (!parsed.ok) return parsed.response
  const { limit, tab } = parsed.data
  const cursor = decodeCursor(parsed.data.cursor)
  if (parsed.data.cursor && !cursor) return invalid("Malformed cursor")

  const states = tab === "active" ? ACTIVE_STATES : HISTORY_STATES

  // The lazy offer sweep, on the read that surfaces both halves of the harm: the
  // available balance below, and the `offers` list further down. Scoped to this
  // viewer as sender — their own stale offers are the ones holding their Leaves.
  await expireStaleOffers(prisma, { senderId: viewerId })

  // ── 1, 2 ── balances.
  const balances = await leafBalances(prisma, viewerId)

  // ── 3 ── the trades page.
  //
  // Sorted on updatedAt, not createdAt: this list is "what moved recently", and
  // a trade that just advanced to CONFIRMING belongs at the top. The keyset is
  // therefore (updatedAt, id) and is spelled out here rather than reusing
  // olderThan(), which is createdAt-specific.
  const cDate = cursorDate(cursor)
  const keyset =
    cDate && cursor
      ? {
          OR: [
            { updatedAt: { lt: cDate } },
            { AND: [{ updatedAt: cDate }, { id: { lt: cursor.id } }] },
          ],
        }
      : undefined

  const tradeRows = await prisma.trade.findMany({
    where: {
      status: { in: [...states] },
      OR: [
        { senderId: viewerId, hiddenBySender: false },
        { receiverId: viewerId, hiddenByReceiver: false },
      ],
      ...(keyset ?? {}),
    },
    select: {
      id: true,
      status: true,
      offeredLeaves: true,
      // The bridging fee and who paid it, so a trade row can say "your 20
      // comes back if this is cancelled" without a second request.
      bridgeFeeLeaves: true,
      bridgeFeePaidBySender: true,
      // The hub is selected; the legacy `safeZoneMeetup` boolean on the wire is
      // DERIVED from it below. One source of truth, two field names -- a stored
      // boolean beside the key is a second source of truth that can disagree
      // with the first, which is exactly how the offeredLeaves bug happened.
      safeZoneHubId: true,
      safeZoneHub: { select: SAFE_ZONE_HUB_SELECT },
      // The meetup PLAN, on the list rather than behind its own request. The
      // Trades screen already runs three queries to draw itself and an accepted
      // row has to say "Renz suggested Parkmall, Sat 2pm" to be worth tapping;
      // a fourth round trip per row to find that out is how that line ends up
      // not being drawn at all. Five columns on a SELECT already happening, plus
      // the hub join the claim above is already paying for.
      ...MEETUP_SELECT,
      // When the deal became a trade; the wire's `createdAt` (see below).
      tradeCreatedAt: true,
      updatedAt: true,
      senderId: true,
      receiverId: true,
      sender: { select: USER_BRIEF },
      receiver: { select: USER_BRIEF },
      // The two ids as well as the rows. A pure-Leaves trade stores the LISTING
      // in both columns as a placeholder, and comparing them is the only way to
      // tell that apart from a real item offered alongside Leaves. See the note
      // beside `offeredItem` below.
      offeredItemId: true,
      requestedItemId: true,
      offeredItem: { select: ITEM_BRIEF },
      requestedItem: { select: ITEM_BRIEF },
      reviews: {
        where: { OR: [{ reviewerId: viewerId }, { revieweeId: viewerId }] },
        select: { reviewerId: true, rating: true },
      },
      // Code state, so canConfirm is a real answer rather than a guess from
      // status alone. At most two rows per trade. `attempts` is for codesLive:
      // a pair burned by MAX_CODE_ATTEMPTS is as dead as an expired one.
      swapCodes: { select: { userId: true, used: true, expiresAt: true, attempts: true } },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  })
  const { page, nextCursor } = paginate(tradeRows, limit, (r) =>
    encodeCursor(r.updatedAt, r.id),
  )

  // ── 4 ── offers in both directions. Capped, not paginated: the shapes put the
  // cursor on `trades`, and a screen showing more than 50 live offers has a
  // different problem than pagination.
  const offerRows = await prisma.trade.findMany({
    where: { OR: [{ senderId: viewerId }, { receiverId: viewerId }], offerStatus: "PENDING" },
    select: {
      id: true, offerStatus: true, offeredLeaves: true,
      bridgeFeeLeaves: true, offeredBracket: true, targetBracket: true,
      message: true, createdAt: true, senderId: true, receiverId: true,
      offeredItem: { select: { id: true, title: true, valueLeaves: true } },
      requestedItem: { select: ITEM_BRIEF },
      sender: { select: USER_BRIEF },
      receiver: { select: USER_BRIEF },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_LIMIT,
  })

  // ── 5 ── incoming still awaiting this viewer.
  const pendingIncoming = await prisma.trade.count({
    where: { receiverId: viewerId, status: "PENDING", hiddenByReceiver: false },
  })

  const now = Date.now()
  const rewardRows = await prisma.leafTransaction.findMany({
    where: {
      tradeId: { in: page.map((trade) => trade.id) },
      userId: viewerId,
      type: "TRADE_REWARD",
    },
    select: { tradeId: true, amount: true },
  })
  const rewards = new Map(rewardRows.map((row) => [row.tradeId, row.amount]))

  const trades = page.map((t) => {
    const isSender = t.senderId === viewerId
    const partnerId = isSender ? t.receiverId : t.senderId
    const counterparty = isSender ? t.receiver : t.sender
    // D2: kind comes from the column, never from offeredItemId === requestedItemId.
    const kind = (t.offeredLeaves ?? 0) > 0 ? "leaves" : "items"

    // The viewer submits their PARTNER's code, so it is the partner's row that
    // records whether this viewer has already confirmed.
    const partnerCode = t.swapCodes.find((c) => c.userId === partnerId)
    const partnerCodeLive = !!partnerCode && partnerCode.expiresAt.getTime() > now
    const canConfirm =
      t.status === "ACCEPTED" ||
      (t.status === "CONFIRMING" && (!partnerCodeLive || !partnerCode.used))

    /*
     * Whether there is a code to SHOW right now, which canConfirm does not say:
     * an expired CONFIRMING trade is still the viewer's move (canConfirm true)
     * but its codes are dead, and its card must offer to start the handoff
     * again rather than "Show code". The test is confirm/start's own
     * idempotency check -- both rows unexpired and unburned -- so codesLive is
     * true exactly when opening the code panel would NOT issue a fresh pair.
     *
     * codesExpireAt is the earlier of the two expiries, so the client can flip
     * the card itself when the window closes. Sent whenever both rows exist and
     * that instant is still ahead, INCLUDING a burned pair: that is how the
     * client tells "locked" (attempts spent, window open) from "expired".
     */
    const codes = t.swapCodes
    const codesLive =
      codes.length === 2 &&
      codes.every((c) => c.expiresAt.getTime() > now && c.attempts < MAX_CODE_ATTEMPTS)
    const firstExpiry =
      codes.length === 2 ? Math.min(...codes.map((c) => c.expiresAt.getTime())) : null
    const codesExpireAt =
      firstExpiry !== null && firstExpiry > now ? new Date(firstExpiry) : null

    return {
      id: t.id,
      status: t.status,
      direction: isSender ? "sent" : "received",
      kind,
      offeredLeaves: t.offeredLeaves,
      bridgeFeeLeaves: t.bridgeFeeLeaves,
      bridgeFeePaidBySender: t.bridgeFeePaidBySender,
      counterparty,
      myReview: t.reviews.find((review) => review.reviewerId === viewerId)
        ? { rating: t.reviews.find((review) => review.reviewerId === viewerId)!.rating }
        : null,
      receivedReview: t.reviews.find((review) => review.reviewerId !== viewerId)
        ? { rating: t.reviews.find((review) => review.reviewerId !== viewerId)!.rating }
        : null,
      rewardLeaves: rewards.get(t.id) ?? null,
      codesMatchedAt: t.status === "COMPLETED" ? t.updatedAt : null,
      /*
       * ── SUPPRESSED ONLY WHEN IT IS ACTUALLY A PLACEHOLDER ────────────────
       *
       * A pure-Leaves trade stores the LISTING in both item columns, so the
       * "offered item" is not a real one and must not be sent — a recipient
       * shown their own listing as the thing being offered to them is the
       * confusion this guard exists to prevent.
       *
       * THE TEST IS ID EQUALITY, NOT `kind`. It used to be `kind === "leaves"`,
       * and that was wrong for the most common interesting trade there is: an
       * item PLUS some Leaves. `kind` is derived from `offeredLeaves > 0`, so a
       * Vans offered with 40 Leaves on top came through as `kind: "leaves"` and
       * its offered item was thrown away — which is exactly the case the design
       * writes as "Vans 440 for Air Max 480 · 40 added". The Trades screen could
       * not draw the left-hand side of its own worked example.
       *
       * `kind` STAYS DERIVED FROM THE COLUMN and is not changed here. The route's
       * own note about never inferring `kind` from id equality still stands and
       * is a different question from this one: `kind` asks what is moving, this
       * asks whether a particular row is real. `netValueTo()` in @/lib/contracts
       * makes the same distinction with the same test, for the same reason.
       */
      offeredItem:
        t.offeredItemId === t.requestedItemId
          ? null
          : { ...t.offeredItem!, image: firstImage(t.offeredItem!.images), images: undefined },
      requestedItem: {
        ...t.requestedItem,
        image: firstImage(t.requestedItem.images),
        images: undefined,
      },
      // Kept on the wire under its original name so a shipped client that reads
      // it keeps working, but computed rather than stored. See the select above.
      safeZoneMeetup: t.safeZoneHubId !== null,
      /** Which hub, when one was claimed. NULL for every trade that named none. */
      safeZoneHub: t.safeZoneHub ? v1Hub(t.safeZoneHub as SafeZoneHubRow) : null,
      /*
       * Where and when they have ARRANGED to meet — a different fact from the
       * two fields above it, which are what they CLAIMED afterwards. Null until
       * somebody proposes; `plan.agreedAt` is null while one proposal stands
       * unanswered. Nothing on this object awards anything.
       */
      meetup: v1MeetupPlan(t),
      canConfirm,
      codesLive,
      codesExpireAt,
      // What TradeRequest.createdAt was: the moment the deal became a trade.
      createdAt: t.tradeCreatedAt,
      updatedAt: t.updatedAt,
    }
  })

  const offers = offerRows.map((o) => {
    const isSender = o.senderId === viewerId
    /*
     * `offeredItems` keeps its list shape on the wire, built from the real
     * relation (schema v2) where it used to be parsed out of a client-written
     * JSON blob. `valueLeaves` comes from the Item row, as it always did.
     * `image` stays null: the blob every offer since 16 Sep 2026 wrote held
     * only `{ id, title }`, so null is what this field has always carried, and
     * the app draws offered items from their own records.
     */
    const offeredItems: {
      id: string
      title: string
      image: string | null
      valueLeaves: number | null
    }[] = o.offeredItem
      ? [{ id: o.offeredItem.id, title: o.offeredItem.title, image: null, valueLeaves: o.offeredItem.valueLeaves }]
      : []
    return {
      id: o.id,
      direction: isSender ? "sent" : "received",
      status: o.offerStatus,
      post: { ...o.requestedItem, image: firstImage(o.requestedItem.images), images: undefined },
      offeredItems,
      offeredLeaves: o.offeredLeaves,
      message: o.message,
      counterparty: isSender ? o.receiver : o.sender,
      /**
       * THE BRIDGE, as the trades screen needs it.
       *
       * `bridgeFeeLeaves` is the QUOTE either way; `payer` says whose it is,
       * derived from the two brackets exactly as the routes derive it. A
       * receiver looking at an incoming offer whose `payer` is "receiver" is
       * the one who will be charged on accepting, and their sheet needs both
       * numbers before they tap.
       *
       * The `contract` block that used to sit here -- a deferred promise
       * attached to the offer, with a preview path -- went with DPAs.
       */
      offeredBracket: o.offeredBracket,
      targetBracket: o.targetBracket,
      bridgeFeeLeaves: o.bridgeFeeLeaves,
      bridgeFeePayer:
        o.bridgeFeeLeaves && o.offeredBracket !== null && o.targetBracket !== null
          ? o.offeredBracket < o.targetBracket
            ? "proposer"
            : "receiver"
          : null,
      createdAt: o.createdAt,
    }
  })

  return ok(
    {
      viewer: { leaves: balances.leaves, availableLeaves: balances.available },
      pendingIncoming,
      trades,
      offers,
    },
    { nextCursor },
  )
}
