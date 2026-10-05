// Prints "yes" or "no": does this scratch schema exist? Called by
// scripts/scratch.ps1 -Dev, so a server is never started on a schema nobody
// pushed. Read-only: one catalog lookup in a read-only session.
//
//   npx tsx --env-file=.env scripts/scratch-schema-exists.ts scratch_x
//
// Refuses anything not named scratch_*, like drop-scratch-schema.ts.
import { Client } from "pg"

const name = process.argv[2] ?? ""
if (!/^scratch_[a-z0-9_]+$/.test(name)) {
  console.error(`refusing "${name}": only scratch_[a-z0-9_]+ schemas are checked by this script`)
  process.exit(2)
}

const url = new URL(process.env.DATABASE_URL ?? "")
url.searchParams.delete("schema")

;(async () => {
  const c = new Client({ connectionString: url.toString() })
  await c.connect()
  try {
    await c.query("BEGIN TRANSACTION READ ONLY")
    const r = await c.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [name])
    await c.query("ROLLBACK")
    console.log(r.rowCount ? "yes" : "no")
  } finally {
    await c.end()
  }
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
