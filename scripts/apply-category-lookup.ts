// THE tool for the Category lookup table (8 Oct 2026): rehearse it on a
// scratch copy of a backup, apply it, and reverse it, each as ONE guarded
// transaction through scripts/lib/migration-runner.ts.
//
//   npx tsx --env-file=.env scripts/apply-category-lookup.ts build-scratch <backup.sql> --target scratch_category [--replace]
//   npx tsx --env-file=.env scripts/apply-category-lookup.ts counts  --target <schema>
//   npx tsx --env-file=.env scripts/apply-category-lookup.ts forward --target <schema> [--backup <file>] [--confirm-live-migrate]
//   npx tsx --env-file=.env scripts/apply-category-lookup.ts reverse --target <schema> [--confirm-live-rollback]
//
// --target IS REQUIRED and has no default, so forgetting it can never mean
// live. It is `public` (LIVE) or a scratch_* schema. DATABASE_URL must not
// carry ?schema=.
//
//   build-scratch  Builds <target> from the backup's OWN migration chain (the
//                  names in its header, as `pg-backup.ts drill` does), loads
//                  its rows, and records the chain in a _prisma_migrations
//                  table there, so the copy is live as of the backup, and
//                  `prisma migrate status` / `migrate diff` work against it.
//   counts         Read-only: rows per table, rows per category on Item and
//                  ItemWantedCategory, the Leaves ledger, and whether the
//                  migration is recorded.
//   forward        prisma/migrations/20261008000000_category_lookup_table.
//   reverse        prisma/rollback/20261008000000_category_lookup_table.sql.
//
// INSIDE THE ONE TRANSACTION (forward and reverse): Prisma's migrate advisory
// lock; Item and ItemWantedCategory locked NOWAIT (an app mid-request makes it
// refuse, not wait); counts taken; the SQL run; the _prisma_migrations row
// written (forward) or deleted (reverse) exactly as `prisma migrate deploy`
// writes it; then, BEFORE COMMIT: every other table's count unchanged, the
// table count +1 / -1, Category = 20 rows (forward), each category's count on
// Item and ItemWantedCategory unchanged, and the ledger holding with the same
// figures. Any difference throws and the whole thing rolls back.
//
// LIVE (`--target public`) additionally needs, before anything is opened for
// writing: BAYLO_CUTOVER_LIVE=1 in this shell; for forward, `--backup` naming
// a verified dump whose per-table counts equal live's right now (nothing
// written since); no app connection open; and confirmLiveWrite(): the
// `--confirm-live-migrate` / `--confirm-live-rollback` flag, an interactive
// terminal, and the phrase typed back with its one-time code.
import { Client, types } from "pg"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { LEDGER_INVARIANT_SQL, figuresFromRow, judge, type LedgerJudgement } from "./lib/ledger-invariant"
import {
  GuardError, PRISMA_MIGRATE_LOCK_KEY, confirmLiveWrite, isLiveTarget, isScratchTarget, liveLabel, loadMigration, localMigrationNames,
  prepareBatch, refusePublicUnderStandIn, withGuardedTransaction, type Guarded, type LivePurpose, type LiveWriteAuthorization,
} from "./lib/migration-runner"

for (const oid of [1082, 1114, 1083, 1184]) types.setTypeParser(oid, (v) => v)
types.setTypeParser(20, (v) => v)
types.setTypeParser(1700, (v) => v)

export const MIGRATION = "20261008000000_category_lookup_table"
const ROLLBACK_FILE = new URL(`../prisma/rollback/${MIGRATION}.sql`, import.meta.url)
const TRAILER = "-- Baylo data dump complete"
const CATEGORY_ROWS = 20

const argv = process.argv.slice(2)
const cmd = argv[0]
const opt = (n: string) => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1] }
function die(msg: string): never { console.error(`\n  REFUSING: ${msg}\n`); process.exit(1) }

