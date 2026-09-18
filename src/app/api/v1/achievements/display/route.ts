import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import { setDisplayedAchievements } from "@/lib/achievements"
import { invalid, ok, unauthenticated } from "@/lib/v1/envelope"

const bodySchema = z.strictObject({
  achievementIds: z.array(z.string().min(1)).max(3),
  featuredAchievementId: z.string().min(1).nullable().optional(),
})

export async function PATCH(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const body = await req.json().catch(() => null)
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return invalid("Choose up to 3 achievements and optionally one featured home badge")

  try {
    await setDisplayedAchievements(
      session.user.id,
      parsed.data.achievementIds,
      parsed.data.featuredAchievementId ?? null,
    )
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "Could not update displayed achievements")
  }
  return ok({ saved: true })
}
