import { resolveSession } from "@/lib/api-auth"
import { ok, unauthenticated } from "@/lib/v1/envelope"

export const dynamic = "force-dynamic"

/**
 * GET /api/v1/featured -- RETIRED in schema v2: Featured boosts were removed.
 *
 * Answers an EMPTY section in the shape it always had, rather than 404 or 410,
 * because shipped APKs still draw a Featured row from it: an empty list is
 * exactly what they already render as "nothing featured", so an old build
 * degrades to the new behaviour instead of showing an error. The route comes
 * out when the last build that calls it is gone.
 */
export async function GET() {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  return ok({ items: [] }, { category: null, categoryLabel: null, cap: 0, total: 0, retired: true })
}
