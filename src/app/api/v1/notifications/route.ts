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

const ACTOR_BRIEF = { id: true, name: true, avatar: true } as const

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
        actor: n.actor ? { id: n.actor.id, name: n.actor.name, avatar: n.actor.avatar } : null,
      })),
      unreadCount,
    },
    { nextCursor },
  )
}
