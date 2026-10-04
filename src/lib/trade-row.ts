/**
 * A deal in its TRADE phase, read the way a TradeRequest used to be.
 *
 * Schema v2 merged Offer and TradeRequest into one Trade row per deal: the
 * offer phase is `offerStatus`, the trade phase is `status`, and `status` is
 * NULL until the deal is accepted into a trade (see the Trade model note).
 * Every query that used to read `prisma.tradeRequest` reads `prisma.trade`
 * with `IN_TRADE_PHASE`, unless it already filters on a specific status --
 * `status: "COMPLETED"` excludes NULL on its own.
 *
 * ── WHY A WIRE HELPER ───────────────────────────────────────────────────────
 *
 * The API keeps its response shapes, and a few routes returned the raw
 * TradeRequest row. On the merged row two columns changed meaning:
 *
 *   createdAt       is when the deal was PROPOSED. The trade's own creation
 *                   time is `tradeCreatedAt` -- that is what a TradeRequest's
 *                   `createdAt` was, so it is what the wire calls `createdAt`.
 *   offeredItemId   is nullable (legacy Leaves-only offers named no item). A
 *                   CHECK constraint makes it required once `status` is set.
 *
 * and the offer-phase columns (`legacyOfferId`, `offerStatus`, the bracket and
 * consent snapshots) were never on a trade. `asTradeRequest()` puts the old
 * shape back, so a client sees exactly the keys and meanings it always did.
 */

/** `where` fragment: the deal has become a trade (was: a TradeRequest exists). */
export const IN_TRADE_PHASE = { status: { not: null } } as const

/** A copy of `t` without `keys` -- the columns a pre-v2 row never had. */
function omit<T extends object, K extends string>(t: T, keys: readonly K[]): Omit<T, K> {
  const out = { ...t } as Record<string, unknown>
  for (const k of keys) delete out[k]
  return out as Omit<T, K>
}

/** Offer-phase columns, which a TradeRequest never had. */
const OFFER_ONLY = ["legacyOfferId", "offerStatus", "offeredBracket", "targetBracket", "consentAt", "policyVersion"] as const

/** Trade-phase columns, which an Offer never had (plus the two renamed below). */
const TRADE_ONLY = [
  "status", "tradeCreatedAt", "completedAt", "safeZoneHubId", "meetupHubId",
  "meetupAt", "meetupNote", "meetupProposedBySender", "meetupAgreedAt", "bridgeFeePaidBySender", "legacyOfferId",
  "offeredItemId", "requestedItemId", "requestedItem", "offerStatus", "offeredItem",
] as const

/** The row as a pre-v2 TradeRequest: see the note above. */
export function asTradeRequest<T extends { createdAt: Date; tradeCreatedAt: Date | null }>(t: T) {
  const rest = omit(t, [...OFFER_ONLY, "tradeCreatedAt"])
  return { ...rest, createdAt: t.tradeCreatedAt ?? t.createdAt }
}

/**
 * Include for `asOffer()`: the offered item's id and title, which is what the
 * old `Offer.offeredItems` JSON held.
 */
export const OFFERED_ITEM_REF = { select: { id: true, title: true } } as const

type OfferPhaseRow = {
  requestedItemId: string
  offerStatus: string | null
  offeredItem?: { id: string; title: string } | null
  requestedItem?: unknown
}

/**
 * The row as a pre-v2 Offer: `postId` / `post` for the listing, `status` for
 * the OFFER phase, and `offeredItems` rebuilt as the JSON string the column
 * used to hold (`[{id,title}]`, or `[]` on a legacy Leaves-only offer). The
 * trade-phase columns, which an Offer never had, are dropped. Pass rows read
 * with `offeredItem: OFFERED_ITEM_REF` (and `requestedItem` when the caller
 * read `post`).
 */
export function asOffer<T extends OfferPhaseRow>(t: T) {
  return {
    ...omit(t, TRADE_ONLY),
    postId: t.requestedItemId,
    post: t.requestedItem as T["requestedItem"],
    status: t.offerStatus as NonNullable<T["offerStatus"]>,
    offeredItems: JSON.stringify(t.offeredItem ? [{ id: t.offeredItem.id, title: t.offeredItem.title }] : []),
  }
}

type TradePhaseNarrowed<T> = {
  [K in keyof T]: K extends "offeredItem" | "offeredItemId" | "status" ? NonNullable<T[K]> : T[K]
}

/**
 * Rows read with a trade-phase `status` filter (`IN_TRADE_PHASE`, or a
 * specific status), typed as what they are: `status`, `offeredItemId` and the
 * `offeredItem` relation are never NULL on them -- the Trade CHECK constraints
 * guarantee it -- but Prisma types them by the column, which is nullable for
 * the offer phase. Use as `.then(asTrades)`. A type assertion only; it must
 * never be applied to a query without such a filter.
 */
export function asTrades<T>(rows: T[]): TradePhaseNarrowed<T>[] {
  return rows as TradePhaseNarrowed<T>[]
}
