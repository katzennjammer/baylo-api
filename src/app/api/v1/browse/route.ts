import { NextRequest } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { preciseAccessItemIds } from "@/lib/item-visibility"
import { userNotBlocked, visibleItemWhere } from "@/lib/blocking"
import { notSuspendedWhere } from "@/lib/moderation"
import { BUSINESS_CATEGORY_LABEL } from "@/app/api/v1/organizations/route"
import { browseQuerySchema, type BusinessCategory } from "@/lib/v1/browse-query"
import { ok, unauthenticated, invalid } from "@/lib/v1/envelope"
import { expirePerishableItems } from "@/lib/perishable"
import { parseQuery } from "@/lib/v1/query"
import { decodeCursor, encodeCursor, olderThan, paginate } from "@/lib/v1/cursor"
import { V1_ITEM_SELECT, V1_ITEM_OWNER_SELECT, v1ItemStatsSelect, v1Item, type V1ItemRow } from "@/lib/v1/item"
import { categoryLabel } from "@/lib/v1/taxonomy"

export const dynamic = "force-dynamic"

/**
 * GET /api/v1/browse — the browse tab.
 *
 * THREE queries: items page (1), pickup access (2), category facets (3).
 * Plus two that run only when asked for: organisations whose NAME matches `q`
 * (4, first page of a search only), and business-category facets (5, only
 * while the Organizations pill is on).
 *
 * Filters are optional and compose. `sort=nearest` REQUIRES lat/lng and 400s
 * without them rather than falling back to recent — a silent fallback returns a
 * plausible-looking list in the wrong order, which is worse than an error.
 *
 * On radius filtering and the pickup leak: this route READS pickupLat/pickupLng
 * to filter, and still returns them coarsened through v1Item(). Filtering
 * precision and display precision are separate concerns and only the second one
 * is a disclosure. Nothing here puts a precise coordinate on the wire for
 * someone who is not the owner or an accepted counterparty.
 */

/** Ceiling on rows pulled for an in-memory distance sort. See sortNearest(). */
const NEAREST_SCAN_CAP = 500

/**
 * Ceiling on perishables pulled for the in-memory expiry sort. The oldest are
 * read first, and with windows of at most 24 hours the oldest are, roughly, the
 * soonest to expire -- so past the cap it is mostly the far end that is cut.
 */
const EXPIRING_SCAN_CAP = 500
const HOUR_MS = 60 * 60 * 1000

/**
 * How many organisations a search puts above the item grid. A top result, not
 * a directory: the item grid is still the answer to most searches.
 */
const MAX_ORG_MATCHES = 3

/** Great-circle distance in km. */
function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371
  const dLat = ((bLat - aLat) * Math.PI) / 180
  const dLng = ((bLng - aLng) * Math.PI) / 180
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}

