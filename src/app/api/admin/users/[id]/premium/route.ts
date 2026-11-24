import { NextRequest } from "next/server"
import { z } from "zod"
import { requireRole } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok, notFound, conflict } from "@/lib/v1/envelope"
import { parseJsonBody } from "@/lib/v1/body"
import { PREMIUM_LIFETIME_UNTIL } from "@/lib/premium"
import { evaluateAchievements } from "@/lib/achievements"

export const dynamic = "force-dynamic"

/**
 * POST /api/admin/users/[id]/premium — grant or end Premium by hand.
 *
 * The admin-panel twin of scripts/set-tier.ts, so the gate → grant → unlock
 * flow can be shown without a terminal until Play Billing exists. Same write:
 * end whatever PREMIUM term is running (ended, not deleted -- the rows are the
 * history), then on "grant" start a new one. No `days`: during the beta
 * Premium is the lifetime grant (PREMIUM_LIFETIME_UNTIL in @/lib/premium).
 *
 * Not written to the audit log: AdminActionKind has no subscription kind and
 * the schema is frozen until the defense (AGENTS.md). The Subscription row's
 * startsAt / endsAt record when it happened. Add PREMIUM_GRANTED/ENDED kinds
 * when the freeze lifts.
 */

const bodySchema = z.strictObject({ action: z.enum(["grant", "end"]) })

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireRole("ADMIN")
  if (gate.response) return gate.response

  const { id } = await params
  const parsed = await parseJsonBody(req, bodySchema)
  if (!parsed.ok) return parsed.response
  const { action } = parsed.data

  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, deletedAt: true } })
  if (!user) return notFound("Account not found")
  if (user.deletedAt) return conflict("That account has been deleted", { code: "ACCOUNT_DELETED" })

  const now = new Date()
  await prisma.$transaction(async (tx) => {
    await tx.subscription.updateMany({
      where: { userId: id, tier: "PREMIUM", endsAt: { gt: now } },
      data: { endsAt: now },
    })
    if (action === "grant") {
      await tx.subscription.create({
        data: { userId: id, tier: "PREMIUM", startsAt: now, endsAt: PREMIUM_LIFETIME_UNTIL },
      })
    }
  })

  // THE PREMIUM MEMBER BADGE IS UNLOCKED AT THE GRANT (13 Nov 2026). Badges
  // are only ever granted when somebody evaluates them, and the one place that
  // happened was the person opening their Achievements screen -- so a member
  // activated by an admin had no badge until they happened to. Evaluating here
  // writes the same row that screen would have written, just now. It reads
  // what is live (a PREMIUM_SUBSCRIBER badge, once earned, stays earned), so
  // ending Premium needs nothing, and it never throws: a failure costs the
  // badge arriving late, as before, and not the grant.
  if (action === "grant") await evaluateAchievements(id)

  return ok({ user: { id, premium: action === "grant", lifetime: action === "grant" } })
}
