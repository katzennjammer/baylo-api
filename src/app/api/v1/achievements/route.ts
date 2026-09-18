import { resolveSession } from "@/lib/api-auth"
import { getAchievementsForUser } from "@/lib/achievements"
import { fail, ok, unauthenticated } from "@/lib/v1/envelope"

export const dynamic = "force-dynamic"

export async function GET() {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()

  try {
    return ok({ achievements: await getAchievementsForUser(session.user.id) })
  } catch {
    return fail("INTERNAL_ERROR", "Achievements are temporarily unavailable. Try again shortly.")
  }
}
