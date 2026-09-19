import { NextRequest } from "next/server"
import { z } from "zod"
import prisma from "@/lib/prisma"
import { requireRole } from "@/lib/api-auth"
import { writeAudit } from "@/lib/moderation"
import { reverseTradeRewards } from "@/lib/trade-reward"
import { ok, notFound, conflict } from "@/lib/v1/envelope"
import { parseJsonBody } from "@/lib/v1/body"

export const dynamic = "force-dynamic"

/**
 * POST /api/admin/trades/[id]/reverse-reward — take back the completion reward.
 *
 * ── WHAT THIS DOES AND, MORE IMPORTANTLY, WHAT IT DOES NOT ──────────────────
 *
 * A completed trade issues new Leaves to both parties: 2 x the bracket of the
 * item each of them gave. When a trade turns out to have been staged -- two
 * accounts run by one person, a swap that never happened, an item that was
 * never handed over -- those Leaves were minted for nothing and this is how
 * they come back out.
 *
 * IT REVERSES THE REWARD ONLY. Not the trade, not the item ownership, and NOT
 * THE BRIDGING FEE:
 *
 *   the items       changed hands between two people in a car park. No column
 *                   in this database can bring one back, and a route called
 *                   reverseTrade() would be a fiction with a stack trace. The
 *                   same argument the deferred-agreement module used to make
 *                   about repossession, and it has not got any less true.
 *   the fee         priced the bracket one side moved up into, and it was paid
 *                   BY a person TO a person for a swap that (as far as this
 *                   system can know) happened. Clawing it back would take
 *                   Leaves from somebody who did nothing wrong and give them to
 *                   somebody who may have.
 *   the reward      was ISSUANCE. Nobody paid it; the system made it. Taking it
 *                   back costs no user anything they earned, which is exactly
 *                   why it is the one part that can honestly be undone.
 *
 * ── IT CAN TAKE A BALANCE NEGATIVE ──────────────────────────────────────────
 *
 * Deliberately. The alternative -- clamping at zero -- would mean spending the
 * Leaves first makes them un-reversible, which turns "spend it quickly" into
 * the correct strategy for anyone farming rewards. `availableLeaves()` already
 * clamps what a negative account may COMMIT at zero, so the account simply
 * cannot bridge again until it earns its way back up. `lifetimeLeaves` moves
 * down too: the reward was not earned, and the rank ladder reads lifetime.
 *
 * Idempotent: a reversal already on the ledger for (user, trade) is not
 * written twice, so a double-click reverses once and reports zero the second
 * time.
 */

const bodySchema = z.strictObject({
  reason: z
    .string()
    .trim()
    .min(1, "A reason is required — it is written to the audit log")
    .max(1000),
  reportId: z.string().min(1).max(64).optional(),
})

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireRole("ADMIN")
  if (gate.response) return gate.response
  const actor = gate.actor

  const { id } = await params
  const parsed = await parseJsonBody(req, bodySchema)
  if (!parsed.ok) return parsed.response
  const { reason, reportId } = parsed.data

  const trade = await prisma.tradeRequest.findUnique({
    where: { id },
    select: {
      id: true, status: true, senderId: true, receiverId: true,
      sender: { select: { name: true } },
      receiver: { select: { name: true } },
    },
  })
  if (!trade) return notFound("Trade not found")
  if (trade.status !== "COMPLETED") {
    return conflict("Only a completed trade has a reward to reverse", { code: "NOT_COMPLETED" })
  }

  const rewards = await prisma.leafTransaction.findMany({
    where: { tradeId: id, type: "TRADE_REWARD" },
    select: { userId: true, amount: true },
  })
  if (rewards.length === 0) {
    return conflict("No trade reward was issued for this trade", { code: "NO_REWARD" })
  }

  // The reversal rows, both balances and the audit row in one transaction. An
  // audit row written afterwards is one that can fail to exist for Leaves that
  // did move, and this is the only route in the admin tree that moves any.
  const reversed = await prisma.$transaction(async (tx) => {
    const done = await reverseTradeRewards(tx, id)
    await writeAudit(tx, {
      actorId: actor.id,
      action: "TRADE_REWARD_REVERSED",
      targetType: "TRADE",
      targetId: id,
      reportId: reportId ?? null,
      reason,
      detail: {
        reversed: done,
        senderId: trade.senderId,
        receiverId: trade.receiverId,
        // Stated so the row answers "and what about the fee?" without anybody
        // having to read this file.
        bridgingFeeUntouched: true,
        itemsUntouched: true,
      },
    })
    return done
  })

  return ok({
    tradeId: id,
    reversed,
    totalLeaves: reversed.reduce((n, r) => n + r.amount, 0),
    audited: true,
  })
}
