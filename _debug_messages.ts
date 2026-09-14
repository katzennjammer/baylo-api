import * as auth from './src/lib/auth-tokens'
import prisma from './src/lib/prisma'

const viewerId = 'cmq7ss3kf00001473is5i7a1l'

const recentMessages = await prisma.$queryRaw<Array<{ id: string; content: string; createdAt: Date; senderId: string; receiverId: string; read: boolean }>>`
  SELECT m.id, m.content, m.createdAt, m.senderId, m.receiverId, m.read
  FROM Message m
  WHERE m.senderId = ${viewerId} OR m.receiverId = ${viewerId}
  ORDER BY m.createdAt DESC
  LIMIT 20
`

const blocks = await prisma.$queryRaw<Array<{ id: string; blockerId: string; blockedId: string; createdAt: Date }>>`
  SELECT *
  FROM Block
  WHERE blockerId = ${viewerId} OR blockedId = ${viewerId}
  ORDER BY createdAt DESC
  LIMIT 50
`

const grouped = await prisma.$queryRaw<Array<{ partnerId: string; lastAt: Date; lastMessageId: string; unreadCount: bigint | number }>>`
  SELECT
    t.partnerId AS partnerId,
    t.lastAt AS lastAt,
    (
      SELECT m2.id
      FROM Message m2
      WHERE (
        (m2.senderId = ${viewerId} AND m2.receiverId = t.partnerId)
        OR (m2.receiverId = ${viewerId} AND m2.senderId = t.partnerId)
      )
      ORDER BY m2.createdAt DESC, m2.id DESC
      LIMIT 1
    ) AS lastMessageId,
    (
      SELECT COUNT(*)
      FROM Message m3
      WHERE m3.receiverId = ${viewerId}
        AND m3.senderId = t.partnerId
        AND m3.read = 0
    ) AS unreadCount
  FROM (
    SELECT
      CASE WHEN m.senderId = ${viewerId} THEN m.receiverId ELSE m.senderId END AS partnerId,
      MAX(m.createdAt) AS lastAt
    FROM Message m
    WHERE (m.senderId = ${viewerId} OR m.receiverId = ${viewerId})
      AND NOT EXISTS (
        SELECT 1
        FROM Block b
        WHERE (
          (b.blockerId = ${viewerId} AND b.blockedId = CASE WHEN m.senderId = ${viewerId} THEN m.receiverId ELSE m.senderId END)
          OR (b.blockedId = ${viewerId} AND b.blockerId = CASE WHEN m.senderId = ${viewerId} THEN m.receiverId ELSE m.senderId END)
        )
      )
    GROUP BY CASE WHEN m.senderId = ${viewerId} THEN m.receiverId ELSE m.senderId END
  ) t
  ORDER BY t.lastAt DESC, t.partnerId DESC
  LIMIT 20
`

const token = await auth.signAccessToken(viewerId)

const res = await fetch('http://localhost:3000/api/v1/messages/conversations?limit=20', {
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  },
  cache: 'no-store',
})

const raw = await res.json()

console.log(JSON.stringify({
  testedUserId: viewerId,
  token,
  recentMessages,
  blocks,
  grouped,
  httpStatus: res.status,
  rawResponse: raw,
}, null, 2))
