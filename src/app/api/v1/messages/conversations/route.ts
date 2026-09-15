import { NextRequest } from "next/server"
import { z } from "zod"
import { Prisma } from "@/generated/prisma/client"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok, unauthenticated, invalid } from "@/lib/v1/envelope"
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
  const viewerId = session.user.id

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
      SELECT
        CASE WHEN m."senderId" = ${viewerId} THEN m."receiverId" ELSE m."senderId" END AS "partnerId",
        MAX(m."createdAt") AS "lastAt"
      FROM "Message" m
      WHERE (m."senderId" = ${viewerId} OR m."receiverId" = ${viewerId})
        AND NOT EXISTS (
          SELECT 1
          FROM "Block" b
          WHERE (
            (b."blockerId" = ${viewerId} AND b."blockedId" = CASE WHEN m."senderId" = ${viewerId} THEN m."receiverId" ELSE m."senderId" END)
            OR (b."blockedId" = ${viewerId} AND b."blockerId" = CASE WHEN m."senderId" = ${viewerId} THEN m."receiverId" ELSE m."senderId" END)
          )
        )
      GROUP BY CASE WHEN m."senderId" = ${viewerId} THEN m."receiverId" ELSE m."senderId" END
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
  const pageThreads = hasMore ? threads.slice(0, limit) : threads
  const lastRow = pageThreads[pageThreads.length - 1]
  const nextCursor =
    hasMore && lastRow ? encodeCursor(new Date(lastRow.lastAt), lastRow.partnerId) : null

  if (pageThreads.length === 0) {
    return ok({ conversations: [] }, { nextCursor: null })
  }

  const messages = await prisma.message.findMany({
    where: { id: { in: pageThreads.map((t) => t.lastMessageId) } },
    select: {
      id: true,
      content: true,
      createdAt: true,
      senderId: true,
      sender: { select: { id: true, name: true, avatar: true } },
      receiver: { select: { id: true, name: true, avatar: true } },
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
        lastMessageId: message.id,
        content: message.content,
        lastMessageAt: message.createdAt.toISOString(),
        unreadCount: Number(thread.unreadCount ?? 0),
        fromMe: message.senderId === viewerId,
      },
    ]
  })

  return ok({ conversations }, { nextCursor })
}
