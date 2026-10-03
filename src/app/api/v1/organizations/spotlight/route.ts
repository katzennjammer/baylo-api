import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { userNotBlocked } from "@/lib/blocking"
import { notSuspendedWhere } from "@/lib/moderation"
import { hourlyRotation, rotationHour } from "@/lib/rotation"
import { ok, unauthenticated } from "@/lib/v1/envelope"
import { parseImages } from "@/lib/v1/item"
import { categoryLabel } from "@/lib/v1/taxonomy"
import { BUSINESS_CATEGORY_LABEL } from "@/app/api/v1/organizations/route"
import type { BusinessCategory } from "@/lib/v1/browse-query"
import { ITEM_IMAGES } from "@/lib/item-images"

export const dynamic = "force-dynamic"

/**
 * GET /api/v1/organizations/spotlight — Home's Shop Spotlights.
 *
 * The first PUBLIC list of shops. GET /api/v1/organizations is the caller's own
 * memberships, and browse only surfaces a shop whose name matches a search;
 * nothing else enumerates verified shops. A static segment, so it wins over
 * the sibling [id] route.
 *
 * ── WHO IS ELIGIBLE ─────────────────────────────────────────────────────────
 *
 * VERIFIED only -- unlike browse's Organizations pill, which keeps PENDING
 * shops findable. A spotlight is a promotion, and promoting a business whose
 * documents nobody has reviewed is a different thing from letting it be found.
 * And at least one AVAILABLE, not-taken-down listing: a card that opens an
 * empty storefront is a dead end. The backing account is not deleted, not
 * suspended, and not blocked either way, the same rules every item read uses.
 *
 * ── WHICH ONES: /featured's ROTATION ────────────────────────────────────────
 *
 * hourlyRotation() from @/lib/rotation, seeded with SPOTLIGHT_SEED in place
 * of a category: every eligible shop shuffled by sha256(hour, seed, id), the
 * first SPOTLIGHT_CAP shown. Fixed for the hour, a fresh draw the next, and
 * blind to size, age and trade count -- a spotlight is exposure, and with a
 * dozen shops, all new, there is no signal that would rank them fairly yet.
 * That ranking is the deferred "Verified shops" section, NOT this one.
 *
 * Two reads, like /featured: eligible ids, then the chosen rows. The second
 * re-applies the eligibility filter, so a shop that lost its last listing
 * between the two drops out rather than being served.
 *
 * ── THE CARD'S IMAGE ────────────────────────────────────────────────────────
 *
 * Every field the client needs to pick one: the shop's banner and logo when it
 * set them, and its newest listing that HAS a photo (newest outright when none
 * do) as the fallback hero. Choosing is the client's job; this route only
 * guarantees the candidates are there.
 */

/** How many cards the section shows. */
const SPOTLIGHT_CAP = 6

/**
 * The rotation's seed. Not a Category value, and not /featured's all-category
 * seed, so a shop id and an item id can never share a draw by accident.
 */
const SPOTLIGHT_SEED = "shop-spotlight"

/** How many recent listings are read to find one with a photo. */
const NEWEST_SCAN = 5

export async function GET() {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const viewerId = session.user.id
  const now = new Date()

  const liveListing = { status: "AVAILABLE" as const, moderationHiddenAt: null }
  const where = {
    verificationStatus: "VERIFIED" as const,
    orgUser: {
      is: {
        deletedAt: null,
        ...userNotBlocked(viewerId),
        ...notSuspendedWhere(),
        items: { some: liveListing },
      },
    },
  }

  // ── 1 ── every eligible id.
  const candidates = await prisma.organization.findMany({
    where,
    select: { id: true },
    orderBy: { id: "asc" },
  })
  const chosen = hourlyRotation(candidates, SPOTLIGHT_SEED, now)
    .slice(0, SPOTLIGHT_CAP)
    .map((c) => c.id)

  // ── 2 ── the chosen shops, with their newest listings.
  const rows = chosen.length
    ? await prisma.organization.findMany({
        where: { ...where, id: { in: chosen } },
        select: {
          id: true,
          orgUserId: true,
          name: true,
          logoUrl: true,
          bannerUrl: true,
          description: true,
          businessCategory: true,
          orgUser: {
            select: {
              _count: { select: { items: { where: liveListing } } },
              items: {
                where: liveListing,
                select: { id: true, title: true, images: ITEM_IMAGES, category: true },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                take: NEWEST_SCAN,
              },
            },
          },
        },
      })
    : []

  const rank = new Map(chosen.map((id, i) => [id, i]))
  const shops = rows
    .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
    .map((o) => {
      const recent = o.orgUser.items.map((i) => ({ ...i, images: parseImages(i.images) }))
      const newest = recent.find((i) => i.images.length > 0) ?? recent[0] ?? null
      return {
        id: o.id,
        orgUserId: o.orgUserId,
        name: o.name,
        logoUrl: o.logoUrl,
        bannerUrl: o.bannerUrl,
        description: o.description,
        businessCategory: o.businessCategory,
        businessCategoryLabel: BUSINESS_CATEGORY_LABEL[o.businessCategory as BusinessCategory],
        availableCount: o.orgUser._count.items,
        newestListing: newest
          ? {
              id: newest.id,
              title: newest.title,
              imageUrl: newest.images[0] ?? null,
              category: newest.category,
              categoryLabel: categoryLabel(newest.category),
            }
          : null,
      }
    })

  return ok(
    { shops },
    { cap: SPOTLIGHT_CAP, total: candidates.length, rotationHour: rotationHour(now) },
  )
}
