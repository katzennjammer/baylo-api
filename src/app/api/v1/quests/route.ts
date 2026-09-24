import { NextRequest } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import { ok, unauthenticated } from "@/lib/v1/envelope"
import { reconcileQuests, dayStartUtc } from "@/lib/quests"

export const dynamic = "force-dynamic"

/**
 * GET /api/v1/quests -- today's five quests (2 Easy, 2 Medium, 1 Hard), with
 * real completion state and a `resetsAt` the client can count down to.
 *
 * Reconciles on every call rather than reading a cached row. Since 25 Sep
 * 2026 this is no longer the only place a quest gets paid: the offer, item,
 * follow, review and trade-settlement routes call settleQuestsAsync() the
 * moment their action commits. This read is the display, and the backfill for
 * anything one of those fire-and-forget checks missed. A quest completed a
 * moment before this request shows as completed in THIS response either way.
 * See the header of @/lib/quests.
 */
export async function GET(_req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()

  const now = new Date()
  const quests = await reconcileQuests(session.user.id, now)
  const periodStart = dayStartUtc(now)
  const resetsAt = new Date(periodStart.getTime() + 24 * 60 * 60 * 1000)

  return ok({ quests, periodStart: periodStart.toISOString(), resetsAt: resetsAt.toISOString() })
}
