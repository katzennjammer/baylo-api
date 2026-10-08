// THE tool for the display view "ItemWantedCategorySummary" (8 Oct 2026):
// apply it, verify it, and reverse it, each through scripts/lib/migration-runner.ts.
// The same path as scripts/apply-category-lookup.ts, kept separate so that
// script (already run on live) never changes.
//
//   npx tsx --env-file=.env scripts/apply-wanted-summary-view.ts forward --target <schema> [--backup <file>] [--confirm-live-migrate]
//   npx tsx --env-file=.env scripts/apply-wanted-summary-view.ts reverse --target <schema> [--confirm-live-rollback]
//   npx tsx --env-file=.env scripts/apply-wanted-summary-view.ts verify  --target <schema>     (READ-ONLY)
//
// --target IS REQUIRED: `public` (LIVE) or a scratch_* schema. DATABASE_URL
// must not carry ?schema=.
//
// forward / reverse, ONE guarded transaction: Prisma's migrate lock; the SQL;
// the _prisma_migrations row written (forward) or deleted (reverse); then,
// BEFORE COMMIT: the table set and every table's row count unchanged, the
// Leaves ledger unchanged, and the view present (forward) / absent (reverse).
// Forward also requires: security_invoker on; no privilege for anon or
// authenticated; and every view row equal to the same aggregate computed
// directly from the tables (title, owner, labels and codes in sortOrder,
// count), with one row per listing that has wanted categories.
//
// verify (read-only): the same view checks, the API-role exposure line used
// for the tables (exposure() counts views too), and a real attempt to read
// the view as anon and as authenticated (SET LOCAL ROLE inside a READ ONLY
// transaction, rolled back), which must be refused.
//
// LIVE (`--target public`): BAYLO_CUTOVER_LIVE=1; for forward, `--backup`
// naming a verified dump whose per-table counts equal live's now; no app
// connection open; confirmLiveWrite() (the flag, an interactive terminal and
// the typed phrase with its one-time code).
import { Client, types } from "pg"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { LEDGER_INVARIANT_SQL, figuresFromRow, judge, type LedgerJudgement } from "./lib/ledger-invariant"
import { describe, exposure } from "./lib/api-role-lockdown"
import {
  GuardError, PRISMA_MIGRATE_LOCK_KEY, confirmLiveWrite, isLiveTarget, isScratchTarget, liveLabel, loadMigration,
  prepareBatch, refusePublicUnderStandIn, withGuardedTransaction, type Guarded, type LivePurpose, type LiveWriteAuthorization,
} from "./lib/migration-runner"

for (const oid of [1082, 1114, 1083, 1184]) types.setTypeParser(oid, (v) => v)
types.setTypeParser(20, (v) => v)
types.setTypeParser(1700, (v) => v)

export const MIGRATION = "20261008100000_item_wanted_category_summary_view"
export const VIEW = "ItemWantedCategorySummary"
const ROLLBACK_FILE = new URL(`../prisma/rollback/${MIGRATION}.sql`, import.meta.url)
const TRAILER = "-- Baylo data dump complete"
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]

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

interface ViewFacts {
  rows: number; pairs: number
  /** What the view must equal: listings with wanted categories, and wanted rows. */
  wantRows: number; wantPairs: number
  /** View rows that differ from the aggregate computed straight from the tables. */
  mismatched: number
  securityInvoker: boolean
  /** "anon:SELECT", ... for every privilege anon/authenticated hold on the view. */
  apiPrivileges: string[]
}
interface Facts {
  tables: Record<string, number>
  view: ViewFacts | null
  recorded: boolean
  ledger: LedgerJudgement
}

