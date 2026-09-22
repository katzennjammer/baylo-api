import { resolvePickup, type PublicPickup } from "@/lib/item-visibility"
import { getLeafRank } from "@/lib/task-constants"
import type { TrustTier } from "@/lib/reputation"
import {
  SAFE_ZONE_HUB_SELECT,
  v1Hub,
  type SafeZoneHubRow,
  type V1Hub,
} from "@/lib/safe-zones"
import { categoryLabel, conditionLabel } from "./taxonomy"
import { ORG_PUBLIC_SELECT, orgBadge, type OrgBadge, type OrgPublicRow } from "@/lib/organizations"

/**
 * The one Item shape, rendered by /home, /browse, /items/[id] and both profile
 * screens.
 *
 * Defined once so those screens cannot drift apart the way the current web
 * pages have — tradeplace and listings/[id] already map their own rows their own
 * ways and disagree about which owner fields exist.
 *
 * Two deliberate differences from the web's shapeItem():
 *
 *   - The object is CONSTRUCTED FIELD BY FIELD, never spread from the row.
 *     shapeItem() spreads and then deletes the three pickup columns, which is
 *     safe only for the columns someone remembered to delete: it is why
 *     `wantedItems` still ships alongside its own replacement, and it is the
 *     same pattern that leaked pickup coordinates in the first place. A column
 *     added to Item tomorrow reaches no client through this function.
 *
 *   - `wantedItems` is gone (D3). The free text survives as `wanted`; the raw
 *     column name does not appear. The live /api/items contract is untouched —
 *     removing it there is its own change.
 *
 * Pickup still goes through resolvePickup(), the shared rule, so precise
 * coordinates reach only the owner and an accepted counterparty.
 */

/** Exactly the Item columns this shape needs. Explicit, never `true`. */
export const V1_ITEM_SELECT = {
  id: true,
  title: true,
  description: true,
  images: true,
  category: true,
  condition: true,
  valueLeaves: true,
  suggestedLeaves: true,
  valuationSource: true,
  status: true,
  // The two owner-only facts about a listing nobody else can see. On every
  // public read path they are null/false by construction (the WHERE clause
  // already excluded anything else); they carry information only on the
  // owner's own shelf and detail, which is where the client labels the tile.
  moderationHiddenAt: true,
  valueRejectionReason: true,
  wantedItems: true, // read only to produce `wanted`; never emitted under this name
  imageHash: true,
  createdAt: true,
  updatedAt: true,
  userId: true,
  // The perishable block. Four columns that are null/false on every listing
  // made before 23 Sep 2026 and on every standard one since, so a client that
  // does not know about them reads exactly what it read before.
  isPerishable: true,
  quantity: true,
  quantityUnit: true,
  tradeWithinHours: true,
  // The matcher's input, and the owner's stated wants -- which the detail
  // screen renders as "looking for" chips. '{}' on every pre-column row.
  lookingForCategories: true,
  // Needed by resolvePickup(). The route resolves them; they never reach a body.
  pickupLat: true,
  pickupLng: true,
  pickupAddress: true,
} as const

/**
 * The owner block. Wider than ITEM_PUBLIC_USER_SELECT by one field — `location`
 * — which is what lets the detail screen render from the same object as the
 * feed instead of issuing a second request for it.
 */
export const V1_ITEM_OWNER_SELECT = {
  id: true,
  name: true,
  avatar: true,
  location: true,
  rating: true,
  totalTrades: true,
  lifetimeLeaves: true,
  /**
   * The organisation this owner IS, when the row is an org's backing account.
   * NULL on every human owner, which is almost every row.
   *
   * A NESTED SELECT AND NOT A SECOND QUERY, because the feed renders a "Verified
   * org" badge on the card and a per-card lookup is the N+1 this whole module
   * exists to avoid. It is a left join on a unique index, so the cost on a page
   * of twenty human owners is twenty index probes that find nothing.
   */
  organization: { select: ORG_PUBLIC_SELECT },
} as const

