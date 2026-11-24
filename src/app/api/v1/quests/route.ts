import { NextRequest } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import { ok, unauthenticated } from "@/lib/v1/envelope"
import { reconcileQuests, dayStartUtc } from "@/lib/quests"
import prisma from "@/lib/prisma"
import { ORG_CONTEXT_HEADER, resolveActingIdentity } from "@/lib/organizations"

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
export async function GET(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()

  // SHOP MODE (16 Nov 2026): a VERIFIED shop's own daily quests, paid into
  // the shop's balance. An unverified shop has none; a dead context falls
  // back to the person, like the other read-only screens.
  const acting = await resolveActingIdentity(prisma, session.user.id, req.headers.get(ORG_CONTEXT_HEADER))
  const shop = acting.ok ? acting.acting.organization : null
  if (shop && !shop.verified) {
    const periodStart0 = dayStartUtc(new Date())
    return ok({
      quests: [],
      periodStart: periodStart0.toISOString(),
      resetsAt: new Date(periodStart0.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      notice: "Daily quests open once your shop is verified.",
    })
  }
  const questUserId = acting.ok ? acting.acting.actingUserId : session.user.id

  const now = new Date()
  const quests = await reconcileQuests(questUserId, now)
  const periodStart = dayStartUtc(now)
  const resetsAt = new Date(periodStart.getTime() + 24 * 60 * 60 * 1000)

  return ok({ quests, periodStart: periodStart.toISOString(), resetsAt: resetsAt.toISOString() })
}
