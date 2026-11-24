import prisma from "@/lib/prisma"
import { createSystemMessage } from "@/lib/system-message"

/**
 * "I'm here" at the meetup hub (7 Nov 2026).
 *
 * The two 15-minute codes used to be issued the moment ONE person opened them,
 * so a partner still on the way watched their window run down. Now each side
 * says it has arrived, and confirm/start issues the codes only once BOTH have.
 *
 * NO NEW COLUMN (schema freeze). An arrival is a message from the person who
 * arrived to their partner -- "I'm at Island Central Mactan." -- written with
 * a system event key, which is unique: tapping twice is one message, and the
 * partner sees the news in the chat as well as in the push.
 *
 * AN ARRIVAL COUNTS FOR TWO HOURS. The key carries a two-hour bucket, so a
 * tap the day before (or a stale one from a meetup that fell through) does
 * not open the codes on the day; tapping again when actually there does.
 */
export const ARRIVAL_WINDOW_MS = 2 * 60 * 60 * 1000

const prefix = (tradeId: string, userId: string) => `arrived:${tradeId}:${userId}:`

/** Record that `userId` is at the hub. Idempotent within the bucket. */
export async function recordArrival(input: {
  tradeId: string
  userId: string
  partnerId: string
  hubName: string | null
}) {
  const bucket = Math.floor(Date.now() / ARRIVAL_WINDOW_MS)
  return createSystemMessage({
    eventKey: `${prefix(input.tradeId, input.userId)}${bucket}`,
    senderId: input.userId,
    receiverId: input.partnerId,
    tradeId: input.tradeId,
    content: input.hubName ? `I'm at ${input.hubName}.` : "I'm at the hub.",
  })
}

/** Has `userId` said they are at the hub within the last two hours? */
export async function hasArrived(tradeId: string, userId: string, now = new Date()): Promise<boolean> {
  const row = await prisma.message.findFirst({
    where: {
      systemEventKey: { startsWith: prefix(tradeId, userId) },
      createdAt: { gte: new Date(now.getTime() - ARRIVAL_WINDOW_MS) },
    },
    select: { id: true },
  })
  return row !== null
}

/** Both sides of the trade, by participant id. */
export async function arrivals(tradeId: string, senderId: string, receiverId: string) {
  const [sender, receiver] = await Promise.all([hasArrived(tradeId, senderId), hasArrived(tradeId, receiverId)])
  return { sender, receiver }
}
