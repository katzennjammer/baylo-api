/**
 * Fixture helper: a deal created directly in its TRADE phase.
 *
 * Schema v2 merged Offer and TradeRequest into one Trade row per deal (see the
 * Trade model note). A script that used to `tradeRequest.create()` a trade
 * with no offer behind it -- a seeded swap, a legacy direct request, a reward
 * fixture -- now creates a Trade row with no offer phase: `offerStatus` NULL,
 * `status` set, and `tradeCreatedAt` set with it (a CHECK constraint ties the
 * two). The row comes back with `offeredItemId` typed as the string it always
 * is on a trade.
 *
 * Offers are NOT made here: a test of the offer phase writes
 * `trade.create({ data: { offerStatus: "PENDING", ... } })` itself, so it
 * reads as the model it is testing.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client"

type DealDb = Pick<PrismaClient, "trade">

export async function createTradeRow(
  db: DealDb,
  data: Omit<Prisma.TradeUncheckedCreateInput, "status" | "offeredItemId" | "tradeCreatedAt"> & {
    status: NonNullable<Prisma.TradeUncheckedCreateInput["status"]>
    offeredItemId: string
    tradeCreatedAt?: Date
  },
) {
  const at = data.tradeCreatedAt ?? (data.createdAt ? new Date(data.createdAt) : new Date())
  const row = await db.trade.create({ data: { ...data, createdAt: data.createdAt ?? at, tradeCreatedAt: at } })
  return { ...row, status: row.status!, offeredItemId: row.offeredItemId as string }
}
