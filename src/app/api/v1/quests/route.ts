import { NextRequest } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import { ok, unauthenticated } from "@/lib/v1/envelope"
import { reconcileQuests, dayStartUtc } from "@/lib/quests"

export const dynamic = "force-dynamic"

/**
 * GET /api/v1/quests -- today's five quests (2 Easy, 2 Medium, 1 Hard), with
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
  const dayStart = dayStartUtc(now)
  const resetsAt = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)

  return ok({ quests, dayStart: dayStart.toISOString(), resetsAt: resetsAt.toISOString() })
}
