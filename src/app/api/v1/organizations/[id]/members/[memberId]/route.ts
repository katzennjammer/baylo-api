import { gone } from "@/lib/v1/envelope"
import { STAFF_REMOVED_MESSAGE } from "@/lib/org-staff"

export const dynamic = "force-dynamic"

/**
 * /api/v1/organizations/[id]/members/[memberId] -- answering an invitation,
 * changing a role, removing staff. All GONE since schema v2, when
 * organisation staff were removed (see ../route.ts). 410, not 404, for the
 * reason the v1/contracts stubs give: shipped APKs still call these.
 */
export async function PATCH() {
  return gone(STAFF_REMOVED_MESSAGE, { since: "schema-v2" })
}

export async function DELETE() {
  return gone(STAFF_REMOVED_MESSAGE, { since: "schema-v2" })
}
