import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok, unauthenticated, notFound, forbidden, conflict } from "@/lib/v1/envelope"
import { parseJsonBody } from "@/lib/v1/body"
import { MEETUP_SELECT, v1MeetupPlan } from "@/lib/meetup"

export const dynamic = "force-dynamic"

/**
 * POST /api/v1/trades/[id]/meetup/accept — the other side agrees to the plan.
 *
 * The only write is `meetupAgreedAt`. The plan itself is not re-sent and cannot
 * be edited here: agreeing to a place and time you are simultaneously changing
 * is a counter-proposal, and that is POST …/meetup.
 *
 * ══ YOU CANNOT AGREE WITH YOURSELF ══════════════════════════════════════════
 *
 * `meetupProposedBySender` says which side put the plan on the table, and the
 * caller must be the other one. Without that check the "agreement" is one person
 * pressing two buttons, which is worth exactly nothing to the person who has to
 * travel somewhere on the strength of it.
 *
 * That guard is cheap here only because the column is a SIDE rather than a
 * userId — a boolean compared against `senderId`/`receiverId` cannot name
 * somebody outside this trade. See the schema block.
 *
 * ══ THIS DOES NOT ISSUE CODES ═══════════════════════════════════════════════
 *
 * Agreeing a meeting and starting a confirmation stay separate. Codes expire in
 * 15 minutes; a pair minted when a meeting is agreed for Saturday would be dead
 * long before anyone read one out, and the trade would sit in CONFIRMING having
 * confirmed nothing. Codes come from arriving at the code screen, which is what
 * POST …/confirm/start means and where the plan is finally claimed.
 */

const bodySchema = z.strictObject({
  /**
   * What the agreeing party believes they are agreeing to, echoed back.
   *
   * Optional, and it is the same protection `contracts/[id]/accept` offers for
   * the same reason: a counter-proposal may have landed between the screen
   * rendering and the tap, and agreeing to a plan that changed underneath is the
   * one failure here that ends with somebody at the wrong place. A client that
   * sends these gets a 409 instead.
   */
  confirmHubId: z.string().min(1).max(64).optional(),
  confirmAt: z.string().datetime({ offset: true }).optional(),
})

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const viewerId = session.user.id
  const { id } = await params

  const parsed = await parseJsonBody(req, bodySchema)
  if (!parsed.ok) return parsed.response
  const { confirmHubId, confirmAt } = parsed.data

  const trade = await prisma.tradeRequest.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      senderId: true,
      receiverId: true,
      ...MEETUP_SELECT,
    },
  })
  if (!trade) return notFound("Trade not found")
  if (trade.senderId !== viewerId && trade.receiverId !== viewerId) {
    return forbidden("That trade is not yours")
  }
  if (trade.status !== "ACCEPTED") {
    return conflict("That trade has moved past arranging a meeting.")
  }
  if (!trade.meetupHubId || !trade.meetupAt || trade.meetupProposedBySender === null) {
    return conflict("There is no meeting plan to agree to yet.")
  }

  const viewerIsSender = trade.senderId === viewerId
  if (trade.meetupProposedBySender === viewerIsSender) {
    return conflict("You proposed this one. It is waiting on the other person.")
  }

  if (trade.meetupAgreedAt) {
    // Already agreed, by the only person who could have agreed to it. Answering
    // 200 with the plan rather than 409 makes a double tap — or a retry after a
    // dropped response — land on the state the caller wanted.
    return ok({ plan: v1MeetupPlan(trade), alreadyAgreed: true })
  }

  if (confirmHubId && confirmHubId !== trade.meetupHubId) {
    return conflict("That plan changed before you agreed. Have another look.")
  }
  if (confirmAt && new Date(confirmAt).getTime() !== trade.meetupAt.getTime()) {
    return conflict("That plan changed before you agreed. Have another look.")
  }

  const updated = await prisma.tradeRequest.update({
    where: { id },
    data: { meetupAgreedAt: new Date() },
    select: { id: true, ...MEETUP_SELECT },
  })

  const partnerId = viewerIsSender ? trade.receiverId : trade.senderId

  await prisma.notification.create({
    data: {
      userId: partnerId,
      type: "MEETUP_AGREED",
      message: `agreed to meet at ${trade.meetupHub?.name ?? "the hub you suggested"}`,
      actorId: viewerId,
      entityType: "meetup",
      entityId: trade.id,
    },
  }).catch(() => {
    // The agreement is recorded. A failed notification must not make the caller
    // retry a write that has already happened.
  })

  return ok({ plan: v1MeetupPlan(updated) })
}
