import prisma from "@/lib/prisma"
import { ORG_CONTEXT_HEADER, resolveActingIdentity } from "@/lib/organizations"

/**
 * Whose listings this request may manage as their owner (25 Sep 2026).
 *
 * ── A SHOP'S LISTING IS ITS BACKING ROW'S ───────────────────────────────────
 *
 * A listing posted as a shop has `userId` = the org's backing User row, which
 * cannot sign in. Every owner check on a listing used to be
 * `item.userId === session.user.id`, so a shop's own listing opened as a
 * STRANGER's to the very people who posted it: "Item not found" in review and
 * hidden states, no Relist on expiry, and Edit / Delete / Appeal refused.
 *
 * Acting as a shop (X-Baylo-Org, re-checked against an ACTIVE membership by
 * resolveActingIdentity() on every request -- the same call resolveInbox()
 * and the boost route make), the backing row's listings are this request's
 * too. Any ACTIVE member, owner or staff, the same people who may post as the
 * shop.
 *
 * ── THE PERSON'S OWN LISTINGS STAY THEIRS ───────────────────────────────────
 *
 * `ownerIds` is the person AND the acting shop, never the shop instead of the
 * person. The header rides every request, and a person acting as a shop who
 * opens a listing from their personal shelf is still its owner -- the same
 * reason the boost route lets the listing pick the payer.
 *
 * ── NOTHING WIDENS WITHOUT THE HEADER ───────────────────────────────────────
 *
 * No header, a header naming a shop the listing does not belong to, or a
 * header from somebody who is not an ACTIVE member: `ownerIds` is the person
 * alone (or the request is refused), so a visitor and another shop's staff
 * see exactly the public view they saw before.
 *
 * ── A DEAD CONTEXT: REFUSED ON WRITES, IGNORED ON THE READ ──────────────────
 *
 * Writes answer 403 ORG_CONTEXT_REFUSED, like the inbox: an edit or appeal
 * silently re-attributed to the person is the wrong account on the strength
 * of an error. The detail READ falls back to the person instead, like
 * /api/v1/home -- a fallback there grants nothing (the public view), and a
 * listing screen that errors because a shop membership lapsed is worse.
 */

export type ListingOwnerResult =
  | { ok: true; ownerIds: string[] }
  | { ok: false; message: string }

export async function resolveListingOwners(
  humanUserId: string,
  headers: Pick<Headers, "get">,
): Promise<ListingOwnerResult> {
  const result = await resolveActingIdentity(prisma, humanUserId, headers.get(ORG_CONTEXT_HEADER))
  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === "membership_pending"
          ? "Accept the invitation before acting for this organisation"
          : "You are not a member of that organisation",
    }
  }
  const { actingUserId } = result.acting
  return { ok: true, ownerIds: actingUserId === humanUserId ? [humanUserId] : [humanUserId, actingUserId] }
}
