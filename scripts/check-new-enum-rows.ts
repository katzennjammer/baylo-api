// Counts live rows that use an enum value main's Prisma client does not know.
//
// The bracket-trading migration (16 Sep 2026) added enum VALUES to the live
// database while `main` still ran the old client. That is safe only while no
// row USES one of them: Prisma refuses to deserialise a row whose enum column
// holds a value outside the generated type, so a single PENDING_REVIEW item
// would make main's feed query throw. Run this before switching a live server
// back to main, and expect every count to be zero.
//
//   npx tsx --env-file=.env scripts/check-new-enum-rows.ts
//
// Exits 1 when any count is non-zero. Raw SQL on purpose: the whole point is
// to count values the client may not model.

import prisma from "@/lib/prisma"

const CHECKS: { table: string; column: string; values: string[] }[] = [
  { table: "LeafTransaction", column: "type", values: ["BRIDGE_FEE_HOLD", "BRIDGE_FEE_RELEASE", "BRIDGE_FEE_PAID", "TRADE_REWARD", "TRADE_REWARD_REVERSAL"] },
  { table: "Item", column: "status", values: ["PENDING_REVIEW"] },
  { table: "TaskCompletion", column: "task", values: ["FIRST_TRADE"] },
  { table: "AdminAction", column: "action", values: ["LISTING_VALUE_APPROVED", "LISTING_VALUE_REJECTED", "TRADE_REWARD_REVERSED", "TRADE_CANCELLED"] },
  { table: "AdminAction", column: "targetType", values: ["TRADE"] },
  { table: "Notification", column: "type", values: ["LISTING_VALUE_APPROVED", "LISTING_VALUE_REJECTED"] },
]

const COLUMNS: { table: string; column: string }[] = [
  { table: "Offer", column: "bridgeFeeLeaves" },
  { table: "Offer", column: "consentAt" },
  { table: "TradeRequest", column: "bridgeFeeLeaves" },
]

async function main() {
  let nonZero = 0
  console.log("rows using an enum value main's client does not know:")
  for (const c of CHECKS) {
    for (const v of c.values) {
      const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*)::bigint AS n FROM "${c.table}" WHERE "${c.column}"::text = $1`, v,
      )
      const count = Number(n)
      if (count > 0) nonZero++
      console.log(`  ${String(count).padStart(4)}  ${c.table}.${c.column} = ${v}`)
    }
  }
  console.log("rows with a value in a column main's client does not select (harmless to main, listed for completeness):")
  for (const c of COLUMNS) {
    const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*)::bigint AS n FROM "${c.table}" WHERE "${c.column}" IS NOT NULL`,
    )
    console.log(`  ${String(Number(n)).padStart(4)}  ${c.table}.${c.column} IS NOT NULL`)
  }
  const [{ n: userSet }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*)::bigint AS n FROM "Item" WHERE "valueSetByUser"`)
  console.log(`  ${String(Number(userSet)).padStart(4)}  Item.valueSetByUser = true (backfilled; a default-false column main never reads)`)

  console.log(nonZero === 0 ? "\nSAFE FOR MAIN: no row uses a new enum value" : `\nNOT SAFE FOR MAIN: ${nonZero} value(s) in use`)
  await prisma.$disconnect()
  process.exit(nonZero === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
