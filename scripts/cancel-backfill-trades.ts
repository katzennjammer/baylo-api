// One-off, 16 Sep 2026: cancel the two `cmqfix*backfill*` TradeRequest rows.
//
// They were written by a June backfill as Leaves-for-item placeholders (the
// same listing in both item columns, 500 and 36 offeredLeaves) and never had a
// confirmation code generated. One of them could never complete -- its sender
// holds 60 Leaves against 500 -- and the other was a test row waiting to be
// mistaken for a real trade the day bracket trading shipped.
//
// It does what PATCH /api/trades/[id] { action: "cancel" } does, in ONE
// transaction, plus the audit row that route does not write because it is a
// participant's own act: the conditional status write, the IN_TRADE release
// (a no-op here; both items are AVAILABLE), the TRADE_CANCELLED notification to
// the other party, and an AdminAction row with the reason you asked for.
//
// NO LEDGER ROWS. The Leaves on these trades were never held -- `offeredLeaves`
// on a PENDING offer is subtracted arithmetically by availableLeaves() and on
// an ACCEPTED trade it is not counted anywhere until settlement debits it. The
// script proves that by printing the global invariant before and after.
//
//   npx tsx --env-file=.env scripts/cancel-backfill-trades.ts
//
// Idempotent: a row that is no longer ACCEPTED is reported and skipped.

import prisma from "@/lib/prisma"
import { writeAudit } from "@/lib/moderation"

const TRADE_IDS = ["cmqfix0001backfill000001a", "cmqfix0002backfill000002b"]
const REASON = "backfill test data"

async function invariant(label: string) {
  const [u, l] = await Promise.all([
    prisma.user.aggregate({ _sum: { leaves: true } }),
    prisma.leafTransaction.aggregate({ _sum: { amount: true } }),
  ])
  const ok = (u._sum.leaves ?? 0) === (l._sum.amount ?? 0)
  console.log(`${label}: SUM(User.leaves)=${u._sum.leaves} SUM(amount)=${l._sum.amount} ${ok ? "holds" : "BROKEN"}`)
  if (!ok) throw new Error("ledger invariant broken; stopping")
}

async function main() {
  const actor = await prisma.user.findFirst({
    where: { role: "ADMIN", deletedAt: null },
    select: { id: true, name: true, email: true },
    orderBy: { createdAt: "asc" },
  })
  if (!actor) throw new Error("no ADMIN account to attribute the audit row to")
  console.log(`acting as ${actor.name} <${actor.email}> (${actor.id})`)

  await invariant("before")
  const ledgerBefore = await prisma.leafTransaction.count()

  for (const tradeId of TRADE_IDS) {
    const trade = await prisma.tradeRequest.findUnique({
      where: { id: tradeId },
      select: {
        id: true, status: true, offeredLeaves: true, senderId: true, receiverId: true,
        offeredItemId: true, requestedItemId: true,
        sender: { select: { name: true } },
        requestedItem: { select: { title: true, status: true } },
      },
    })
    if (!trade) { console.log(`${tradeId}: not found, skipped`); continue }
    if (trade.status !== "ACCEPTED") { console.log(`${tradeId}: already ${trade.status}, skipped`); continue }

    await prisma.$transaction(async (tx) => {
      const moved = await tx.tradeRequest.updateMany({
        where: { id: tradeId, status: "ACCEPTED" },
        data: { status: "CANCELLED" },
      })
      if (moved.count !== 1) throw new Error(`${tradeId}: status moved under us`)

      const freed = await tx.item.updateMany({
        where: { id: { in: [trade.offeredItemId, trade.requestedItemId] }, status: "IN_TRADE" },
        data: { status: "AVAILABLE" },
      })

      await tx.notification.create({
        data: {
          userId: trade.receiverId,
          type: "TRADE_CANCELLED",
          message: `An admin cancelled the trade for "${trade.requestedItem.title}" (test data).`,
          link: "/dashboard/trades",
          actorId: actor.id,
          entityType: "trade",
          entityId: tradeId,
        },
      })

      await writeAudit(tx, {
        actorId: actor.id,
        action: "TRADE_CANCELLED",
        targetType: "TRADE",
        targetId: tradeId,
        reason: REASON,
        detail: {
          priorStatus: "ACCEPTED",
          offeredLeaves: trade.offeredLeaves,
          senderId: trade.senderId,
          receiverId: trade.receiverId,
          itemsFreed: freed.count,
          ledgerRowsWritten: 0,
        },
      })

      console.log(`${tradeId}: ACCEPTED -> CANCELLED, ${freed.count} item(s) freed, audit row written`)
    })
  }

  const ledgerAfter = await prisma.leafTransaction.count()
  console.log(`ledger rows: ${ledgerBefore} -> ${ledgerAfter} (${ledgerAfter - ledgerBefore} written)`)
  await invariant("after")
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