function targetArg(): string {
  const t = opt("--target")
  if (!t) die("--target is required (public, or a scratch_* schema)")
  try { refusePublicUnderStandIn(t) } catch (e) { die((e as Error).message) }
  if (t !== "public" && !(isScratchTarget(t) && t.startsWith("scratch_"))) die(`--target must be public or a scratch_* schema (got "${t}")`)
  return t
}
function url(): URL {
  const raw = process.env.DATABASE_URL
  if (!raw?.startsWith("postgres")) die("DATABASE_URL is not a Postgres URL")
  const u = new URL(raw)
  if (u.searchParams.get("schema")) die("DATABASE_URL must not carry ?schema=; the schema is --target")
  return u
}
function printTarget(target: string, mode: string) {
  const u = url()
  console.log(`  target  host=${u.hostname}:${u.port || 5432}  database=${u.pathname.slice(1)}  schema=${target} (${isLiveTarget(target) ? liveLabel(target) : "scratch"})  mode=${mode}`)
}
async function connect(readOnly: boolean): Promise<Client> {
  const c = new Client({ connectionString: url().toString() })
  await c.connect()
  if (readOnly) {
    await c.query(`SET SESSION default_transaction_read_only = on`)
    if ((await c.query(`SHOW transaction_read_only`)).rows[0].transaction_read_only !== "on") die("could not make the session read-only")
  }
  return c
}

type Q = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
const qi = (schema: string, t: string) => `"${schema}"."${t}"`

interface Facts {
  tables: Record<string, number>
  /** "Item:ELECTRONICS" -> rows, "Wanted:ELECTRONICS" -> rows. Read from whichever column exists. */
  perCategory: Record<string, number>
  hasCategoryTable: boolean
  /** An ENUM named Category (the table's own row type is also called "Category", typtype 'c'). */
  categoryEnum: boolean
  recorded: boolean
  ledger: LedgerJudgement
}

