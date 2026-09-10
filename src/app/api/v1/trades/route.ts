import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { leafBalances } from "@/lib/leaves"
import { expireStaleOffers } from "@/lib/offers"
import { ok, unauthenticated, invalid } from "@/lib/v1/envelope"
import { parseQuery, paginationShape, MAX_LIMIT } from "@/lib/v1/query"
import { decodeCursor, encodeCursor, paginate, cursorDate } from "@/lib/v1/cursor"
import { SAFE_ZONE_HUB_SELECT, v1Hub, type SafeZoneHubRow } from "@/lib/safe-zones"
import { COMMITTING_STATUSES } from "@/lib/contracts"

export const dynamic = "force-dynamic"

/**
 * GET /api/v1/trades?tab=active|history — the trades screen.
 *
 * FIVE Prisma calls, not the four the shapes proposed. The proposal counted
 * "viewer balance plus pending-offer sum" as one step; it is two calls
 * (user.findUnique + offer.aggregate), and they live behind leafBalances() so
 * the over-commit clamp stays in one place rather than being inlined here.
 * Reported honestly rather than rounded down:
 *
 *   1,2  viewer balance and committed-leaves sum (leafBalances)
 *   3    trades page
 *   4    offers
 *   5    pending incoming count
 *   6    values for the items inside those offers -- skipped when there are none
 *
 * The sixth is the price of `offeredItems` being a client-written JSON blob
 * rather than a relation: the ids in it can be trusted as identifiers and
 * nothing in it can be trusted as a fact, so the values are looked up. Both
 * items on a TRADE are real relations and cost nothing extra.
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
function firstImage(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) && typeof parsed[0] === "string" ? parsed[0] : null
  } catch {
    return null
  }
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
  images: true,
  status: true,
  valueLeaves: true,
} as const
const USER_BRIEF = { id: true, name: true, avatar: true } as const

export async function GET(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const viewerId = session.user.id

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

  const tradeRows = await prisma.tradeRequest.findMany({
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
      // The hub is selected; the legacy `safeZoneMeetup` boolean on the wire is
      // DERIVED from it below. One source of truth, two field names -- a stored
      // boolean beside the key is a second source of truth that can disagree
      // with the first, which is exactly how the offeredLeaves bug happened.
      safeZoneHubId: true,
      safeZoneHub: { select: SAFE_ZONE_HUB_SELECT },
      createdAt: true,
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
      // Code state, so canConfirm is a real answer rather than a guess from
      // status alone. At most two rows per trade.
      swapConfirmationCodes: { select: { userId: true, used: true, expiresAt: true } },
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
  const offerRows = await prisma.offer.findMany({
    where: { OR: [{ senderId: viewerId }, { receiverId: viewerId }], status: "PENDING" },
    select: {
      id: true, status: true, offeredItems: true, offeredLeaves: true,
      message: true, createdAt: true, senderId: true, receiverId: true,
      post: { select: ITEM_BRIEF },
      sender: { select: USER_BRIEF },
      receiver: { select: USER_BRIEF },
      // A deferred agreement proposed WITH this offer, now that one can be.
      //
      // Sent so the offer card can say "and a promise of 100 by 6 Oct" rather
      // than showing a swap that looks unequal for no reason — and so the
      // creditor knows to open the preview before accepting. At most one is ever
      // in a COMMITTING status; the take is belt and braces.
      contracts: {
        where: { status: { in: [...COMMITTING_STATUSES] } },
        select: { id: true, amountLeaves: true, deadline: true, status: true },
        take: 1,
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_LIMIT,
  })

  // ── 5 ── incoming still awaiting this viewer.
  const pendingIncoming = await prisma.tradeRequest.count({
    where: { receiverId: viewerId, status: "PENDING", hiddenByReceiver: false },
  })

  const now = Date.now()

  const trades = page.map((t) => {
    const isSender = t.senderId === viewerId
    const partnerId = isSender ? t.receiverId : t.senderId
    const counterparty = isSender ? t.receiver : t.sender
    // D2: kind comes from the column, never from offeredItemId === requestedItemId.
    const kind = (t.offeredLeaves ?? 0) > 0 ? "leaves" : "items"

    // The viewer submits their PARTNER's code, so it is the partner's row that
    // records whether this viewer has already confirmed.
    const partnerCode = t.swapConfirmationCodes.find((c) => c.userId === partnerId)
    const partnerCodeLive = !!partnerCode && partnerCode.expiresAt.getTime() > now
    const canConfirm =
      t.status === "ACCEPTED" ||
      (t.status === "CONFIRMING" && (!partnerCodeLive || !partnerCode.used))

    return {
      id: t.id,
      status: t.status,
      direction: isSender ? "sent" : "received",
      kind,
      offeredLeaves: t.offeredLeaves,
      counterparty,
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
          : { ...t.offeredItem, image: firstImage(t.offeredItem.images), images: undefined },
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
      canConfirm,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }
  })

  /*
   * ── VALUES FOR `offeredItems`, LOOKED UP RATHER THAN TRUSTED ──────────────
   *
   * `Offer.offeredItems` is a JSON string the CLIENT sent at offer time. It
   * holds `{ id, title, image }` and it is client-asserted: a caller can put any
   * title in it, and could put any `valueLeaves` in it if the shape had one.
   *
   * So the values do not come from there. The ids do, and the values come from
   * the Item table in one query — the same treatment `post` already gets by
   * being a real relation. A client that renders the number this returns is
   * rendering something the server stands behind.
   *
   * One query for the whole page, capped by MAX_LIMIT offers times however many
   * items each carries. Skipped entirely when there are no offers.
   */
  const offeredItemIds = [
    ...new Set(
      offerRows.flatMap((o) => {
        try {
          const parsed: unknown = JSON.parse(o.offeredItems)
          return Array.isArray(parsed)
            ? parsed
                .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
                .map((x) => String(x.id ?? ""))
                .filter(Boolean)
            : []
        } catch {
          return []
        }
      }),
    ),
  ]

  const offeredItemValues = new Map<string, number | null>()
  if (offeredItemIds.length > 0) {
    const rows = await prisma.item.findMany({
      where: { id: { in: offeredItemIds } },
      select: { id: true, valueLeaves: true },
    })
    for (const r of rows) offeredItemValues.set(r.id, r.valueLeaves)
  }

  const offers = offerRows.map((o) => {
    const isSender = o.senderId === viewerId
    let offeredItems: {
      id: string
      title: string
      image: string | null
      /** From the Item table, not from the stored JSON. See the note above. */
      valueLeaves: number | null
    }[] = []
    try {
      const parsedItems: unknown = JSON.parse(o.offeredItems)
      if (Array.isArray(parsedItems)) {
        offeredItems = parsedItems
          .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
          .map((x) => {
            const itemId = String(x.id ?? "")
            return {
              id: itemId,
              title: typeof x.title === "string" ? x.title : "Item",
              image: typeof x.image === "string" ? x.image : null,
              // `?? null` covers two different cases with the same answer: the
              // item was never valued, and the item no longer exists. Neither is
              // a number, and neither is zero.
              valueLeaves: offeredItemValues.get(itemId) ?? null,
            }
          })
      }
    } catch {
      offeredItems = []
    }
    return {
      id: o.id,
      direction: isSender ? "sent" : "received",
      status: o.status,
      post: { ...o.post, image: firstImage(o.post.images), images: undefined },
      offeredItems,
      offeredLeaves: o.offeredLeaves,
      message: o.message,
      counterparty: isSender ? o.receiver : o.sender,
      /**
       * Null when this offer carries no promise, which is most of them.
       *
       * `previewPath` is named rather than left for the client to build, for the
       * same reason POST /api/v1/contracts names it: a client should not be able
       * to construct an accept flow without having seen the endpoint that
       * justifies it.
       */
      contract: o.contracts[0]
        ? {
            id: o.contracts[0].id,
            amountLeaves: o.contracts[0].amountLeaves,
            deadline: o.contracts[0].deadline,
            status: o.contracts[0].status,
            previewPath: `/api/v1/contracts/${o.contracts[0].id}/preview`,
          }
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
