import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ORG_CONTEXT_HEADER, resolveActingIdentity } from "@/lib/organizations"
import { ok, unauthenticated, notFound, conflict, invalid, forbidden } from "@/lib/v1/envelope"
import { parseQuery } from "@/lib/v1/query"
import { enforceRateLimit } from "@/lib/rate-limit-config"
import { expireStaleOffers } from "@/lib/offers"
import { BOOST_COST_LEAVES, BOOST_HOURS, boostItem } from "@/lib/featured"

export const dynamic = "force-dynamic"

/**
 * POST /api/v1/items/[id]/boost — pay BOOST_COST_LEAVES to feature this
 * listing for BOOST_HOURS. The rules and the transaction are boostItem() in
 * @/lib/featured; this route is identity, sweeping and the error mapping.
 *
 * ── WHO PAYS ────────────────────────────────────────────────────────────────
 *
 * The ACTING identity, for its own listing, from its own balance: the person
 * themselves, or -- when X-Baylo-Org names an organisation they are an ACTIVE
 * member of -- the org's backing row. The same resolveActingIdentity() call
 * POST /api/items makes, so a listing posted as the shop is boosted as the
 * shop, from the shop's balance (which is where the verified-MSME welcome
 * grant lands).
 *
 * Changed 25 Sep 2026. This used to be `session.user.id` only, and the Post
 * flow's "Boost this listing after posting" box, ticked while acting as an
 * org, charged the person for a listing whose userId was the org's: the
 * ownership test missed and the owner was told "That listing is no longer
 * available" about a listing they had posted a second earlier.
 *
 * THE LISTING PICKS THE PAYER, NOT THE HEADER ALONE. The header rides every
 * request, but the item screen and My Listings are still the PERSON's (they
 * draw Boost off `viewer.isOwner`, which ignores the header), so a person
 * acting as a shop can boost their own listing from there. The org pays only
 * when the listing is the acting org's; anything else is charged to the
 * person, exactly as before. The rate limit stays on the human, like every
 * limiter.
 *
 * NOT IDEMPOTENT, AND DELIBERATELY NOT A 200 ON A REPEAT. A second boost on a
 * listing that is already featured is a 409 carrying `featuredUntil`, so a
 * client retrying after a lost response can tell "it went through" from "it
 * did not" without a second charge ever being possible.
 */

const querySchema = z.strictObject({})

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const humanId = session.user.id
  const { id } = await params

  const parsed = parseQuery(req, querySchema)
  if (!parsed.ok) return parsed.response

  const limited = enforceRateLimit("boost", humanId)
  if (limited) return limited

  const acting = await resolveActingIdentity(prisma, humanId, req.headers.get(ORG_CONTEXT_HEADER))
  if (!acting.ok) {
    return forbidden(
      acting.reason === "membership_pending"
        ? "Accept the invitation before acting for this organisation"
        : "You are not a member of that organisation",
    )
  }
  const { actingUserId } = acting.acting
  const listing =
    actingUserId !== humanId
      ? await prisma.item.findUnique({ where: { id }, select: { userId: true } })
      : null
  const ownerId = listing?.userId === actingUserId ? actingUserId : humanId

  // availableLeaves() inside boostItem() reads PENDING offers, and an offer
  // past its window is PENDING until something moves it. See the note there.
  await expireStaleOffers(prisma, { senderId: ownerId })

  const result = await boostItem(prisma, { itemId: id, ownerId })

  if (result.ok) {
    return ok({
      itemId: id,
      featuredAt: result.featuredAt,
      featuredUntil: result.featuredUntil,
      cost: BOOST_COST_LEAVES,
      balance: result.balance,
    })
  }

  switch (result.reason) {
    case "not_found":
      return notFound("That listing is no longer available")
    case "perishable":
      return invalid("Perishable listings can't be featured", { rule: "perishable" })
    case "not_available":
      return conflict("Only available listings can be featured", { rule: "not_available" })
    case "already_featured": {
      const row = await prisma.item.findUnique({ where: { id }, select: { featuredUntil: true } })
      return conflict("This listing is already featured", {
        rule: "already_featured",
        featuredUntil: row?.featuredUntil ?? null,
      })
    }
    case "insufficient_leaves":
      return conflict(
        `Featuring a listing for ${BOOST_HOURS} hours costs ${BOOST_COST_LEAVES} Leaves`,
        { rule: "insufficient_leaves", balance: result.have ?? 0, requested: BOOST_COST_LEAVES },
      )
  }
}
