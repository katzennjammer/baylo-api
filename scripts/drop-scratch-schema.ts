// Drops one scratch schema. Called by scripts/scratch.ps1 -Drop; usable alone:
//
//   npx tsx --env-file=.env scripts/drop-scratch-schema.ts scratch_x
//
// A FILE, NOT `npx tsx -e "..."`: the inline form resolved `require("pg")`
// from tsx's own install under the npm cache rather than from this project,
// and -Drop failed with MODULE_NOT_FOUND from 17 Sep 2026 until this file
// replaced it. A script on disk resolves from scripts/, which is inside the
// project, so `pg` is found where package.json put it.
//
// Refuses anything not named scratch_*, whatever the caller says. `public` is
// live and there is no flag that makes this file drop it.
import { Client } from "pg"

const name = process.argv[2] ?? ""
if (!/^scratch_[a-z0-9_]+$/.test(name)) {
  console.error(`refusing to drop "${name}": only scratch_[a-z0-9_]+ schemas are dropped by this script`)
  process.exit(2)
}

const url = new URL(process.env.DATABASE_URL ?? "")
url.searchParams.delete("schema")

;(async () => {
  const c = new Client({ connectionString: url.toString() })
  await c.connect()
  await c.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`)
  const left = await c.query<{ schema_name: string }>(
    "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'scratch\\_%' ORDER BY 1",
  )
  await c.end()
  console.log(`  dropped ${name}. scratch schemas left: ${left.rows.map((r) => r.schema_name).join(", ") || "none"}`)
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