/**
 * The Safe-Zone hubs this listing is offered at.
 *
 * A SEPARATE, OPT-IN SELECT rather than part of V1_ITEM_SELECT. Every feed row
 * would otherwise carry a join it does not render: /home and /browse show a
 * card, and a card has no room for five meetup points. Detail screens spread
 * this in; lists do not, and the cost stays where the value is.
 *
 * INACTIVE HUBS ARE INCLUDED. That is the whole point of the flag — a listing
 * offered at a hub that has since closed keeps saying so, and the client
 * renders it struck through rather than the listing silently losing the only
 * answer it had to "where would we meet?". Filtering them out here would undo
 * the guarantee the deactivation path is built around.
 */
export const V1_ITEM_SAFEZONE_SELECT = {
  safeZones: { select: { hub: { select: SAFE_ZONE_HUB_SELECT } } },
} as const

/**
 * Hub rows to wire objects: active first, then alphabetical.
 *
 * Sorted here rather than in SQL because the set is capped at MAX_ITEM_HUBS and
 * ordering five items in memory is free, while `orderBy` across a join is one
 * more thing each call site has to remember to spell the same way.
 */
export function v1ItemHubs(
  rows: { hub: SafeZoneHubRow }[] | undefined,
): V1Hub[] | null {
  if (!rows) return null
  return rows
    .map((r) => v1Hub(r.hub))
    .sort((a, b) =>
      a.isActive === b.isActive ? a.name.localeCompare(b.name) : a.isActive ? -1 : 1,
    )
}

/** Like/comment counts, plus whether THIS viewer has liked it. */
export function v1ItemStatsSelect(viewerId: string) {
  return {
    _count: { select: { likes: true, comments: true } },
    likes: { where: { userId: viewerId }, select: { id: true }, take: 1 },
  } as const
}

/** The `stats` block on the wire. */
export interface V1Stats {
  likes: number
  liked: boolean
  comments: number
}

/**
 * The row that v1ItemStatsSelect() produces, turned into the wire block.
 *
 * Pulled out of v1Item() so the like and comment routes can answer with the
 * SAME shape the feed sent, from the same code. That matters more than the four
 * lines it saves: those routes exist so a client can reconcile a card it has
 * already drawn, and a reconciliation that arrives in a different shape than
 * the original is worse than no reconciliation at all.
 *
 * `liked` is `length > 0` and not `!!row.likes` -- the select above always
 * returns an array, empty when this viewer has not liked it, and an empty array
 * is truthy.
 */
export function v1Stats(row: {
  _count?: { likes: number; comments: number }
  likes?: { id: string }[]
}): V1Stats {
  return {
    likes: row._count?.likes ?? 0,
    liked: (row.likes?.length ?? 0) > 0,
    comments: row._count?.comments ?? 0,
  }
}

export interface V1Owner {
  id: string
  name: string
  avatar: string | null
  location: string | null
  rating: number
  /**
   * The denormalised counter. STILL SENT, because clients render it as a plain
   * "N trades" statistic — but it is NOT what `trustTier` is computed from, and
   * nothing should derive a tier from it. It has drifted above the real
   * COMPLETED count on live rows. See `loadTrustTiers`.
   */
  totalTrades: number
  lifetimeLeaves: number
  /** The LEAF ladder — Seedling / Sprout / Grower / Guardian, from earnings. */
  rank: string
  /**
   * The TRUST ladder — New / Rising / Trusted / Top Trader, from completed
   * trades and rating, after DPA defaults are charged against it. This is the
   * "safe to trade with" signal and it is the same value the contract gates
   * enforce with, so a badge rendered from it can never promise something the
   * server will then refuse.
   *
   * NULL WHERE THE ENDPOINT DID NOT RESOLVE IT. Deriving it costs three
   * aggregate queries per page, so a route opts in by passing `tiers` to
   * v1Item(); /home does. Null means "not computed here", never "New Trader" —
   * a client must not collapse the two, because the quietest badge on the
   * ladder is a claim about someone and absence is not.
   */
  trustTier: TrustTier | null
  featuredAchievement: { id: string; name: string; icon: string } | null
  /**
   * The organisation this owner IS, or null for a person.
   *
   * WHEN THIS IS NON-NULL, `trustTier` IS ALWAYS NULL, and that is enforced in
   * v1Item() rather than left to the caller. The spec asks for the verified-org
   * badge to REPLACE the trust-tier badge, and a wire shape that can carry both
   * is one where some client eventually renders both -- a business with a
   * "Rising Trader" rung under its checkmark, which is exactly the claim
   * organisations are excluded from the ladder to avoid making.
   *
   * `org.verified` is NOT "an Organization row exists". A PENDING org is a real
   * account that posts and trades; only VERIFIED earns the checkmark. See
   * orgBadge().
   */
  org: OrgBadge | null
}