export async function GET(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const viewerId = session.user.id

  const parsed = parseQuery(req, browseQuerySchema)
  if (!parsed.ok) return parsed.response
  const {
    limit,
    category,
    condition,
    minLeaves,
    maxLeaves,
    q,
    lat,
    lng,
    radiusKm,
    sort,
    orgsOnly,
    businessCategory,
    perishable,
  } = parsed.data
  const cursor = decodeCursor(parsed.data.cursor)
  if (parsed.data.cursor && !cursor) return invalid("Malformed cursor")

  // ── The perishable sweep, BEFORE the page is read ──────────────────────────
  //
  // The same arrangement expireStaleOffers() has, and for the same reason: this
  // deployment runs nothing on a schedule, so the paths that would be WRONG if
  // the sweep had not run are the paths that run it. Browse is the first of
  // those -- a tray of fish whose six hours ran out an hour ago is AVAILABLE in
  // the database until something moves it, and serving it here is serving a
  // listing nobody can act on.
  //
  // Unscoped and awaited. Unscoped because browse is everyone's listings, not
  // one person's; awaited because the very next statement reads the rows this
  // updates, and firing it off would race its own page. It is one UPDATE over
  // an index and it touches nothing when there is nothing to expire.
  await expirePerishableItems(prisma)

  // A bounding box first: cheap in SQL, and it turns a whole-table distance
  // computation into one over a small candidate set. The circle is applied
  // afterwards, so corners of the box do not leak into the result.
  const box =
    lat !== undefined && lng !== undefined && radiusKm !== undefined
      ? (() => {
          const dLat = radiusKm / 111.32
          const dLng = radiusKm / (111.32 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)))
          return {
            pickupLat: { gte: lat - dLat, lte: lat + dLat },
            pickupLng: { gte: lng - dLng, lte: lng + dLng },
          }
        })()
      : undefined

  // visibleItemWhere() rides in the base, so BOTH sort branches and the search
  // filter inherit it. That placement is the point: `q` is the search path, and
  // a blocked user's listing being findable by title while being absent from
  // the feed is the same leak wearing a different hat.
  //
  // ON THE LEAF RANGE: `valueLeaves` is nullable, and a bound EXCLUDES the nulls
  // rather than treating them as zero. An unpriced listing has no value, which
  // is a different fact from having a value of nought — folding the two would
  // dump every unpriced item into the bottom of every range filter, where it
  // would look like a 0-Leaf listing to anyone reading the results.
  const leafRange =
    minLeaves !== undefined || maxLeaves !== undefined
      ? {
          valueLeaves: {
            ...(minLeaves !== undefined ? { gte: minLeaves } : {}),
            ...(maxLeaves !== undefined ? { lte: maxLeaves } : {}),
            not: null,
          },
        }
      : {}

  const baseWhere = {
    status: "AVAILABLE" as const,
    ...visibleItemWhere(viewerId),
    // `in` for one category as well as several: Prisma emits `= ?` for a
    // single-element IN, so the one-category case costs nothing and there is
    // no second code path that could disagree with this one.
    ...(category ? { category: { in: category } } : {}),
    ...(condition ? { condition } : {}),
    // The expiry sweep above has already moved lapsed perishables out of
    // AVAILABLE, so perishable=true never serves a tray whose window ran out.
    ...(perishable !== undefined ? { isPerishable: perishable } : {}),
    ...leafRange,
    // The search also matches the OWNER'S SHOP NAME (25 Sep 2026): searching
    // "Baylo" returns the shop card from query 4 AND everything the shop has
    // posted, not only listings that happen to repeat the shop's name in their
    // title. The shop branch uses the card's own rule -- REJECTED is left out
    // -- so a name that finds no card finds no listings through the name.
    // Inside the OR, so it does not collide with visibleItemWhere()'s `user`
    // key; block, suspension and every other filter still apply to it.
    ...(q
      ? {
          OR: [
            { title: { contains: q, mode: "insensitive" as const } },
            { description: { contains: q, mode: "insensitive" as const } },
            {
              user: {
                is: {
                  isOrgAccount: true,
                  organization: {
                    is: {
                      name: { contains: q, mode: "insensitive" as const },
                      verificationStatus: { not: "REJECTED" as const },
                    },
                  },
                },
              },
            },
          ],
        }
      : {}),
    ...(box ?? {}),
    // The Organizations pill. A predicate on the OWNER's discriminator column,
    // which is why that column is stored rather than derived -- see the note on
    // User.isOrgAccount. `organization: { isNot: null }` would say the same
    // thing as a join, on the hottest list query in the app.
    //
    // isOrgAccount, NOT verificationStatus: the pill says "Organizations", so
    // it shows organisations. Filtering to VERIFIED only would quietly hide
    // every business still waiting on a review -- which is the state a business
    // is in for its first days, exactly when it most needs to be findable. The
    // badge on the card is what distinguishes verified from not.
    //
    // In an AND, NOT as a `user` key. visibleItemWhere() above already owns
    // `user` (the block and suspension filters), and a second `user` spread
    // here replaced it outright: with the pill on, blocked and suspended
    // owners' listings came back.
    //
    // The business category rides in the same AND entry, so it is AND with
    // everything else: Organizations + Apparel + Fashion is apparel shops'
    // fashion listings. Several business categories are OR among themselves,
    // exactly as several item categories are.
    ...(orgsOnly
      ? {
          AND: [
            {
              user: {
                is: {
                  isOrgAccount: true,
                  ...(businessCategory
                    ? { organization: { is: { businessCategory: { in: businessCategory } } } }
                    : {}),
                },
              },
            },
          ],
        }
      : {}),
  }

  const selection = {
    ...V1_ITEM_SELECT,
    user: { select: V1_ITEM_OWNER_SELECT },
    ...v1ItemStatsSelect(viewerId),
  }

  let page: unknown[]
  let nextCursor: string | null

  if (sort === "nearest") {
    // ── 1 (nearest) ──
    // Keyset pagination on a computed distance cannot be expressed in Prisma,
    // so the candidate set is bounded instead: the bounding box plus a hard cap,
    // sorted and cursored in memory. The cursor is still a real keyset —
    // (distance, id) — so ties never drop or duplicate a row.
    const rows = await prisma.item.findMany({
      where: { ...baseWhere, pickupLat: { not: null }, pickupLng: { not: null } },
      select: selection,
      take: NEAREST_SCAN_CAP,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    })

    const withDistance = rows
      .map((r) => ({
        row: r,
        d: haversineKm(lat!, lng!, r.pickupLat as number, r.pickupLng as number),
      }))
      .filter((x) => radiusKm === undefined || x.d <= radiusKm)
      .sort((a, b) => (a.d === b.d ? (a.row.id < b.row.id ? 1 : -1) : a.d - b.d))

    const afterDistance = cursor && typeof cursor.k === "number" ? cursor.k : null
    const after =
      afterDistance !== null && cursor
        ? withDistance.filter(
            (x) => x.d > afterDistance || (x.d === afterDistance && x.row.id < cursor.id),
          )
        : withDistance

    const sliced = paginate(after, limit, (x) => encodeCursor(x.d, x.row.id))
    page = sliced.page.map((x) => x.row)
    nextCursor = sliced.nextCursor
  } else if (sort === "expiring") {
    // ── 1 (expiring) ── soonest trade window first; perishable=true only (the
    // schema refuses it otherwise). The window is createdAt + tradeWithinHours,
    // which Prisma cannot ORDER BY without raw SQL, so this is nearest's
    // arrangement: a bounded scan, sorted and cursored in memory on a real
    // (expiresAt, id) keyset. The sweep above has already moved lapsed rows out
    // of AVAILABLE, so nothing past its window is in the scan.
    const rows = await prisma.item.findMany({
      where: { ...baseWhere, tradeWithinHours: { not: null } },
      select: selection,
      take: EXPIRING_SCAN_CAP,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })

    const withExpiry = rows
      .map((r) => ({ row: r, t: r.createdAt.getTime() + (r.tradeWithinHours as number) * HOUR_MS }))
      .sort((a, b) => (a.t === b.t ? (a.row.id < b.row.id ? -1 : 1) : a.t - b.t))

    const afterT = cursor && typeof cursor.k === "number" ? cursor.k : null
    const after =
      afterT !== null && cursor
        ? withExpiry.filter((x) => x.t > afterT || (x.t === afterT && x.row.id > cursor.id))
        : withExpiry

    const sliced = paginate(after, limit, (x) => encodeCursor(x.t, x.row.id))
    page = sliced.page.map((x) => x.row)
    nextCursor = sliced.nextCursor
  } else {
    // ── 1 (recent) ── plain keyset on createdAt.
    const rows = await prisma.item.findMany({
      where: { ...baseWhere, ...(olderThan(cursor) ?? {}) },
      select: selection,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    })
    const sliced = paginate(rows, limit, (r) => encodeCursor(r.createdAt, r.id))
    page = sliced.page
    nextCursor = sliced.nextCursor
  }

  const rowsOut = page as V1ItemRow[]

  // ── 2 ── pickup access for this page only.
  const access = await preciseAccessItemIds(viewerId, rowsOut.map((r) => r.id))

  // ── 3 ── facets for the filter chips.
  //
  // Deliberately NOT filtered by the current category: chips that vanish as soon
  // as you pick one are a worse control than chips that stay put. The text and
  // radius filters are not applied either, for the same reason.
  //
  // The block and takedown filters DO apply here, unlike the category/text/
  // radius filters above. Those are omitted so the chips stay put as you use
  // them; a blocked user's listings are not a filter the viewer is toggling,
  // they are content that does not exist for this viewer, and a chip counting
  // them sends the user to an empty result.
  const facetRows = await prisma.item.groupBy({
    by: ["category"],
    where: { status: "AVAILABLE", ...visibleItemWhere(viewerId) },
    _count: { id: true },
    orderBy: { _count: { id: "desc" } },
  })

  // ── 4 ── organisations whose NAME matches the search.
  //
  // The "top account" above the content results: the shop itself. Its
  // listings are in the grid below through the shop-name branch of `q` in
  // baseWhere; this is the card that goes with them.
  //
  // First page only -- it is one card above the grid, and repeating it on every
  // scroll page would be a wasted query per page. Honours the business-category
  // sub-filter, so the card never contradicts the chips under it, and the same
  // block and suspension rules the grid does: a shop you blocked is not a
  // search result any more than its listings are.
  //
  // REJECTED organisations are left out. Their document review failed, and a
  // prominent card is not where a business that could not be verified belongs;
  // PENDING ones stay in, unbadged, for the reason the pill keeps them.
  const orgRows =
    q && !cursor
      ? await prisma.organization.findMany({
          where: {
            name: { contains: q, mode: "insensitive" },
            verificationStatus: { not: "REJECTED" },
            ...(businessCategory ? { businessCategory: { in: businessCategory } } : {}),
            orgUser: { is: { ...userNotBlocked(viewerId), ...notSuspendedWhere() } },
          },
          select: {
            id: true,
            orgUserId: true,
            name: true,
            logoUrl: true,
            businessCategory: true,
            verificationStatus: true,
            // For the card's Follow button. Following a shop IS following its
            // backing account -- the same Follow row as following a person --
            // so the viewer's edge is at most one row by the unique pair.
            orgUser: {
              select: {
                followers: { where: { followerId: viewerId }, select: { status: true }, take: 1 },
                _count: { select: { followers: { where: { status: "ACCEPTED" } } } },
              },
            },
            // A member is not offered Follow on their own shop.
            members: { where: { userId: viewerId, status: "ACTIVE" }, select: { id: true }, take: 1 },
          },
          orderBy: [{ name: "asc" }],
          // Over-fetched, then ranked below: Prisma cannot order by "how well
          // the name matches", and an exact match belongs at the top.
          take: 20,
        })
      : []
  const needle = q?.toLowerCase() ?? ""
  const matchRank = (name: string) => {
    const n = name.toLowerCase()
    return n === needle ? 0 : n.startsWith(needle) ? 1 : 2
  }
  const organizations = orgRows
    .sort(
      (a, b) =>
        matchRank(a.name) - matchRank(b.name) ||
        Number(b.verificationStatus === "VERIFIED") - Number(a.verificationStatus === "VERIFIED"),
    )
    .slice(0, MAX_ORG_MATCHES)
    .map((o) => ({
      id: o.id,
      orgUserId: o.orgUserId,
      name: o.name,
      logoUrl: o.logoUrl,
      businessCategory: o.businessCategory,
      businessCategoryLabel: BUSINESS_CATEGORY_LABEL[o.businessCategory as BusinessCategory],
      verified: o.verificationStatus === "VERIFIED",
      follow: o.orgUser.followers[0]?.status ?? ("NONE" as const),
      followers: o.orgUser._count.followers,
      isMember: o.members.length > 0,
    }))

  // ── 5 ── business-category facets, for the chips under the Organizations pill.
  //
  // From the DATA, not the enum: a category appears only when some visible
  // organisation in it has something AVAILABLE, so no chip leads to an empty
  // grid. Counted in shops, not listings -- groupBy cannot group items by their
  // owner's organisation's column, and the chip only needs "is there anything".
  // Unfiltered by the other controls, like the item facets and for the same
  // reason: chips that vanish as you pick them are a worse control.
  const businessFacetRows = orgsOnly
    ? await prisma.organization.groupBy({
        by: ["businessCategory"],
        where: {
          orgUser: {
            is: {
              ...userNotBlocked(viewerId),
              ...notSuspendedWhere(),
              items: { some: { status: "AVAILABLE", moderationHiddenAt: null } },
            },
          },
        },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
      })
    : []

  return ok(
    {
      items: rowsOut.map((r) => v1Item(r, viewerId, access)),
      organizations,
      facets: {
        categories: facetRows.map((f) => ({
          category: f.category,
          label: categoryLabel(f.category),
          count: f._count.id,
        })),
        businessCategories: businessFacetRows.map((f) => ({
          businessCategory: f.businessCategory,
          label: BUSINESS_CATEGORY_LABEL[f.businessCategory as BusinessCategory],
          count: f._count.id,
        })),
      },
    },
    {
      nextCursor,
      // The filters the server actually honoured, echoed back. Cheap, and it
      // makes a client/server disagreement visible instead of mysterious.
      // NOTE: `category` (a single string or null) became `categories` (always
      // an array, empty when unfiltered) when the multi-select landed. A field
      // whose TYPE changes between requests is worse than a renamed one, and
      // nothing consumed this echo — it is diagnostic, not data.
      applied: {
        categories: category ?? [],
        orgsOnly,
        businessCategories: businessCategory ?? [],
        perishable: perishable ?? null,
        condition: condition ?? null,
        minLeaves: minLeaves ?? null,
        maxLeaves: maxLeaves ?? null,
        q: q ?? null,
        sort,
        radiusKm: radiusKm ?? null,
      },
    },
  )
}
