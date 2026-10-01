/**
 * READ-ONLY. Counts the perishable/EXPIRED rows in BOTH `public` (live) and, if
 * DATABASE_URL carries one, the scratch schema. No live-guard: it writes
 * nothing, which is the documented exemption in scripts/lib/live-guard.ts.
 */
import { Client } from "pg"

async function main() {
  const raw = process.env.DATABASE_URL!
  const url = new URL(raw)
  const scratch = url.searchParams.get("schema")
  url.searchParams.delete("schema")

  const client = new Client({ connectionString: url.toString() })
  await client.connect()

  const schemas = ["public", ...(scratch && scratch !== "public" ? [scratch] : [])]
  for (const s of schemas) {
    const exists = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'Item'`,
      [s],
    )
    if (exists.rowCount === 0) {
      console.log(`  ${s}: no "Item" table`)
      continue
    }
    const r = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE "isPerishable")                          AS perishable,
         COUNT(*) FILTER (WHERE "status" = 'EXPIRED')                    AS expired,
         COUNT(*) FILTER (WHERE "isPerishable" AND "status" = 'EXPIRED') AS perishable_expired,
         COUNT(*) FILTER (WHERE "isPerishable" AND "status" = 'AVAILABLE') AS perishable_available,
         COUNT(*) FILTER (WHERE "isPerishable"
                            AND "status" = 'AVAILABLE'
                            AND "tradeWithinHours" IS NOT NULL
                            AND "createdAt" + make_interval(hours => "tradeWithinHours") < now()) AS due_now,
         COUNT(*)                                                        AS total
       FROM "${s}"."Item"`,
    )
    const x = r.rows[0]
    console.log(
      `  ${s.padEnd(22)} items=${x.total}  perishable=${x.perishable}  EXPIRED=${x.expired}  ` +
        `perishable+EXPIRED=${x.perishable_expired}  perishable+AVAILABLE=${x.perishable_available}  DUE NOW=${x.due_now}`,
    )
  }
  await client.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
