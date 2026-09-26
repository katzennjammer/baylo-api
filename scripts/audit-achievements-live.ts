/**
 * READ-ONLY. Counts the "UserAchievement" shelf/feature rows in `public` (live)
 * and, if DATABASE_URL carries one, the scratch schema too.
 *
 * No live-guard: it writes nothing, which is the documented exemption in
 * scripts/lib/live-guard.ts. Its job is to be the before-and-after witness for
 * anything that touches PATCH /api/v1/achievements/display, whose five raw
 * UPDATEs could not previously be trusted to stay inside their own schema.
 */
import { Client } from "pg"

async function main() {
  const url = new URL(process.env.DATABASE_URL!)
  const scratch = url.searchParams.get("schema")
  url.searchParams.delete("schema")

  const client = new Client({ connectionString: url.toString() })
  await client.connect()

  for (const s of ["public", ...(scratch && scratch !== "public" ? [scratch] : [])]) {
    const exists = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'UserAchievement'`,
      [s],
    )
    if (exists.rowCount === 0) {
      console.log(`  ${s}: no "UserAchievement" table`)
      continue
    }
    const r = await client.query(
      `SELECT COUNT(*)                                                AS total,
              COUNT(*) FILTER (WHERE "displayOrder" IS NOT NULL)      AS shelved,
              COUNT(*) FILTER (WHERE "homeDisplayOrder" IS NOT NULL)  AS featured,
              COALESCE(SUM("displayOrder"), 0)                        AS order_sum,
              COUNT(DISTINCT "userId")                                AS users
       FROM "${s}"."UserAchievement"`,
    )
    const x = r.rows[0]
    console.log(
      `  ${s.padEnd(22)} rows=${x.total}  displayOrder set=${x.shelved}  ` +
        `homeDisplayOrder set=${x.featured}  SUM(displayOrder)=${x.order_sum}  distinct users=${x.users}`,
    )
  }
  await client.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
