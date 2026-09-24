import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok, unauthenticated, notFound, conflict, invalid } from "@/lib/v1/envelope"
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
 * The signed-in person, for their own listing, from their own balance -- the
 * same `item.userId === session.user.id` test the detail route's `isOwner`
 * and the edit/delete routes make. Deliberately NOT the org acting identity:
 * the Boost button is drawn off `viewer.isOwner`, and a route that resolved
 * ownership differently from the flag that draws its button would refuse
 * taps the screen invited. Boosting an organisation's listings from the org's
 * balance is a separate decision, to be made with edit and delete.
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
  const ownerId = session.user.id
  const { id } = await params

  const parsed = parseQuery(req, querySchema)
  if (!parsed.ok) return parsed.response

  const limited = enforceRateLimit("boost", ownerId)
  if (limited) return limited

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
