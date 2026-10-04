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
//   <schema>       the same restore, then the three schema-v2 migrations
//                  applied in order -- the shape week 2 builds against.
//
// HOW IT STAYS OFF LIVE. Every statement this runs is unqualified and goes
// through `SET search_path TO "<schema>"`, the same mechanism pg-backup.ts
// drill uses: the pre-v2 migration chain, the data dump and the three v2
// migrations are all written without a schema prefix. The v2 migrations were
// written to that rule on purpose (no `public.`, no catalog lookup by name).
// The only catalog-by-name checks in the OLD chain are scoped to
// current_schema() exactly as the drill scopes them, and anything unscoped
// stops the build. Schema names are refused unless they start `schema_v2_`.
//
// --skip ledger|trade leaves a high-risk part out, to rehearse a go/no-go in
// which it is held back.
import { Client, types } from "pg"
import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"

for (const oid of [1082, 1114, 1083, 1184]) types.setTypeParser(oid, (v) => v)
types.setTypeParser(20, (v) => v)
types.setTypeParser(1700, (v) => v)

const V2 = ["20261003000000_schema_v2_core", "20261003000001_schema_v2_ledger", "20261003000002_schema_v2_trade", "20261004000000_schema_v2_audit_fixes"]
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

function dbUrl(): string {
  const u = process.env.DATABASE_URL
  if (!u?.startsWith("postgres")) { console.error("DATABASE_URL is not a Postgres URL"); process.exit(2) }
  // The connection's own schema parameter is irrelevant: search_path is set explicitly below.
  return u.replace(/([?&])schema=[^&]*&?/, "$1").replace(/[?&]$/, "")
}

// Same rule as pg-backup.ts drill: scope the OLD chain's catalog-by-name checks
// to the schema being built, and stop on any lookup this does not recognise.
function scopeCatalogChecks(ddl: string): string {
  const scoped = ddl
    .replace(/(FROM\s+pg_type\s+WHERE\s+typname\s*=\s*'[^']+')/gi, "$1 AND typnamespace = current_schema()::regnamespace")
    .replace(/(FROM\s+pg_constraint\s+WHERE\s+conname\s*=\s*'[^']+')/gi, "$1 AND connamespace = current_schema()::regnamespace")
    .replace(/(FROM\s+information_schema\.table_constraints\s+WHERE\s+constraint_name\s*=\s*'[^']+')/gi, "$1 AND constraint_schema = current_schema()")
  const lookups = scoped.match(/FROM\s+(pg_type|pg_constraint|pg_class|pg_enum|pg_namespace|information_schema\.\w+)\b[^;]*/gi) ?? []
  const unscoped = lookups.filter((l) => !/current_schema\(\)/.test(l))
  if (unscoped.length) {
    for (const l of unscoped) console.error(`  unscoped catalog lookup: ${l.replace(/\s+/g, " ").slice(0, 140)}`)
    process.exit(1)
  }
  return scoped
}

async function oldChainDdl(): Promise<string> {
  const dir = new URL("../../prisma/migrations/", import.meta.url)
  const dirs = (await readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && !V2.includes(d.name)).map((d) => d.name).sort()
  let ddl = ""
  for (const d of dirs) {
    const body = await readFile(new URL(`${d}/migration.sql`, dir), "utf8")
    ddl += body.replace(/^\s*CREATE SCHEMA IF NOT EXISTS "public";\s*$/gim, "") + "\n"
  }
  console.log(`  pre-v2 chain: ${dirs.length} migrations`)
  return scopeCatalogChecks(ddl)
}

async function v2Sql(name: string): Promise<string> {
  const sql = await readFile(new URL(`../../prisma/migrations/${name}/migration.sql`, import.meta.url), "utf8")
  const code = sql.replace(/--.*$/gm, "") // comments may say "public."; statements may not
  if (/\bpublic\s*\./i.test(code) || /search_path/i.test(code)) { console.error(`${name} names the public schema; refusing`); process.exit(1) }
  return sql
}

async function main() {
  const dump = await readFile(backup, "utf8")
  if (!dump.includes(TRAILER)) { console.error("backup has no trailer; it is truncated"); process.exit(1) }
  const ddl = await oldChainDdl()

  const pg = new Client({ connectionString: dbUrl() })
  await pg.connect()
  try {
    for (const s of [SRC, schema]) {
      const exists = (await pg.query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [s])).rowCount
      if (exists && !replace) { console.error(`schema "${s}" exists; pass --replace to rebuild it`); process.exit(1) }
      if (exists) { await pg.query(`DROP SCHEMA "${s}" CASCADE`); console.log(`  dropped "${s}"`) }
    }

    for (const s of [SRC, schema]) {
      await pg.query(`CREATE SCHEMA "${s}"`)
      await pg.query(`SET search_path TO "${s}"`)
      await pg.query(ddl)
      await pg.query(dump)
      const n = (await pg.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = $1`, [s])).rows[0].n
      console.log(`  "${s}": pre-v2 structure, ${n} tables, backup restored`)
    }

    await pg.query(`SET search_path TO "${schema}"`)
    for (const m of V2) {
      if ((m.endsWith("_ledger") && skip.has("ledger")) || (m.endsWith("_trade") && skip.has("trade"))) {
        console.log(`  SKIPPED ${m}`); continue
      }
      // A phase not yet landed keeps its migration in prisma/schema-v2-pending/
      // (see the README there). Only what is in prisma/migrations/ is applied,
      // so the copy always matches schema.prisma on this commit.
      if (!existsSync(new URL(`../../prisma/migrations/${m}/migration.sql`, import.meta.url))) {
        console.log(`  not yet in prisma/migrations (pending phase): ${m}`); continue
      }
      const t0 = Date.now()
      // One query string = one implicit transaction, as `migrate deploy` runs it.
      await pg.query(await v2Sql(m))
      console.log(`  applied ${m} (${Date.now() - t0} ms)`)
    }
    const n = (await pg.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = $1`, [schema])).rows[0].n
    console.log(`  "${schema}": ${n} tables after v2`)

    // Nothing above may have reached public. A cheap tripwire, not a proof.
    const pub = (await pg.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('Trade','AuthToken','ItemImage','UserProgress','ModerationCase')`)).rows[0].n
    if (pub) { console.error(`  !! public has ${pub} v2 tables -- investigate immediately`); process.exitCode = 1 }
  } finally {
    await pg.end()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
