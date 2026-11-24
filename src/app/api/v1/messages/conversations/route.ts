import { NextRequest } from "next/server"
import { z } from "zod"
import { Prisma } from "@/generated/prisma/client"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { SUBSCRIPTION_SELECT, hasPremiumAccess } from "@/lib/premium"
import { ok, fail, unauthenticated, invalid } from "@/lib/v1/envelope"
import { resolveInbox } from "@/lib/inbox"
import { clearedAt } from "@/lib/chat-prefs"
import { parseQuery, paginationShape } from "@/lib/v1/query"
import { decodeCursor, encodeCursor, cursorDate } from "@/lib/v1/cursor"

export const dynamic = "force-dynamic"

/**
 * GET /api/v1/messages/conversations — one row per partner, newest first.
 *
 * IMPORTANT: return the raw `content` string. The mobile client parses payloads
 * like {"type":"offer"}, offer_update, shared_post, image, and voice and
 * handles preview rendering centrally. A server-formatted preview would mean the
 * same payload is described twice.
 */

const querySchema = z.strictObject({ ...paginationShape })

interface ThreadRow {
  partnerId: string
  lastAt: Date
  lastMessageId: string
  unreadCount: bigint | number
}

export async function GET(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()

  // Acting as a shop, this is the SHOP's list: `viewerId` below is its backing
  // row, and every "me" in the SQL is the shop. See @/lib/inbox.
  const inbox = await resolveInbox(session.user.id, req.headers)
  if (!inbox.ok) return fail("ORG_CONTEXT_REFUSED", inbox.message)
  const viewerId = inbox.inboxId

  const parsed = parseQuery(req, querySchema)
  if (!parsed.ok) return parsed.response
  const { limit } = parsed.data
  const cursor = decodeCursor(parsed.data.cursor)
  if (parsed.data.cursor && !cursor) return invalid("Malformed cursor")

  const cAt = cursorDate(cursor)
  const cId = cursor?.id ?? null

  // Postgres folds unquoted identifiers to lower case, and every table and
  // column here is camelCase, so each one is double-quoted -- including the
  // aliases, or `lastAt` would come back as `lastat` and ThreadRow would read
  // undefined. `read` is a boolean column: compare to false, not 0.
  //
  // The partner is derived ONCE, in the innermost subquery, and everything
  // above groups and filters on that column. MySQL let the CASE expression be
  // repeated in SELECT, GROUP BY and the block filter; Postgres requires the
  // grouped expression to match textually, and since every ${viewerId} is a
  // separate bound parameter ($1, $2, ...) two copies of the CASE never do.
  const threads = await prisma.$queryRaw<ThreadRow[]>`
    SELECT
      t."partnerId" AS "partnerId",
      t."lastAt" AS "lastAt",
      (
        SELECT m2."id"
        FROM "Message" m2
        WHERE (
          (m2."senderId" = ${viewerId} AND m2."receiverId" = t."partnerId")
          OR (m2."receiverId" = ${viewerId} AND m2."senderId" = t."partnerId")
        )
        ORDER BY m2."createdAt" DESC, m2."id" DESC
        LIMIT 1
      ) AS "lastMessageId",
      (
        SELECT COUNT(*)
        FROM "Message" m3
        WHERE m3."receiverId" = ${viewerId}
          AND m3."senderId" = t."partnerId"
          AND m3."read" = false
      ) AS "unreadCount"
    FROM (
      SELECT p."partnerId", MAX(p."createdAt") AS "lastAt"
      FROM (
        SELECT
          CASE WHEN m."senderId" = ${viewerId} THEN m."receiverId" ELSE m."senderId" END AS "partnerId",
          m."createdAt"
        FROM "Message" m
        WHERE m."senderId" = ${viewerId} OR m."receiverId" = ${viewerId}
      ) p
      WHERE NOT EXISTS (
        SELECT 1
        FROM "Block" b
        WHERE (b."blockerId" = ${viewerId} AND b."blockedId" = p."partnerId")
           OR (b."blockedId" = ${viewerId} AND b."blockerId" = p."partnerId")
      )
      GROUP BY p."partnerId"
    ) t
    WHERE ${
      cAt && cId
        ? Prisma.sql`(t."lastAt" < ${cAt} OR (t."lastAt" = ${cAt} AND t."partnerId" < ${cId}))`
        : Prisma.sql`1 = 1`
    }
    ORDER BY t."lastAt" DESC, t."partnerId" DESC
    LIMIT ${limit + 1}
  `

  const hasMore = threads.length > limit
  // "Delete chat": a thread whose newest message is not after the cleared time
  // is gone from this account's list until someone writes again.
  const me = await prisma.user.findUnique({ where: { id: viewerId }, select: { clearedChats: true } })
  const pageAll = hasMore ? threads.slice(0, limit) : threads
  const pageThreads = pageAll.filter((t) => {
    const at = clearedAt(me?.clearedChats, t.partnerId)
    return !at || new Date(t.lastAt) > at
  })
  // The cursor follows the UNFILTERED page, so hidden threads never end paging early.
  const lastRow = pageAll[pageAll.length - 1]
  const nextCursor =
    hasMore && lastRow ? encodeCursor(new Date(lastRow.lastAt), lastRow.partnerId) : null

  // `viewerId` rides along because a thread's bubbles are "mine" when the
  // sender is the INBOX, which acting as a shop is not the signed-in person.
  if (pageThreads.length === 0) {
    return ok({ conversations: [], viewerId }, { nextCursor: null })
  }

  const messages = await prisma.message.findMany({
    where: { id: { in: pageThreads.map((t) => t.lastMessageId) } },
    select: {
      id: true,
      content: true,
      createdAt: true,
      senderId: true,
      systemEventKey: true,
      sender: { select: { id: true, name: true, avatar: true, subscriptions: SUBSCRIPTION_SELECT } },
      receiver: { select: { id: true, name: true, avatar: true, subscriptions: SUBSCRIPTION_SELECT } },
    },
  })
  const byId = new Map(messages.map((m) => [m.id, m]))

  const conversations = pageThreads.flatMap((thread) => {
    const message = byId.get(thread.lastMessageId)
    if (!message) return []

    const partner = message.senderId === viewerId ? message.receiver : message.sender

    return [
      {
        partnerId: partner.id,
        partnerName: partner.name ?? "User",
        partnerAvatar: partner.avatar ?? null,
        // Premium or VIP now: the gold PREMIUM tag beside the name.
        partnerPremium: hasPremiumAccess(partner.subscriptions),
        lastMessageId: message.id,
        content: message.content,
        lastMessageAt: message.createdAt.toISOString(),
        unreadCount: Number(thread.unreadCount ?? 0),
        // A system event ("Trade completed", an offer update) is written as a
        // PAIR of Message rows, one in each direction, so the newest one is
        // often "sent" by the viewer. It is nobody's message: the list must
        // not read it as "You: Trade completed".
        system: message.systemEventKey != null,
        fromMe: message.systemEventKey == null && message.senderId === viewerId,
      },
    ]
  })

  return ok({ conversations, viewerId }, { nextCursor })
}