export interface V1Item {
  id: string
  title: string
  description: string
  images: string[]
  category: string
  categoryLabel: string
  condition: string
  conditionLabel: string
  valueLeaves: number | null
  /** The model's number before the owner adjusted it. NULL predates the model. */
  suggestedLeaves: number | null
  /** "comparables" | "category_band" | null for pre-model listings. */
  valuationSource: string | null
  status: string
  /**
   * TRUE when a moderator has taken the listing down. Only ever true on the
   * owner's own reads -- every other path filters it out -- and it is what
   * lets the shelf say "hidden by a moderator" instead of 404ing on tap.
   */
  hiddenByModerator: boolean
  /**
   * The code a value review was refused with, while status is VALUE_REJECTED.
   * Null otherwise. The owner's sentence for it lives in @/lib/value-rejection
   * (server) and its mirror in the app.
   */
  valueRejectionReason: string | null
  wanted: string | null
  /**
   * The perishable block, or null for a standard listing.
   *
   * ONE NULLABLE OBJECT rather than four loose nullable fields, because the
   * four only mean anything together: a quantity with no window, or a window on
   * a standard item, are states the write paths refuse, and a wire shape that
   * can express them invites a client to render one.
   *
   * `expiresAt` is DERIVED here and not stored -- see the note on
   * Item.tradeWithinHours. The client counts down against it; the server's
   * lazy sweep is what actually moves the status.
   */
  perishable: {
    quantity: number | null
    quantityUnit: string | null
    tradeWithinHours: number
    expiresAt: Date
    /** Already past its window but not yet swept. See expirePerishableItems(). */
    expired: boolean
  } | null
  /** The categories the owner will take in return. `[]` means none stated. */
  lookingFor: string[]
  lookingForLabels: string[]
  pickup: PublicPickup | null
  /**
   * The public meetup points this listing is offered at.
   *
   * NULL MEANS "THIS ENDPOINT DID NOT LOAD THEM", never "none" — the same rule
   * `trustTier` follows, and for the same reason. An empty ARRAY is the real
   * answer for a delivery-only or chat-arranged listing, and a client that
   * collapses the two would render "no meetup points" on every feed card, which
   * is a claim about the listing that the feed never actually checked.
   *
   * Populated only where V1_ITEM_SAFEZONE_SELECT was spread into the query.
   */
  safeZones: V1Hub[] | null
  owner: V1Owner
  stats: V1Stats
  createdAt: Date
}

/**
 * `images` is stored as a JSON string. A malformed value yields an empty array
 * rather than throwing: one bad row should not take down a whole feed page.
 */
function parseImages(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((u): u is string => typeof u === "string")
  } catch {
    return []
  }
}

/** The row shape v1Item() consumes — what V1_ITEM_SELECT plus the joins yield. */
export interface V1ItemRow {
  id: string
  title: string
  description: string
  images: string
  category: string
  condition: string
  valueLeaves: number | null
  suggestedLeaves: number | null
  valuationSource: string | null
  status: string
  /** Optional: rows from a select that predates 18 Sep 2026 still shape. */
  moderationHiddenAt?: Date | null
  valueRejectionReason?: string | null
  wantedItems: string | null
  /** Optional: rows from a select that predates 23 Sep 2026 still shape. */
  isPerishable?: boolean
  quantity?: number | null
  quantityUnit?: string | null
  tradeWithinHours?: number | null
  lookingForCategories?: string[]
  createdAt: Date
  userId: string
  pickupLat: number | null
  pickupLng: number | null
  pickupAddress: string | null
  user: {
    id: string
    name: string
    avatar: string | null
    location: string | null
    rating: number
    totalTrades: number
    lifetimeLeaves: number
    /** Present only where V1_ITEM_OWNER_SELECT was used. Null for a person. */
    organization?: OrgPublicRow | null
  }
  _count?: { likes: number; comments: number }
  likes?: { id: string }[]
  /** Present only when V1_ITEM_SAFEZONE_SELECT was spread into the select. */
  safeZones?: { hub: SafeZoneHubRow }[]
}

