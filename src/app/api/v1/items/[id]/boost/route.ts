import { gone } from "@/lib/v1/envelope"

export const dynamic = "force-dynamic"

/**
 * POST /api/v1/items/[id]/boost -- GONE since schema v2: Featured boosts were
 * removed, and the Item columns that held a boost no longer exist.
 *
 * 410 and not a deleted file, for the reason the v1/contracts stubs give:
 * shipped APKs still call it, and a 404 reads as "wrong URL" and invites a
 * retry that can never work. Nothing is charged. The FEATURE_BOOST ledger rows
 * written before the removal stay, as every ledger row does.
 */
const MESSAGE = "Featured boosts have been removed. Your listing stays visible in the feed and search as usual."

export async function POST() {
  return gone(MESSAGE, { since: "schema-v2" })
}