async function viewFacts(q: Q, schema: string): Promise<ViewFacts | null> {
  const rel = (await q(`SELECT c.oid, c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'v'`, [schema, VIEW])).rows[0]
  if (!rel) return null
  const v = qi(schema, VIEW), s = (t: string) => qi(schema, t)
  const one = async (sql: string) => Number(Object.values((await q(sql)).rows[0])[0])
  const direct = `
    SELECT i."id" AS "itemId", i."title", i."userId",
           string_agg(c."label", ', ' ORDER BY c."sortOrder") AS "wantedCategories",
           array_agg(c."id" ORDER BY c."sortOrder") AS "wantedCategoryIds",
           count(*)::int AS "wantedCount"
      FROM ${s("Item")} i JOIN ${s("ItemWantedCategory")} w ON w."itemId" = i."id" JOIN ${s("Category")} c ON c."id" = w."categoryId"
     GROUP BY i."id", i."title", i."userId"`
  const mismatched = await one(`SELECT count(*) FROM ((SELECT * FROM ${v} EXCEPT ALL SELECT * FROM (${direct}) d) UNION ALL (SELECT * FROM (${direct}) d EXCEPT ALL SELECT * FROM ${v})) x`)
  const apiPrivileges: string[] = []
  for (const role of ["anon", "authenticated"]) {
    if (!(await q(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role])).rows.length) continue
    for (const p of PRIVILEGES) {
      if ((await q(`SELECT has_table_privilege($1, $2::oid, $3) AS ok`, [role, rel.oid, p])).rows[0].ok) apiPrivileges.push(`${role}:${p}`)
    }
  }
  return {
    rows: await one(`SELECT count(*) FROM ${v}`),
    pairs: await one(`SELECT coalesce(sum("wantedCount"), 0) FROM ${v}`),
    wantRows: await one(`SELECT count(DISTINCT "itemId") FROM ${s("ItemWantedCategory")}`),
    wantPairs: await one(`SELECT count(*) FROM ${s("ItemWantedCategory")}`),
    mismatched,
    securityInvoker: ((rel.reloptions as string[] | null) ?? []).includes("security_invoker=true"),
    apiPrivileges,
  }
}

async function facts(q: Q, schema: string): Promise<Facts> {
  const names = (await q(`SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename <> '_prisma_migrations' ORDER BY 1`, [schema])).rows.map((r) => String(r.tablename))
  const tables: Record<string, number> = {}
  for (const t of names) tables[t] = Number((await q(`SELECT count(*) AS n FROM ${qi(schema, t)}`)).rows[0].n)
  const hasMig = Boolean((await q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [qi(schema, "_prisma_migrations")])).rows[0].ok)
  const recorded = hasMig && Number((await q(`SELECT count(*) AS n FROM ${qi(schema, "_prisma_migrations")} WHERE migration_name = $1 AND rolled_back_at IS NULL`, [MIGRATION])).rows[0].n) > 0
  const ledger = judge(figuresFromRow((await q(LEDGER_INVARIANT_SQL(schema, "v2"))).rows[0] as Record<string, string>))
  return { tables, view: await viewFacts(q, schema), recorded, ledger }
}

function printFacts(label: string, f: Facts) {
  const total = Object.values(f.tables).reduce((a, b) => a + b, 0)
  console.log(`\n  ── ${label}: ${Object.keys(f.tables).length} tables, ${total} rows; view ${f.view ? "present" : "absent"}; migration recorded ${f.recorded ? "yes" : "no"}`)
  console.log(`  ${Object.entries(f.tables).map(([t, n]) => `${t}=${n}`).join(" ")}`)
  if (f.view) {
    const v = f.view
    console.log(`  view: ${v.rows} rows (listings with wanted categories: ${v.wantRows}), ${v.pairs} pairs (ItemWantedCategory rows: ${v.wantPairs}), ` +
      `${v.mismatched} row(s) differing from the direct aggregate, security_invoker ${v.securityInvoker ? "on" : "OFF"}, ` +
      `anon/authenticated privileges: ${v.apiPrivileges.length ? v.apiPrivileges.join(", ") : "none"}`)
  }
  console.log(`  ledger: ${f.ledger.lines.join("; ")}`)
}