async function facts(q: Q, schema: string): Promise<Facts> {
  const names = (await q(`SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename <> '_prisma_migrations' ORDER BY 1`, [schema])).rows.map((r) => String(r.tablename))
  const tables: Record<string, number> = {}
  for (const t of names) tables[t] = Number((await q(`SELECT count(*) AS n FROM ${qi(schema, t)}`)).rows[0].n)
  const col = async (t: string) => {
    const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name IN ('category', 'categoryId')`, [schema, t])).rows.map((r) => String(r.column_name))
    if (cols.length !== 1) throw new GuardError(`${t} has category columns [${cols.join(", ")}]; expected exactly one`)
    return cols[0]
  }
  const perCategory: Record<string, number> = {}
  for (const [t, key] of [["Item", "Item"], ["ItemWantedCategory", "Wanted"]] as const) {
    const c = await col(t)
    for (const r of (await q(`SELECT "${c}"::text AS c, count(*) AS n FROM ${qi(schema, t)} GROUP BY 1`)).rows) perCategory[`${key}:${r.c}`] = Number(r.n)
  }
  const categoryEnum = Boolean((await q(`SELECT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = 'Category' AND t.typtype = 'e') AS ok`, [schema])).rows[0].ok)
  const hasMig = Boolean((await q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [qi(schema, "_prisma_migrations")])).rows[0].ok)
  const recorded = hasMig && Number((await q(`SELECT count(*) AS n FROM ${qi(schema, "_prisma_migrations")} WHERE migration_name = $1 AND rolled_back_at IS NULL`, [MIGRATION])).rows[0].n) > 0
  const ledger = judge(figuresFromRow((await q(LEDGER_INVARIANT_SQL(schema, "v2"))).rows[0] as Record<string, string>))
  return { tables, perCategory, hasCategoryTable: "Category" in tables, categoryEnum, recorded, ledger }
}

function printFacts(label: string, f: Facts) {
  const total = Object.values(f.tables).reduce((a, b) => a + b, 0)
  console.log(`\n  ── ${label}: ${Object.keys(f.tables).length} tables, ${total} rows; Category table ${f.hasCategoryTable ? "yes" : "no"}, enum ${f.categoryEnum ? "yes" : "no"}, migration recorded ${f.recorded ? "yes" : "no"}`)
  console.log(`  ${Object.entries(f.tables).map(([t, n]) => `${t}=${n}`).join(" ")}`)
  const cats = [...new Set(Object.keys(f.perCategory).map((k) => k.split(":")[1]))].sort()
  console.log(`  per category (Item / ItemWantedCategory): ${cats.map((c) => `${c} ${f.perCategory[`Item:${c}`] ?? 0}/${f.perCategory[`Wanted:${c}`] ?? 0}`).join(", ") || "(none)"}`)
  console.log(`  ledger: ${f.ledger.lines.join("; ")}`)
}

/** Everything that must be identical before and after, apart from the Category table itself. */
function compare(before: Facts, after: Facts, expectCategoryTable: boolean): string[] {
  const why: string[] = []
  const others = (f: Facts) => Object.keys(f.tables).filter((t) => t !== "Category").sort()
  if (JSON.stringify(others(before)) !== JSON.stringify(others(after))) why.push(`table set changed: ${others(before).join(",")} -> ${others(after).join(",")}`)
  for (const t of others(before)) if (before.tables[t] !== after.tables[t]) why.push(`${t} ${before.tables[t]} -> ${after.tables[t]}`)
  if (after.hasCategoryTable !== expectCategoryTable) why.push(`Category table ${expectCategoryTable ? "missing" : "still there"}`)
  if (expectCategoryTable && after.tables.Category !== CATEGORY_ROWS) why.push(`Category has ${after.tables.Category} rows, expected ${CATEGORY_ROWS}`)
  if (after.categoryEnum === expectCategoryTable) why.push(`enum Category ${expectCategoryTable ? "still exists" : "missing"}`)
  const keys = [...new Set([...Object.keys(before.perCategory), ...Object.keys(after.perCategory)])].sort()
  for (const k of keys) if ((before.perCategory[k] ?? 0) !== (after.perCategory[k] ?? 0)) why.push(`${k} ${before.perCategory[k] ?? 0} -> ${after.perCategory[k] ?? 0}`)
  const fig = (l: LedgerJudgement) => JSON.stringify([l.userLeaves, l.ledger, l.escrow, l.issuance])
  if (!after.ledger.ok) why.push(`ledger broken: ${after.ledger.lines.join("; ")}`)
  if (fig(before.ledger) !== fig(after.ledger)) why.push("ledger figures changed")
  return why
}

function readBackup(file: string) {
  if (!file || !existsSync(file)) die(`no such backup: ${file}`)
  const sql = readFileSync(file, "utf8")
  if (!sql.includes(TRAILER)) die("the backup has no trailer; it is truncated")
  const claimed = Object.fromEntries((/-- rowcounts: (.*)/.exec(sql)?.[1] ?? "").split(/\s+/).filter(Boolean).map((p) => { const [t, n] = p.split("="); return [t, Number(n)] }))
  const migrations = (/^-- migrations\s+(.*)$/m.exec(sql)?.[1] ?? "").split(",").map((s) => s.trim()).filter((s) => s && s !== "(none recorded)")
  return { sql, claimed: claimed as Record<string, number>, migrations }
}

/** Live only: refuse while an app server holds a connection (same filter as cutover-live.ts). */
async function appConnections(pg: Client) {
  return (await pg.query(`SELECT pid, application_name, state FROM pg_stat_activity
     WHERE datname = current_database() AND usename = 'postgres' AND pid <> pg_backend_pid() AND application_name NOT LIKE 'pg_net%'`)).rows
}

// ── build-scratch ───────────────────────────────────────────────────────────

const PRISMA_MIGRATIONS_DDL = `CREATE TABLE "_prisma_migrations" (
    "id" VARCHAR(36) PRIMARY KEY NOT NULL,
    "checksum" VARCHAR(64) NOT NULL,
    "finished_at" TIMESTAMPTZ,
    "migration_name" VARCHAR(255) NOT NULL,
    "logs" TEXT,
    "rolled_back_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count" INTEGER NOT NULL DEFAULT 0
)`

async function buildScratch() {
  const file = argv[1]
  const target = targetArg()
  if (isLiveTarget(target)) die("build-scratch never targets live")
  const { sql, claimed, migrations } = readBackup(file)
  const local = new Set(await localMigrationNames())
  const missing = migrations.filter((m) => !local.has(m))
  if (!migrations.length || missing.length) die(`the backup's migrations are not all in this repo: ${missing.join(", ") || "(none listed)"}`)
  if (migrations.includes(MIGRATION)) die(`the backup was taken AFTER ${MIGRATION}; rehearse from a backup taken before it`)
  const chain = await Promise.all(migrations.map(loadMigration))
  const data = prepareBatch(file, "data", sql)

  printTarget(target, `BUILD from ${file}`)
  const pg = await connect(false)
  try {
    await withGuardedTransaction(pg, { target, create: argv.includes("--replace") ? "replace" : "fresh" }, async (g) => {
      for (const m of chain) await g.run(m.batch)
      await g.run(data)
      await g.query(PRISMA_MIGRATIONS_DDL)
      for (const m of chain) {
        await g.query(`INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
           VALUES ($1, $2, clock_timestamp(), $3, NULL, NULL, clock_timestamp(), 1)`, [randomUUID(), m.checksum, m.name])
      }
      const f = await facts((s, p) => g.query(s, p), target)
      const off = Object.keys(claimed).filter((t) => f.tables[t] !== claimed[t])
      if (off.length || Object.keys(f.tables).length !== Object.keys(claimed).length) throw new GuardError(`restored counts differ from the backup: ${off.map((t) => `${t} file ${claimed[t]} got ${f.tables[t]}`).join(", ") || "table set differs"}`)
      if (!f.ledger.ok) throw new GuardError(`ledger broken in the copy: ${f.ledger.lines.join("; ")}`)
      console.log(`  built "${target}": ${chain.length} migrations recorded, ${Object.keys(f.tables).length} tables equal the backup's trailer`)
      printFacts("COPY (= backup)", f)
    })
    console.log(`\n  BUILT ${target}`)
  } finally { await pg.end() }
}

