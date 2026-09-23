import { NextRequest } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import { ok, unauthenticated } from "@/lib/v1/envelope"
import { reconcileQuests, weekStartUtc } from "@/lib/quests"

export const dynamic = "force-dynamic"

/**
 * GET /api/v1/quests -- the week's three quests (Easy, Medium, Hard), with
 * real completion state and a `resetsAt` the client can count down to.
 *
 * Reconciles on every call rather than reading a cached row: see the header
 * comment on reconcileQuests() in @/lib/quests for why this is a read-time
 * check against real DB state rather than a hook in the offer/item/trade
 * routes. A quest completed a moment before this request shows as completed
 * in THIS response, not the next one.
 */
export async function GET(_req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()

  const now = new Date()
  const quests = await reconcileQuests(session.user.id, now)
  const weekStart = weekStartUtc(now)
  const resetsAt = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000)

  return ok({ quests, weekStart: weekStart.toISOString(), resetsAt: resetsAt.toISOString() })
}
