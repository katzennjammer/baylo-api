// Build the schema-v2 rehearsal on a SCRATCH copy of a backup.
//
//   npx tsx --env-file=.env scripts/schema-v2/build-scratch.ts <backup.sql> [--schema schema_v2_wk1] [--replace] [--skip <part>]
//
// Creates two schemas beside `public` on the same server, and never writes
// to `public`:
//
//   <schema>_src   the backup, restored into the CURRENT (pre-v2) structure and
//                  left exactly so. It is the "old" side of every comparison
//                  verify-v2.ts makes, and stays for week 2.
//   <schema>       the same restore, then the schema-v2 migrations applied in
//                  order -- the shape week 2 builds against.
//
// HOW IT STAYS OFF LIVE: through scripts/lib/migration-runner.ts, like every
// script that runs migration SQL. Each schema is built in ONE guarded
// transaction: search_path pinned at session level and re-checked around
// every batch, transaction control inside a migration stripped or refused,
// and a backstop that rolls everything back if `public` was touched at all.
// Schema names are refused unless they start `schema_v2_`.
//
// --skip ledger|trade leaves a high-risk part out, to rehearse a go/no-go in
// which it is held back.
import { Client, types } from "pg"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { V2_MIGRATIONS, loadMigration, prepareBatch, preV2Chain, withGuardedTransaction, type MigrationFile } from "../lib/migration-runner"

for (const oid of [1082, 1114, 1083, 1184]) types.setTypeParser(oid, (v) => v)
types.setTypeParser(20, (v) => v)
types.setTypeParser(1700, (v) => v)

// Which held-back part each v2 migration needs. --skip <part> skips the part
// and everything that depends on it.
const PART: Record<string, string> = {
  "20261003000001_schema_v2_ledger": "ledger",
  "20261003000002_schema_v2_trade": "trade",
  "20261004000001_schema_v2_trade_completed_backfill": "trade",
  "20261004000002_schema_v2_drop_trade_hidden": "trade",
}
const TRAILER = "-- Baylo data dump complete"

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}

const backup = process.argv[2]
const schema = arg("--schema") ?? "schema_v2_wk1"
const replace = process.argv.includes("--replace")
const skip = new Set(process.argv.flatMap((a, i) => (process.argv[i - 1] === "--skip" ? [a] : [])))

if (!backup || !existsSync(backup)) { console.error("usage: build-scratch.ts <backup.sql> [--schema schema_v2_x] [--replace]"); process.exit(2) }
if (!/^schema_v2_[a-z0-9_]+$/.test(schema)) { console.error(`refusing schema name "${schema}": must match schema_v2_[a-z0-9_]+`); process.exit(2) }
const SRC = `${schema}_src`

function dbUrl(): URL {
  const u = process.env.DATABASE_URL
  if (!u?.startsWith("postgres")) { console.error("DATABASE_URL is not a Postgres URL"); process.exit(2) }
  const url = new URL(u)
  url.searchParams.delete("schema") // search_path is pinned by the runner
  return url
}

async function main() {
  const dumpSql = await readFile(backup, "utf8")
  if (!dumpSql.includes(TRAILER)) { console.error("backup has no trailer; it is truncated"); process.exit(1) }
  const dump = prepareBatch(backup, "data", dumpSql)
  const chain = await preV2Chain()
  console.log(`  pre-v2 chain: ${chain.length} migrations`)

  const v2: MigrationFile[] = []
  for (const m of V2_MIGRATIONS) {
    if (PART[m] && skip.has(PART[m])) { console.log(`  SKIPPED ${m}`); continue }
    // A phase not yet landed keeps its migration in prisma/schema-v2-pending/.
    // Only what is in prisma/migrations/ is applied.
    if (!existsSync(new URL(`../../prisma/migrations/${m}/migration.sql`, import.meta.url))) {
      console.log(`  not yet in prisma/migrations (pending phase): ${m}`); continue
    }
    v2.push(await loadMigration(m))
  }

  const u = dbUrl()
  console.log(`  target  host=${u.hostname}:${u.port || 5432}  database=${u.pathname.slice(1)}  schemas=${SRC}, ${schema}`)
  const pg = new Client({ connectionString: u.toString() })
  await pg.connect()
  try {
    for (const s of [SRC, schema]) {
      await withGuardedTransaction(pg, { target: s, create: replace ? "replace" : "fresh" }, async (g) => {
        for (const m of chain) await g.run(m.batch)
        await g.run(dump)
        if (s === schema) {
          for (const m of v2) {
            const t0 = Date.now()
            await g.run(m.batch)
            console.log(`  applied ${m.name} (${Date.now() - t0} ms)`)
          }
        }
        const n = (await g.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = $1`, [s])).rows[0].n
        console.log(`  "${s}": ${s === SRC ? "pre-v2 structure" : "after v2"}, ${n} tables, backup restored`)
      })
    }
  } finally {
    await pg.end()
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