// ── counts ──────────────────────────────────────────────────────────────────

async function counts() {
  const target = targetArg()
  printTarget(target, "READ-ONLY")
  const pg = await connect(true)
  try {
    await pg.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
    printFacts(target, await facts((s, p) => pg.query(s, p), target))
    await pg.query("ROLLBACK")
  } finally { await pg.end() }
}

// ── forward / reverse ───────────────────────────────────────────────────────

async function apply(direction: "forward" | "reverse") {
  const target = targetArg()
  const purpose: LivePurpose = direction === "forward" ? "migrate" : "rollback"
  const batch = direction === "forward"
    ? (await loadMigration(MIGRATION)).batch
    : prepareBatch(`rollback/${MIGRATION}`, "migration", await readFile(ROLLBACK_FILE, "utf8"))
  const checksum = (await loadMigration(MIGRATION)).checksum
  printTarget(target, direction.toUpperCase())

  let live: LiveWriteAuthorization | undefined
  if (isLiveTarget(target)) {
    if (process.env.BAYLO_CUTOVER_LIVE !== "1") die("BAYLO_CUTOVER_LIVE=1 is not set in this shell")
    // Read-only preconditions first: nothing is opened for writing until they pass.
    const ro = await connect(true)
    try {
      const f = await facts((s, p) => ro.query(s, p), target)
      if (direction === "forward") {
        const { claimed } = readBackup(opt("--backup") ?? "")
        const drift = Object.keys(claimed).filter((t) => f.tables[t] !== claimed[t])
        if (drift.length || Object.keys(claimed).length !== Object.keys(f.tables).length) die(`live differs from the backup (take a new one): ${drift.map((t) => `${t} ${claimed[t]}->${f.tables[t]}`).join(", ") || "table set differs"}`)
        console.log(`  backup matches live: ${Object.keys(claimed).length} tables equal`)
      }
      const apps = await appConnections(ro)
      if (apps.length) die(`${apps.length} app connection(s) open (stop the dev server gracefully first): ${apps.map((a) => `${a.pid} ${a.application_name || "-"} ${a.state}`).join("; ")}`)
    } finally { await ro.end() }
    try { live = await confirmLiveWrite(purpose, url().hostname, target) } catch (e) { die((e as Error).message) }
  }

  const pg = await connect(false)
  const t0 = Date.now()
  try {
    await withGuardedTransaction(pg, { target, live, purpose: live ? purpose : undefined, lockTimeout: "5s" }, async (g: Guarded) => {
      const q: Q = (s, p) => g.query(s, p)
      await g.query(`SELECT pg_advisory_xact_lock($1)`, [PRISMA_MIGRATE_LOCK_KEY])
      if (!(await g.query(`SELECT to_regclass('"_prisma_migrations"') IS NOT NULL AS ok`)).rows[0].ok) throw new GuardError(`no _prisma_migrations in "${target}"`)
      await g.query(`LOCK TABLE "Item", "ItemWantedCategory" IN ACCESS EXCLUSIVE MODE NOWAIT`)
      const before = await facts(q, target)
      printFacts("BEFORE", before)
      if (direction === "forward" && (before.recorded || before.hasCategoryTable || !before.categoryEnum)) throw new GuardError("already applied (recorded, Category table present, or enum gone)")
      if (direction === "reverse" && (!before.recorded || !before.hasCategoryTable || before.categoryEnum)) throw new GuardError("nothing to reverse (not recorded, no Category table, or enum present)")

      const started = (await g.query(`SELECT clock_timestamp() AS t`)).rows[0].t
      await g.run(batch)
      if (direction === "forward") {
        await g.query(`INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
           VALUES ($1, $2, clock_timestamp(), $3, NULL, NULL, $4, 1)`, [randomUUID(), checksum, MIGRATION, started])
      } else {
        const del = await g.query(`DELETE FROM "_prisma_migrations" WHERE migration_name = $1`, [MIGRATION])
        if (del.rowCount !== 1) throw new GuardError(`expected to delete 1 _prisma_migrations row, deleted ${del.rowCount}`)
      }

      const after = await facts(q, target)
      printFacts("AFTER (inside the transaction)", after)
      const why = compare(before, after, direction === "forward")
      if (after.recorded !== (direction === "forward")) why.push(`_prisma_migrations row ${direction === "forward" ? "missing" : "still there"}`)
      const want = Object.keys(before.tables).length + (direction === "forward" ? 1 : -1)
      if (Object.keys(after.tables).length !== want) why.push(`expected ${want} tables, found ${Object.keys(after.tables).length}`)
      if (why.length) throw new GuardError(`post-checks failed: ${why.join("; ")}`)
      console.log(`\n  post-checks passed: every other table unchanged, per-category counts unchanged, ${want} tables, ledger as before`)
    })
    console.log(`\n  ${direction.toUpperCase()} COMMITTED on ${target} in ${Date.now() - t0} ms (one transaction)`)
  } catch (e) {
    console.error(`\n  ${direction.toUpperCase()} ROLLED BACK after ${Date.now() - t0} ms; ${target} is exactly as it was: ${(e as Error).message}`)
    process.exitCode = 1
  } finally {
    await pg.end().catch(() => {})
  }
}

const run =
  cmd === "build-scratch" ? buildScratch()
  : cmd === "counts" ? counts()
  : cmd === "forward" ? apply("forward")
  : cmd === "reverse" ? apply("reverse")
  : die("usage: apply-category-lookup.ts build-scratch <backup> --target scratch_x [--replace] | counts --target <s> | forward --target <s> [--backup <file>] [--confirm-live-migrate] | reverse --target <s> [--confirm-live-rollback]")
run.catch((e) => { console.error(`\n  FAILED: ${(e as Error).message}\n`); process.exit(1) })