/**
 * One row to one wire object.
 *
 * `tradeAccessIds` comes from preciseAccessItemIds(). Omitting it is treated as
 * "no trade access", so a caller that forgets it under-shares rather than
 * over-shares — the same fail-safe direction resolvePickup() takes.
 *
 * `tiers` comes from loadTrustTiers() and follows the same rule: omitting
 * it yields a null tier rather than a guessed one.
 */
export function v1Item(
  row: V1ItemRow,
  viewerId: string | null,
  tradeAccessIds?: Set<string>,
  tiers?: ReadonlyMap<string, TrustTier>,
  featuredAchievements?: ReadonlyMap<string, { id: string; name: string; icon: string }>,
): V1Item {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    images: parseImages(row.images),
    category: row.category,
    categoryLabel: categoryLabel(row.category),
    condition: row.condition,
    conditionLabel: conditionLabel(row.condition),
    valueLeaves: row.valueLeaves,
    suggestedLeaves: row.suggestedLeaves,
    valuationSource: row.valuationSource,
    status: row.status,
    hiddenByModerator: row.moderationHiddenAt != null,
    valueRejectionReason: row.valueRejectionReason ?? null,
    wanted: row.wantedItems ?? null,
    // Built only when BOTH halves are present. `isPerishable` without a window
    // is a row the write paths cannot produce, and shaping it as a perishable
    // would hand the client a countdown to null.
    perishable:
      row.isPerishable && row.tradeWithinHours != null
        ? {
            quantity: row.quantity ?? null,
            quantityUnit: row.quantityUnit ?? null,
            tradeWithinHours: row.tradeWithinHours,
            expiresAt: new Date(
              row.createdAt.getTime() + row.tradeWithinHours * 60 * 60 * 1000,
            ),
            expired:
              row.createdAt.getTime() + row.tradeWithinHours * 60 * 60 * 1000 < Date.now(),
          }
        : null,
    lookingFor: row.lookingForCategories ?? [],
    lookingForLabels: (row.lookingForCategories ?? []).map(categoryLabel),
    pickup: resolvePickup(row, viewerId, tradeAccessIds),
    // null when the caller did not select them. See the note on the field: a
    // caller that forgot under-claims rather than asserting "none".
    safeZones: v1ItemHubs(row.safeZones),
    owner: {
      id: row.user.id,
      name: row.user.name,
      avatar: row.user.avatar,
      location: row.user.location,
      rating: row.user.rating,
      totalTrades: row.user.totalTrades,
      lifetimeLeaves: row.user.lifetimeLeaves,
      rank: getLeafRank(row.user.lifetimeLeaves).label,
      // ?? null, not ?? a default tier. A caller that forgot the map
      // under-claims rather than inventing a rung for someone.
      //
      // AND null outright for an organisation, whatever the map says. Orgs do
      // not climb the trade-count ladder; their badge is `org` below. Enforced
      // here rather than by asking every caller to remember, because the one
      // caller that forgets renders a trust rung on a business.
      trustTier: row.user.organization ? null : tiers?.get(row.user.id) ?? null,
      featuredAchievement: featuredAchievements?.get(row.user.id) ?? null,
      org: row.user.organization ? orgBadge(row.user.organization) : null,
    },
    stats: v1Stats(row),
    createdAt: row.createdAt,
  }
}

export interface OfferedItemBrief {
  id: string
  title: string
  image: string | null
}

/**
 * Offer.offeredItems is stored as a JSON string of `{ id, title, image }`.
 *
 * One parser for every route that renders offers: a malformed or unexpected
 * value yields an empty array rather than throwing — one bad row must not take
 * down a whole page — and every field is coerced to the wire type explicitly
 * instead of trusted. Kept beside v1Item() so the item-image coercion rules
 * live in one place.
 */
export function parseOfferedItems(raw: string | null | undefined): OfferedItemBrief[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((x) => ({
        id: String(x.id ?? ""),
        title: typeof x.title === "string" ? x.title : "Item",
        image: typeof x.image === "string" ? x.image : null,
      }))
  } catch {
    return []
  }
}