function viewProblems(v: ViewFacts | null): string[] {
  if (!v) return ["the view is missing"]
  const why: string[] = []
  if (v.rows !== v.wantRows) why.push(`view has ${v.rows} rows, expected ${v.wantRows}`)
  if (v.pairs !== v.wantPairs) why.push(`view counts ${v.pairs} pairs, expected ${v.wantPairs}`)
  if (v.mismatched) why.push(`${v.mismatched} view row(s) differ from the direct aggregate`)
  if (!v.securityInvoker) why.push("security_invoker is not on")
  if (v.apiPrivileges.length) why.push(`API roles hold ${v.apiPrivileges.join(", ")}`)
  return why
}

function compare(before: Facts, after: Facts, expectView: boolean): string[] {
  const why: string[] = []
  const names = (f: Facts) => Object.keys(f.tables).sort().join(",")
  if (names(before) !== names(after)) why.push(`table set changed: ${names(before)} -> ${names(after)}`)
  for (const t of Object.keys(before.tables)) if (before.tables[t] !== after.tables[t]) why.push(`${t} ${before.tables[t]} -> ${after.tables[t]}`)
  const fig = (l: LedgerJudgement) => JSON.stringify([l.userLeaves, l.ledger, l.escrow, l.issuance])
  if (!after.ledger.ok) why.push(`ledger broken: ${after.ledger.lines.join("; ")}`)
  if (fig(before.ledger) !== fig(after.ledger)) why.push("ledger figures changed")
  if (expectView) why.push(...viewProblems(after.view))
  else if (after.view) why.push("the view is still there")
  if (after.recorded !== expectView) why.push(`_prisma_migrations row ${expectView ? "missing" : "still there"}`)
  return why
}

function readBackup(file: string) {
  if (!file || !existsSync(file)) die(`no such backup: ${file}`)
  const sql = readFileSync(file, "utf8")
  if (!sql.includes(TRAILER)) die("the backup has no trailer; it is truncated")
  return Object.fromEntries((/-- rowcounts: (.*)/.exec(sql)?.[1] ?? "").split(/\s+/).filter(Boolean).map((p) => { const [t, n] = p.split("="); return [t, Number(n)] })) as Record<string, number>
}

async function appConnections(pg: Client) {
  return (await pg.query(`SELECT pid, application_name, state FROM pg_stat_activity
     WHERE datname = current_database() AND usename = 'postgres' AND pid <> pg_backend_pid() AND application_name NOT LIKE 'pg_net%'`)).rows
}

// ── forward / reverse ───────────────────────────────────────────────────────

async function apply(direction: "forward" | "reverse") {
  const target = targetArg()
  const purpose: LivePurpose = direction === "forward" ? "migrate" : "rollback"
  const migration = await loadMigration(MIGRATION)
  const batch = direction === "forward" ? migration.batch : prepareBatch(`rollback/${MIGRATION}`, "migration", await readFile(ROLLBACK_FILE, "utf8"))
  printTarget(target, direction.toUpperCase())

  let live: LiveWriteAuthorization | undefined
  if (isLiveTarget(target)) {
    if (process.env.BAYLO_CUTOVER_LIVE !== "1") die("BAYLO_CUTOVER_LIVE=1 is not set in this shell")
    const ro = await connect(true)
    try {
      if (direction === "forward") {
        const claimed = readBackup(opt("--backup") ?? "")
        const f = await facts((s, p) => ro.query(s, p), target)
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
      const before = await facts(q, target)
      printFacts("BEFORE", before)
      if (direction === "forward" && (before.recorded || before.view)) throw new GuardError("already applied (recorded, or the view exists)")
      if (direction === "reverse" && (!before.recorded || !before.view)) throw new GuardError("nothing to reverse (not recorded, or no view)")
      if (!("Category" in before.tables)) throw new GuardError("no Category table: the view needs 20261008000000_category_lookup_table first")

      const started = (await g.query(`SELECT clock_timestamp() AS t`)).rows[0].t
      await g.run(batch)
      if (direction === "forward") {
        await g.query(`INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
           VALUES ($1, $2, clock_timestamp(), $3, NULL, NULL, $4, 1)`, [randomUUID(), migration.checksum, MIGRATION, started])
      } else {
        const del = await g.query(`DELETE FROM "_prisma_migrations" WHERE migration_name = $1`, [MIGRATION])
        if (del.rowCount !== 1) throw new GuardError(`expected to delete 1 _prisma_migrations row, deleted ${del.rowCount}`)
      }

      const after = await facts(q, target)
      printFacts("AFTER (inside the transaction)", after)
      const why = compare(before, after, direction === "forward")
      if (why.length) throw new GuardError(`post-checks failed: ${why.join("; ")}`)
      console.log(`\n  post-checks passed: every table and count unchanged, ledger as before` +
        (direction === "forward" ? ", the view equals the direct aggregate row for row, security_invoker on, no API-role privilege" : ", the view is gone"))
    })
    console.log(`\n  ${direction.toUpperCase()} COMMITTED on ${target} in ${Date.now() - t0} ms (one transaction)`)
  } catch (e) {
    console.error(`\n  ${direction.toUpperCase()} ROLLED BACK after ${Date.now() - t0} ms; ${target} is exactly as it was: ${(e as Error).message}`)
    process.exitCode = 1
  } finally {
    await pg.end().catch(() => {})
  }
}

