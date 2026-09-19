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

    // Clear the whole shelf first, then set the picked order. The blanket reset
    // is what makes a badge the user REMOVED leave the shelf: an update scoped to
    // `achievementId IN (...)` could only ever touch the badges that stayed, so a
    // deselected badge kept its stale displayOrder and reappeared on the next
    // load. This also handles the empty selection (cleared shelf) correctly.
    await prisma.$executeRawUnsafe(
      `
        UPDATE "UserAchievement"
        SET "displayOrder" = NULL
        WHERE "userId" = '${session.user.id}'
      `,
    )

    if (achievementIds.length > 0) {
      await prisma.$executeRawUnsafe(
        `
          UPDATE "UserAchievement"
          SET "displayOrder" = CASE "achievementId"
            ${achievementIds.map((id, index) => `WHEN '${id.replace(/'/g, "''")}' THEN ${index + 1}`).join(" ")}
            ELSE NULL
          END
          WHERE "userId" = '${session.user.id}'
            AND "achievementId" IN (${achievementIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(", ")})
        `,
      )
    }

    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'UserAchievement' AND column_name = 'homeDisplayOrder'
    `

    if (columns.length > 0) {
      if (featuredAchievementId) {
        await prisma.$executeRawUnsafe(
          `
            UPDATE "UserAchievement"
            SET "homeDisplayOrder" = CASE "achievementId"
              WHEN '${featuredAchievementId.replace(/'/g, "''")}' THEN 1
              ELSE NULL
            END
            WHERE "userId" = '${session.user.id}'
          `,
        )
      } else {
        await prisma.$executeRawUnsafe(
          `
            UPDATE "UserAchievement"
            SET "homeDisplayOrder" = NULL
            WHERE "userId" = '${session.user.id}'
          `,
        )
      }
    } else if (featuredAchievementId && achievementIds.length > 0) {
      await prisma.$executeRawUnsafe(
        `
          UPDATE "UserAchievement"
          SET "displayOrder" = CASE "achievementId"
            WHEN '${featuredAchievementId.replace(/'/g, "''")}' THEN 1
            ELSE "displayOrder"
          END
          WHERE "userId" = '${session.user.id}'
            AND "achievementId" = '${featuredAchievementId.replace(/'/g, "''")}'
        `,
      )
    }

    return ok({ ok: true })
  } catch {
    return ok({ ok: false, error: "Could not update achievements" })
  }
}
