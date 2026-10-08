// Give a schema built by `prisma db push` the display views that migrations
// create on every migrated database (today: "ItemWantedCategorySummary").
//
//   DATABASE_URL=...?schema=scratch_x npx tsx --env-file=.env scripts/create-display-views.ts
//
// `db push` builds tables from schema.prisma and knows nothing about views,
// so without this a push-built scratch schema would differ from live.
// scripts/scratch.ps1 runs it after every push. It runs the view MIGRATION
// FILE itself (one source of truth) through scripts/lib/migration-runner.ts,
// and is SCRATCH ONLY: the runner refuses any target but scratch_*/schema_v2_*.
import "dotenv/config"
import { Client } from "pg"
import { isScratchTarget, loadMigration, withGuardedTransaction } from "./lib/migration-runner"
import { targetSchema } from "./lib/live-guard"

const VIEW_MIGRATIONS = ["20261008100000_item_wanted_category_summary_view"]

const schema = targetSchema()
if (schema === "public" || !isScratchTarget(schema)) {
  console.error(`  REFUSING: create-display-views.ts runs on scratch schemas only (got "${schema}")`)
  process.exit(1)
}
const u = new URL(process.env.DATABASE_URL!)
u.searchParams.delete("schema")

;(async () => {
  const migrations = await Promise.all(VIEW_MIGRATIONS.map(loadMigration))
  const pg = new Client({ connectionString: u.toString() })
  await pg.connect()
  try {
    await withGuardedTransaction(pg, { target: schema }, async (g) => {
      for (const m of migrations) await g.run(m.batch)
    })
    console.log(`  views: ${migrations.length} created in ${schema}`)
  } finally { await pg.end() }
})().catch((e) => { console.error(`  create-display-views failed: ${(e as Error).message}`); process.exit(1) })
