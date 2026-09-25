import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok, unauthenticated, invalid } from "@/lib/v1/envelope"
import { parseQuery, paginationShape } from "@/lib/v1/query"
import { decodeCursor, encodeCursor, paginate, olderThan } from "@/lib/v1/cursor"

export const dynamic = "force-dynamic"

/**
 * GET /api/v1/notifications — the bell's list.
 *
 * ── WHY THIS ROUTE DID NOT EXIST UNTIL NOW ──────────────────────────────────
 *
 * Notification rows have been written for months and the header bell has been
 * rendering an accurate unread COUNT from /api/v1/home the whole time. There was
 * simply nothing to open: `PATCH /api/notifications` and
 * `PATCH /api/notifications/[id]` could mark rows read, and nothing could read
 * them. A badge showing 24 with no destination is worse than no badge, because
 * it reports an obligation and then refuses to say what it is.
 *
 * ── `actor` IS SELECTED, `link` IS NOT ──────────────────────────────────────
 *
 * `link` is a WEB dashboard path (`/dashboard/messages?partner=…`). Sending it
 * to a phone would invite the client to parse a URL meant for another app, and
 * that is exactly the coupling `entityType`/`entityId` were added to end. The
 * mobile client routes from the structured pair and never sees `link`.
 *
 * The actor is sent because "Aj accepted your offer" needs a face and a name,
 * and the row's `message` carries neither — the web dashboard rendered the actor
 * from its own join and the message text starts mid-sentence ("accepted your
 * offer on …") on purpose.
 *
 * ── `entityType` IS PASSED THROUGH VERBATIM, INCLUDING THE OLD VOCABULARY ───
 *
 * Two vocabularies live in that column and the schema note on `Notification`
 * explains why. This route does NOT normalise them. A pre-v1 TRADE_ACCEPTED row
 * carries ('user', <userId>) rather than ('trade', <tradeId>), and rewriting it
 * here to look fine-grained would be inventing an id that does not exist — the
 * old rows never recorded one. The client is told the truth and routes a 'user'
 * target at a profile, which is where the old row actually points.
 */
const querySchema = z.strictObject({
  ...paginationShape,
  /** `unread=1` narrows to what the badge is counting. */
  unread: z.enum(["0", "1"]).optional(),
})

/**
 * `isOrgAccount` rides along so the client can draw a shop without a logo as a
 * shop. An org's backing row carries its logo in `avatar` (see the PATCH route
 * for organisations), and with no logo the only other honest fallback is a
 * person silhouette -- which is the wrong thing to put next to a business.
 */
const ACTOR_BRIEF = { id: true, name: true, avatar: true, isOrgAccount: true } as const

function firstImage(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const images: unknown = JSON.parse(raw)
    return Array.isArray(images) && typeof images[0] === "string" ? images[0] : null
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const viewerId = session.user.id

  const parsed = parseQuery(req, querySchema)
  if (!parsed.ok) return parsed.response
  const { limit } = parsed.data
  const cursor = decodeCursor(parsed.data.cursor)
  if (parsed.data.cursor && !cursor) return invalid("Malformed cursor")

  const rows = await prisma.notification.findMany({
    where: {
      userId: viewerId,
      ...(parsed.data.unread === "1" ? { read: false } : {}),
      ...(olderThan(cursor) ?? {}),
    },
    select: {
      id: true,
      type: true,
      message: true,
      read: true,
      createdAt: true,
      entityType: true,
      entityId: true,
      actor: { select: ACTOR_BRIEF },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  })

  const itemIds = rows
    .filter((row) => row.entityType === "item" && row.entityId)
    .map((row) => row.entityId as string)
  const itemImages = new Map<string, string | null>()
  if (itemIds.length > 0) {
    const items = await prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, images: true },
    })
    for (const item of items) itemImages.set(item.id, firstImage(item.images))
  }

  // ── The organisation a row is ABOUT, for the two org tokens ──────────────────
  //
  // An ORG_INVITE's actor is the owner who sent it -- a person, often with no
  // photo -- and an organisation-review row has no actor at all. Both rendered
  // as a blank grey tile while every other kind of notification had a face or
  // a photo. The subject of both is a shop, so the shop's logo is the picture.
  //
  // 'org_invite' carries an OrganizationMember id, 'organization' an
  // Organization id. A membership that is gone (withdrawn, answered) simply
  // has no entry; its notification is deleted with it anyway.
  const memberIds = rows
    .filter((row) => row.entityType === "org_invite" && row.entityId)
    .map((row) => row.entityId as string)
  const orgIds = rows
    .filter((row) => row.entityType === "organization" && row.entityId)
    .map((row) => row.entityId as string)
  const orgBriefs = new Map<string, { id: string; name: string; logoUrl: string | null }>()
  if (memberIds.length > 0) {
    const members = await prisma.organizationMember.findMany({
      where: { id: { in: memberIds } },
      select: { id: true, organization: { select: { id: true, name: true, logoUrl: true } } },
    })
    for (const m of members) orgBriefs.set(`org_invite:${m.id}`, m.organization)
  }
  if (orgIds.length > 0) {
    const orgs = await prisma.organization.findMany({
      where: { id: { in: orgIds } },
      select: { id: true, name: true, logoUrl: true },
    })
    for (const o of orgs) orgBriefs.set(`organization:${o.id}`, o)
  }

  const { page, nextCursor } = paginate(rows, limit, (r) => encodeCursor(r.createdAt, r.id))

  // The unread total, and NOT `page.filter(r => !r.read).length`. The screen
  // shows a page; the count has to describe the whole list or it disagrees with
  // the bell the moment there are more unread rows than fit on one page.
  const unreadCount = await prisma.notification.count({
    where: { userId: viewerId, read: false },
  })

  return ok(
    {
      notifications: page.map((n) => ({
        id: n.id,
        type: n.type,
        message: n.message,
        read: n.read,
        createdAt: n.createdAt.toISOString(),
        entityType: n.entityType,
        entityId: n.entityId,
        itemImage: n.entityType === "item" && n.entityId ? itemImages.get(n.entityId) ?? null : null,
        org: (n.entityId && orgBriefs.get(`${n.entityType}:${n.entityId}`)) || null,
        actor: n.actor
          ? { id: n.actor.id, name: n.actor.name, avatar: n.actor.avatar, isOrg: n.actor.isOrgAccount }
          : null,
      })),
      unreadCount,
    },
    { nextCursor },
  )
}