// ── verify (read-only) ──────────────────────────────────────────────────────

async function verify() {
  const target = targetArg()
  printTarget(target, "VERIFY (read-only)")
  const pg = await connect(true)
  let failures = 0
  const check = (ok: boolean, label: string, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`); if (!ok) failures++ }
  try {
    await pg.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
    const f = await facts((s, p) => pg.query(s, p), target)
    printFacts(target, f)
    console.log("")
    check(f.recorded, "migration recorded in _prisma_migrations")
    for (const p of viewProblems(f.view)) check(false, p)
    if (f.view && !viewProblems(f.view).length) check(true, `view = direct aggregate, ${f.view.rows} rows / ${f.view.pairs} pairs, security_invoker on, no API-role privilege`)
    const e = await exposure(pg, target)
    check(e.tablesExposed === 0 && e.sequencesExposed === 0 && e.routinesExposed === 0, "API-role exposure (tables and views)", describe(e))
    const sample = (await pg.query(`SELECT "title", "wantedCount", "wantedCategories", "wantedCategoryIds" FROM ${qi(target, VIEW)} ORDER BY "title"`)).rows
    for (const r of sample) console.log(`        ${String(r.title).slice(0, 28).padEnd(28)} n=${r.wantedCount}  ${r.wantedCategories}  {${(r.wantedCategoryIds as string[]).join(",")}}`)
    await pg.query("ROLLBACK")

    // A real read attempt as each API role, in its own read-only transaction.
    for (const role of ["anon", "authenticated"]) {
      if (!(await pg.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role])).rows.length) { console.log(`  skip  ${role}: no such role here`); continue }
      await pg.query("BEGIN READ ONLY")
      try {
        await pg.query(`SET LOCAL ROLE ${role}`)
        await pg.query(`SELECT 1 FROM ${qi(target, VIEW)} LIMIT 1`)
        check(false, `${role} reading the view is refused`, "the SELECT SUCCEEDED")
      } catch (err) {
        const msg = (err as Error).message
        check(/permission denied/i.test(msg), `${role} reading the view is refused`, msg)
      } finally {
        await pg.query("ROLLBACK")
      }
    }
  } finally { await pg.end() }
  console.log(failures ? `\n  ${failures} FAILED\n` : "\n  ALL PASSED\n")
  process.exitCode = failures ? 1 : 0
}

const run =
  cmd === "forward" ? apply("forward")
  : cmd === "reverse" ? apply("reverse")
  : cmd === "verify" ? verify()
  : die("usage: apply-wanted-summary-view.ts forward --target <s> [--backup <file>] [--confirm-live-migrate] | reverse --target <s> [--confirm-live-rollback] | verify --target <s>")
run.catch((e) => { console.error(`\n  FAILED: ${(e as Error).message}\n`); process.exit(1) })
