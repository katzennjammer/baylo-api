// Counts live rows that use an enum value the CHECKED-OUT branch's Prisma
// client does not know.
//
// ── WHY ─────────────────────────────────────────────────────────────────────
//
// Prisma refuses to deserialise a row whose enum column holds a value outside
// the generated type. So the moment one branch's migration adds an enum value
// to the SHARED live database and something writes a row using it, every
// checkout whose schema lacks that value 500s on any query touching the table
// -- not on the feature, on the table.
//
// That gap opened on 16 Sep 2026: bracket-trading deployed
// 20260916000000_bracket_trading to live while main still had the old schema,
// and two AdminAction rows (the June backfill trades, cancelled with audit
// rows) used TRADE_CANCELLED / TRADE. main's admin audit page would have
// thrown on them.
//
// IT IS CLOSED, AND THIS SCRIPT IS HOW IT STAYS CLOSED. main took the schema
// side of that migration -- enum values and nullable columns, no feature code
// -- so every value below is now modelled by both branches and MAIN_LACKS is
// empty. The pattern is the rule for next time: when a branch migrates the
// shared database, the schema half lands on main first, and nothing writes a
// new value until it has.
//
//   npx tsx --env-file=.env scripts/check-new-enum-rows.ts
//
// Exits 1 only if a value in MAIN_LACKS is in use. Raw SQL on purpose: the
// whole point is to count values a client may not model.

import prisma from "@/lib/prisma"

/**
 * Values the live database can hold that `main` CANNOT read.
 *
 * Empty since main took the schema-only commits (16 Sep, and again 25 Sep for
 * FEATURE_BOOST and ORG_INVITE, and again for LISTING_EXPIRED). Add to it the moment a branch
 * deploys an enum value main has not got, and empty it again when main does.
 */
const MAIN_LACKS: readonly string[] = []

const CHECKS: { table: string; column: string; values: string[] }[] = [
  { table: "LeafTransaction", column: "type", values: ["BRIDGE_FEE_HOLD", "BRIDGE_FEE_RELEASE", "BRIDGE_FEE_PAID", "TRADE_REWARD", "TRADE_REWARD_REVERSAL"] },
  { table: "Item", column: "status", values: ["PENDING_REVIEW", "VALUE_REJECTED"] },
  { table: "TaskCompletion", column: "task", values: ["FIRST_TRADE"] },
  { table: "AdminAction", column: "action", values: ["LISTING_VALUE_APPROVED", "LISTING_VALUE_REJECTED", "TRADE_REWARD_REVERSED", "TRADE_CANCELLED", "LISTING_APPEAL_UPHELD", "LISTING_APPEAL_OVERTURNED"] },
  { table: "AdminAction", column: "targetType", values: ["TRADE", "LISTING_APPEAL"] },
  { table: "Notification", column: "type", values: ["LISTING_VALUE_APPROVED", "LISTING_VALUE_REJECTED", "LISTING_HIDDEN", "LISTING_APPEAL_UPHELD", "LISTING_APPEAL_OVERTURNED"] },
  // 18 Sep 2026: value rejections and appeals (20260918000000_value_rejection_appeals).
  { table: "Item", column: "valueRejectionReason", values: ["OVERVALUED_FOR_CONDITION", "ABOVE_MARKET", "WRONG_CATEGORY", "PHOTOS_DO_NOT_SUPPORT_VALUE", "OTHER"] },
  { table: "ListingAppeal", column: "status", values: ["OPEN", "UPHELD", "OVERTURNED", "WITHDRAWN"] },
  // 24-25 Sep 2026: featured boosts and staff-invite notifications.
  { table: "LeafTransaction", column: "type", values: ["FEATURE_BOOST"] },
  { table: "Notification", column: "type", values: ["ORG_INVITE"] },
  // 25 Sep 2026: perishable expiry notices (20260925000002_listing_expired_notification).
  { table: "Notification", column: "type", values: ["LISTING_EXPIRED"] },
]

const COLUMNS: { table: string; column: string }[] = [
  { table: "Offer", column: "bridgeFeeLeaves" },
  { table: "Offer", column: "consentAt" },
  { table: "TradeRequest", column: "bridgeFeeLeaves" },
]

async function main() {
  let unreadable = 0
  console.log("rows using a value the bracket-trading migration added:")
  for (const c of CHECKS) {
    for (const v of c.values) {
      const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*)::bigint AS n FROM "${c.table}" WHERE "${c.column}"::text = $1`, v,
      )
      const count = Number(n)
      const lacking = MAIN_LACKS.includes(v)
      if (count > 0 && lacking) unreadable++
      const note = count > 0 && lacking ? "   <- main CANNOT read this" : ""
      console.log(`  ${String(count).padStart(4)}  ${c.table}.${c.column} = ${v}${note}`)
    }
  }
  console.log("rows with a value in a column main models but never selects (harmless, listed for completeness):")
  for (const c of COLUMNS) {
    const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*)::bigint AS n FROM "${c.table}" WHERE "${c.column}" IS NOT NULL`,
    )
    console.log(`  ${String(Number(n)).padStart(4)}  ${c.table}.${c.column} IS NOT NULL`)
  }
  const [{ n: userSet }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*)::bigint AS n FROM "Item" WHERE "valueSetByUser"`)
  console.log(`  ${String(Number(userSet)).padStart(4)}  Item.valueSetByUser = true (backfilled; a default-false column main never reads)`)

  console.log(
    unreadable === 0
      ? "\nSAFE FOR MAIN: main's schema models every value live holds"
      : `\nNOT SAFE FOR MAIN: ${unreadable} value(s) in use that main cannot read`,
  )
  await prisma.$disconnect()
  process.exit(unreadable === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
