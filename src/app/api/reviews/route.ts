import { NextResponse } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { settleQuestsAsync } from "@/lib/quests"
import { SHOP_MEMBER_SELF_TRADE, isShopMemberPair, resolveTradeParticipant } from "@/lib/trade-participant"

/**
 * Rate a completed trade.
 *
 * ── A SHOP RATES AND IS RATED AS ITSELF (27 Sep 2026) ───────────────────────
 *
 * A review is a trust signal about the counterparty on THIS trade, and on a
 * shop's trade that counterparty is the shop's backing row: the customer's
 * review has always landed there (the storefront's Reviews tab reads it), and
 * the shop's review of the customer is written by its reviewerId. So the
 * reviewer is resolveTradeParticipant()'s participant, not session.user.id --
 * the same any-ACTIVE-member rule as accepting and settling. Which member
 * pressed the stars is unrecorded, like a shop's message reply.
 *
 * NOT ISSUANCE, so decision E ("shops earn no trade issuance") is untouched: a
 * review moves no Leaves, and the LEAVE_REVIEW quest below is settled for the
 * participant, which settleQuestsAsync() skips when it is an org row. Keying
 * the quest on the human instead would pay a staff member for a trade they
 * were never a party to.
 *
 * ── DECISION D IS RE-CHECKED HERE, NOT INHERITED ─────────────────────────────
 *
 * A shop and its own member cannot trade (isShopMemberPair on propose, accept,
 * start and submit), but a COMPLETED trade outlives those checks: a customer
 * who is hired as staff AFTER trading with the shop has a membership row the
 * trade never saw. Acting as the shop on that trade, resolveTradeParticipant()
 * picks the shop, the reviewee is the member's own row, and they would rate
 * THEMSELVES. So the pair is checked again at review time, either direction,
 * any membership status -- the same rule D applies everywhere else.
 */
export async function POST(req: Request) {
  const session = await resolveSession()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: { tradeId?: unknown; stars?: unknown; comment?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const { tradeId, stars, comment } = body

  if (typeof tradeId !== "string" || !tradeId) {
    return NextResponse.json({ error: "tradeId is required" }, { status: 400 })
  }
  if (!Number.isInteger(stars) || (stars as number) < 1 || (stars as number) > 5) {
    return NextResponse.json({ error: "stars must be an integer 1–5" }, { status: 400 })
  }
  const starsInt = stars as number
  const commentStr = typeof comment === "string" ? comment.trim() || null : null

  // Load trade — check existence, status, and participation
  const trade = await prisma.tradeRequest.findUnique({
    where: { id: tradeId },
    select: { id: true, status: true, senderId: true, receiverId: true },
  })

  if (!trade) {
    return NextResponse.json({ error: "Trade not found" }, { status: 404 })
  }
  if (trade.status !== "COMPLETED") {
    return NextResponse.json({ error: "Can only rate a completed trade" }, { status: 400 })
  }
  const who = await resolveTradeParticipant(session.user.id, req.headers, trade)
  if (!who.ok) {
    return who.kind === "org_refused"
      ? NextResponse.json({ error: who.message, code: "ORG_CONTEXT_REFUSED" }, { status: 403 })
      : NextResponse.json({ error: "Not a participant in this trade" }, { status: 403 })
  }
  const myId = who.participantId
  if (await isShopMemberPair(prisma, myId, who.partnerId)) {
    return NextResponse.json(
      { error: "You can't review a trade between a shop and one of its own members.", code: SHOP_MEMBER_SELF_TRADE },
      { status: 403 },
    )
  }

  // Derived reviewee — structurally guarantees no self-rating
  const revieweeId = who.partnerId

  // One rating per (trade, reviewer)
  const existing = await prisma.review.findUnique({
    where: { tradeId_reviewerId: { tradeId, reviewerId: myId } },
  })
  if (existing) {
    return NextResponse.json({ error: "You have already rated this trade" }, { status: 409 })
  }

  // Transactionally: create review + recalculate reviewee's average rating
  const [review] = await prisma.$transaction(async (tx) => {
    const created = await tx.review.create({
      data: {
        tradeId,
        reviewerId: myId,
        revieweeId,
        rating: starsInt,
        comment: commentStr,
      },
    })

    const agg = await tx.review.aggregate({
      where: { revieweeId },
      _avg: { rating: true },
    })

    await tx.user.update({
      where: { id: revieweeId },
      data: { rating: agg._avg.rating ?? 0 },
    })

    return [created]
  })

  // After the commit, so the check can see the review it is looking for.
  settleQuestsAsync(myId, ["LEAVE_REVIEW"])

  // Fire-and-forget notification — do not block the response
  const reviewer = await prisma.user.findUnique({
    where: { id: myId },
    select: { name: true },
  })
  await prisma.notification.create({
    data: {
      userId:  revieweeId,
      actorId: myId,
      type:    "NEW_REVIEW",
      message: `left you a ${starsInt}-star review`,
      link:    "/profile",
    },
  })

  return NextResponse.json({ ok: true, reviewId: review.id })
}
