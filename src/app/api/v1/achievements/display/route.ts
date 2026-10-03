import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok, unauthenticated } from "@/lib/v1/envelope"

const updateSchema = z.object({
  achievementIds: z.array(z.string()).default([]),
  featuredAchievementId: z.string().nullable().optional(),
})

export const dynamic = "force-dynamic"

export async function PATCH(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()

  try {
    const body = await req.json().catch(() => ({}))
    const parsed = updateSchema.safeParse(body)
    if (!parsed.success) return ok({ ok: false, error: "Invalid payload" })

    const { achievementIds, featuredAchievementId } = parsed.data

    // ── TYPED WRITES, NOT RAW SQL (schema v2) ──────────────────────────────
    //
    // These were `$executeRaw` against a schema-qualified "UserAchievement".
    // Earned badges are ACHIEVEMENT rows of UserProgress now, and every write
    // below is a Prisma model call scoped by `type` -- so it can neither reach
    // another schema nor touch a QUEST row, and no id is ever spliced into SQL
    // (the 23 Sep 2026 injection was a spliced id). The column feature-detect
    // is gone with the raw SQL: homeDisplayOrder always exists in v2.
    //
    // Same three steps, same results, as the raw version:
    //   1  clear the whole shelf (so a REMOVED badge leaves it);
    //   2  number the picks 1..n, first occurrence winning, as the CASE did;
    //   3  the home slot: 1 on the featured badge, NULL on every other.
    const userId = session.user.id
    const mine = { userId, type: "ACHIEVEMENT" as const }
    const picks = [...new Set(achievementIds)]

    await prisma.$transaction(async (tx) => {
      await tx.userProgress.updateMany({ where: mine, data: { displayOrder: null } })
      for (let index = 0; index < picks.length; index++) {
        await tx.userProgress.updateMany({ where: { ...mine, achievementId: picks[index] }, data: { displayOrder: index + 1 } })
      }
      await tx.userProgress.updateMany({ where: mine, data: { homeDisplayOrder: null } })
      if (featuredAchievementId) {
        await tx.userProgress.updateMany({ where: { ...mine, achievementId: featuredAchievementId }, data: { homeDisplayOrder: 1 } })
      }
    })

    return ok({ ok: true })
  } catch {
    return ok({ ok: false, error: "Could not update achievements" })
  }
}
