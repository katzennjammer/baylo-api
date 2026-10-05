// Postgres backup and restore for Baylo, with no PostgreSQL client tools
// installed.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// The database moved to Supabase on 2026-09-15 and the free tier takes NO
// automatic backups. `scripts/backup-baylo.ps1` still works but dumps the
// MariaDB fallback, which stopped being the live database that day. The
// standard tool, `pg_dump`, is a separate install (see backup-baylo-pg.ps1),
// and "your data is unprotected until you install something" is not an
// acceptable state for a project whose database has been corrupted three
// times. This needs only `pg`, which is already a dependency.
//
// Use `pg_dump` when it is available — it is the standard, it is tested by
// everybody, and it captures the schema as well. `scripts/backup-baylo-pg.ps1`
// prefers it and falls back to this. This file is the floor, not the ceiling.
//
// ── WHAT IT WRITES: DATA ONLY, AND WHY THAT IS ENOUGH HERE ──────────────────
//
// The schema is not in the dump. It does not need to be: it is in this repo,
// as prisma/migrations/20260915000000_postgres_baseline, which builds all 25
// tables, 20 enum types, 55 indexes and 48 foreign keys from empty and is the
// source of truth for them. A restore is therefore two steps, and the file
// says so in its own header:
//
//     npx prisma migrate deploy                       (build the empty schema)
//     npx tsx scripts/pg-backup.ts restore <file>     (put the rows back)
//
// The cost of that choice is real and worth stating: this dump cannot rebuild
// a database whose schema you no longer have. Keep the repo. `pg_dump` has no
// such dependency, which is the main reason to prefer it.
//
// ── HOW ROWS SURVIVE THE ROUND TRIP ─────────────────────────────────────────
//
// timestamp/date/time values are read as TEXT, never as JS Date objects. A
// Date would be rendered back through the writer's timezone, and on a laptop
// in UTC+8 every timestamp in the file would be eight hours wrong in a way
// that restores without complaint. The type parsers below turn that off. This
// is the same discipline as the MySQL move (dateStrings), for the same reason.
//
// Values are written as SQL literals with standard_conforming_strings on and
// single quotes doubled; bytea and json would need more care and the schema
// has neither. Tables are written in foreign-key dependency order, derived
// from pg_constraint rather than hand-listed, and the one self-referencing
// table (PostComment.parentId) is written parent-first, so a restore never
// needs to defer constraints — which the Supabase role could not do anyway.
//
// ── THE TRAILER IS A CHECK, NOT A DECORATION ────────────────────────────────
//
// The last lines carry a per-table row count and the ledger invariant as they
// were at dump time. backup-baylo-pg.ps1 re-reads them and compares against
// the live database. A truncated file loses its trailer; a file that dumped
// half a table disagrees with it.
//
//
// ── WHICH SCHEMA (5 Oct 2026) ───────────────────────────────────────────────
//
// Every command acts on the schema the URL names with `?schema=`, and on
// `public` (LIVE) when there is none. Until 5 Oct the pg driver ignored that
// parameter and every query here hard-coded `public`, so
// `restore --force` against a `?schema=scratch_x` URL would have TRUNCATED
// LIVE. Now:
//   - restore and drill run through scripts/lib/migration-runner.ts: one
//     guarded transaction, search_path pinned and re-checked around every
//     batch, and a backstop that rolls back if `public` was touched;
//   - restore into `public` refuses unless `--confirm-live-rollback` is given
//     AND the operator types the one-time confirmation in a terminal. That is
//     the cutover runbook's rollback path and nothing else;
//   - drill builds the structure the BACKUP was taken in (the migrations its
//     header lists), so it restores an old-layout and a v2-layout dump alike.
//   (scripts/schema-v2/test-pg-backup-target.ts proves all three.)
//
// Usage:
//   npx tsx --env-file=.env scripts/pg-backup.ts dump <out-file>
//   npx tsx --env-file=.env scripts/pg-backup.ts restore <in-file> [--force] [--confirm-live-rollback]
//   npx tsx --env-file=.env scripts/pg-backup.ts drill <in-file>   (rehearse a restore safely)
//   npx tsx --env-file=.env scripts/pg-backup.ts counts            (counts, for verification)
import { Client, types } from "pg"
import { LEDGER_INVARIANT_SQL, figuresFromRow, judge } from "./lib/ledger-invariant"
import {
  GuardError, confirmLiveWrite, isScratchTarget, loadMigration, localMigrationNames, prepareBatch, withGuardedTransaction,
  type LiveWriteAuthorization,
} from "./lib/migration-runner"
import { createWriteStream, existsSync } from "node:fs"
import { readFile } from "node:fs/promises"

// Read date/time types as the text Postgres stores. See the header.
for (const oid of [1082 /* date */, 1114 /* timestamp */, 1083 /* time */, 1184 /* timestamptz */]) {
  types.setTypeParser(oid, (v) => v)
}
// int8/numeric as text too — no silent precision loss through a JS number.
types.setTypeParser(20, (v) => v)
types.setTypeParser(1700, (v) => v)

const TRAILER = "-- Baylo data dump complete"
const SKIP = new Set(["_prisma_migrations"]) // Prisma's own bookkeeping; migrate deploy writes it.

function rawUrl(): URL {
  const u = process.env.DATABASE_URL
  if (!u) { console.error("DATABASE_URL is not set."); process.exit(2) }
  if (!u.startsWith("postgres")) { console.error("DATABASE_URL is not a Postgres URL."); process.exit(2) }
  return new URL(u)
}

/** The schema this run acts on: the URL's ?schema=, else public (LIVE). */
function targetSchema(): string {
  const s = rawUrl().searchParams.get("schema") ?? "public"
  if (s !== "public" && !/^[a-z_][a-z0-9_]*$/.test(s)) { console.error(`refusing schema name "${s}"`); process.exit(2) }
  return s
}

function printTarget(schema: string, mode: string) {
  const u = rawUrl()
  console.log(`  target  host=${u.hostname}:${u.port || 5432}  database=${u.pathname.slice(1)}  schema=${schema}${schema === "public" ? " (LIVE)" : ""}  mode=${mode}`)
}

async function connect(): Promise<Client> {
  const u = rawUrl()
  u.searchParams.delete("schema") // the driver does not know it; the schema is explicit below
  const c = new Client({ connectionString: u.toString() })
  c.on("error", (e) => console.error(`  connection lost: ${e.message}`))
  await c.connect()
  return c
}

const q = (schema: string, table: string) => `"${schema}"."${table}"`

/** Tables in foreign-key dependency order, plus any self-referencing column. */
async function plan(pg: Client, schema: string) {
  const tables: string[] = (await pg.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`, [schema]))
    .rows.map((r) => r.tablename).filter((t: string) => !SKIP.has(t))

  const fks = (await pg.query(`
    SELECT ct.relname AS child, pt.relname AS parent,
           (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
              FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS child_cols
    FROM pg_constraint c
    JOIN pg_class ct ON ct.oid = c.conrelid
    JOIN pg_class pt ON pt.oid = c.confrelid
    WHERE c.contype = 'f' AND c.connamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)`, [schema])).rows as
    { child: string; parent: string; child_cols: string }[]

  const deps = new Map(tables.map((t) => [t, new Set<string>()]))
  const selfRef = new Map<string, string>()
  for (const f of fks) {
    if (f.child === f.parent) { selfRef.set(f.child, f.child_cols); continue }
    deps.get(f.child)?.add(f.parent)
  }
  const order: string[] = []
  const placed = new Set<string>()
  while (order.length < tables.length) {
    const ready = tables.filter((t) => !placed.has(t) && [...deps.get(t)!].every((d) => placed.has(d)))
    if (!ready.length) throw new Error(`foreign-key cycle among ${tables.filter((t) => !placed.has(t))}`)
    for (const t of ready) { order.push(t); placed.add(t) }
  }
  return { tables, order, selfRef }
}

async function columnsOf(pg: Client, schema: string, table: string): Promise<string[]> {
  return (await pg.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [schema, table]))
    .rows.map((r) => r.column_name)
}

/** A JS value from pg -> a SQL literal. */
function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL"
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE"
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`non-finite number in data: ${v}`)
    return String(v)
  }
  if (v instanceof Date) {
    // Should be unreachable: the type parsers above keep these as text. If it
    // happens, stop rather than write a timezone-shifted value.
    throw new Error("a Date reached the writer -- the type parsers are not installed")
  }
  return `'${String(v).replace(/'/g, "''")}'`
}

/** Rows of a self-referencing table, every parent before its children. */
function parentFirst(rows: Record<string, unknown>[], parentCol: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const done = new Set<unknown>()
  let pending = rows
  while (pending.length) {
    const ready = pending.filter((r) => r[parentCol] == null || done.has(r[parentCol]))
    if (!ready.length) throw new Error(`self-reference cycle or dangling parent in ${parentCol}`)
    for (const r of ready) { out.push(r); done.add(r.id) }
    const readySet = new Set(ready)
    pending = pending.filter((r) => !readySet.has(r))
  }
  return out
}

/**
 * The full reconciliation (three checks since bracket trading, 16 Sep 2026),
 * from the shared definition in scripts/lib/ledger-invariant.ts. `ok` is all
 * three; `userLeaves`/`ledger` are still printed on their own line because
 * backup-baylo-pg.ps1 parses that line by regex.
 */
async function invariant(pg: Client, schema: string) {
  // Live keeps the pre-v2 Offer + TradeRequest layout until the schema v2
  // cutover, and a restored backup can be either; read whichever this is.
  const v2 = (await pg.query(`SELECT to_regclass($1) IS NOT NULL AS v2`, [`"${schema}"."Trade"`])).rows[0].v2
  const r = (await pg.query(LEDGER_INVARIANT_SQL(schema, v2 ? "v2" : "v1"))).rows[0]
  return judge(figuresFromRow(r))
}

function trailerCounts(sql: string): [string, number][] {
  return (/-- rowcounts: (.*)/.exec(sql)?.[1] ?? "").split(/\s+/).filter(Boolean).map((p) => {
    const [t, n] = p.split("="); return [t, Number(n)]
  })
}

async function readDump(inPath: string): Promise<string> {
  if (!existsSync(inPath)) { console.error(`no such file: ${inPath}`); process.exit(2) }
  const sql = await readFile(inPath, "utf8")
  if (!sql.includes(TRAILER)) {
    console.error(`${inPath} has no "${TRAILER}" trailer -- it is truncated. Refusing to restore from it.`)
    process.exit(1)
  }
  return sql
}

// ── dump ─────────────────────────────────────────────────────────────────────

async function dump(outPath: string) {
  const schema = targetSchema()
  printTarget(schema, "READ-ONLY")
  const pg = await connect()
  await pg.query(`SET SESSION default_transaction_read_only = on`)
  const { order, selfRef } = await plan(pg, schema)
  const out = createWriteStream(outPath, { encoding: "utf8" })
  const write = (s: string) => new Promise<void>((res, rej) => out.write(s, (e) => (e ? rej(e) : res())))

  const where = (await pg.query(
    `SELECT current_database() AS db, current_user AS usr, version() AS v`)).rows[0]
  const hasMigrations = (await pg.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [q(schema, "_prisma_migrations")])).rows[0].ok
  const applied = hasMigrations ? (await pg.query(
    `SELECT migration_name FROM ${q(schema, "_prisma_migrations")} WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at`))
    .rows.map((r) => r.migration_name) : []
  const inv = await invariant(pg, schema)

  await write(
    `-- Baylo Postgres backup -- DATA ONLY. The schema lives in prisma/migrations.\n` +
    `--\n` +
    `-- generated   ${new Date().toISOString()}\n` +
    `-- database    ${where.db} as ${where.usr}, schema ${schema}\n` +
    `-- server      ${String(where.v).split(",")[0]}\n` +
    `-- migrations  ${applied.join(", ") || "(none recorded)"}\n` +
    `-- invariant   SUM(User.leaves) = ${inv.userLeaves}  SUM(LeafTransaction.amount) = ${inv.ledger}` +
    `  ${inv.userLeaves === inv.ledger ? "holds" : "BROKEN AT DUMP TIME"}\n` +
    `--\n` +
    `-- RESTORE, into a database whose schema is built and whose tables are empty:\n` +
    `--   npx prisma migrate deploy\n` +
    `--   npx tsx --env-file=.env scripts/pg-backup.ts restore <this file>\n` +
    `--\n` +
    `-- Rows are written in foreign-key order and the whole restore is one\n` +
    `-- transaction: it lands completely or not at all.\n\n` +
    `SET standard_conforming_strings = on;\n\nBEGIN;\n\n`)

  const counts: Record<string, number> = {}
  for (const table of order) {
    const cols = await columnsOf(pg, schema, table)
    const quoted = cols.map((c) => `"${c}"`).join(", ")
    let rows: Record<string, unknown>[] = (await pg.query(`SELECT ${quoted} FROM ${q(schema, table)}`)).rows
    const self = selfRef.get(table)
    if (self && rows.length) rows = parentFirst(rows, self)

    counts[table] = rows.length
    await write(`-- table: "${table}" (${rows.length} rows)\n`)
    for (const r of rows) {
      await write(`INSERT INTO "${table}" (${quoted}) VALUES (${cols.map((c) => literal(r[c])).join(", ")});\n`)
    }
    await write("\n")
    console.log(`  ${table.padEnd(24)} ${String(rows.length).padStart(6)} rows`)
  }

  await write(`COMMIT;\n\n`)
  // The trailer. backup-baylo-pg.ps1 parses these three lines and checks them
  // against the live database, so a half-written file cannot pass as whole.
  await write(`-- rowcounts: ${Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(" ")}\n`)
  await write(`-- invariant: userLeaves=${inv.userLeaves} ledger=${inv.ledger}\n`)
  await write(`-- escrow: escrow=${inv.escrow} held=${inv.held} issuance=${inv.issuance}\n`)
  await write(`${TRAILER}\n`)
  await new Promise<void>((res, rej) => out.end((e: Error | null) => (e ? rej(e) : res())))
  await pg.end()

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\n  wrote ${total} rows across ${order.length} tables`)
  if (inv.userLeaves !== inv.ledger) {
    console.error(`\n  WARNING: the ledger invariant was BROKEN at dump time ` +
      `(${inv.userLeaves} vs ${inv.ledger}). The backup is faithful to the database; the database is wrong.\n`)
    process.exit(3)
  }
}

// ── restore ──────────────────────────────────────────────────────────────────

async function restore(inPath: string, force: boolean) {
  const schema = targetSchema()
  // Decide BEFORE connecting: public needs the typed live confirmation; any
  // other schema must be a scratch schema.
  let live: LiveWriteAuthorization | undefined
  if (schema === "public") {
    printTarget(schema, "WRITE (LIVE ROLLBACK)")
    try { live = await confirmLiveWrite("rollback", rawUrl().hostname) } catch (e) { console.error(`\n  ${(e as Error).message}\n`); process.exit(1) }
  } else {
    if (!isScratchTarget(schema)) { console.error(`  REFUSING: restore only targets scratch schemas (schema_v2_*, scratch_*) or, with --confirm-live-rollback, public; got "${schema}"`); process.exit(1) }
    printTarget(schema, "WRITE")
  }
  const sql = await readDump(inPath)
  const batch = prepareBatch(inPath, "data", sql)

  const pg = await connect()
  try {
    await withGuardedTransaction(pg, { target: schema, live, lockTimeout: "10s" }, async (g) => {
      const { tables } = await plan(pg, schema)
      if (!tables.length) throw new GuardError(`"${schema}" has no tables: build its structure first (prisma migrate deploy)`)
      const occupied: string[] = []
      for (const t of tables) {
        const n = Number((await g.query(`SELECT count(*) AS n FROM ${q(schema, t)}`)).rows[0].n)
        if (n > 0) occupied.push(`${t}=${n}`)
      }
      if (occupied.length && !force) {
        throw new GuardError(`the target is not empty (${occupied.join(" ")}). A restore is for an empty schema; ` +
          `pass --force to TRUNCATE every table in "${schema}" first, in the same transaction`)
      }
      if (occupied.length) {
        await g.query(`TRUNCATE ${tables.map((t) => q(schema, t)).join(", ")} CASCADE`)
        console.log(`  --force: truncated ${tables.length} tables in "${schema}" (same transaction)`)
      }

      await g.run(batch)

      let bad = 0
      for (const [t, n] of trailerCounts(sql)) {
        const got = Number((await g.query(`SELECT count(*) AS n FROM ${q(schema, t)}`)).rows[0].n)
        if (got !== n) { bad++; console.log(`  MISMATCH ${t}: file says ${n}, "${schema}" has ${got}`) }
      }
      const inv = await invariant(pg, schema)
      console.log(`  restored into "${schema}"; ${inv.lines.join("; ")}`)
      if (bad || !inv.ok) throw new GuardError(`restore did not verify (${bad} table mismatches${inv.ok ? "" : ", ledger broken"}); rolled back`)
    })
    console.log("\n  RESTORED AND VERIFIED\n")
  } catch (e) {
    console.error(`\n  RESTORE FAILED, nothing changed: ${(e as Error).message}\n`)
    process.exitCode = 1
  } finally {
    await pg.end()
  }
}

// ── drill ────────────────────────────────────────────────────────────────────
//
// Actually restore the backup, and prove the result matches the live database.
//
// A backup nobody has restored is a hypothesis. The obvious way to test one,
// restoring it over the real database, is the one thing you must not do. So
// this builds the schema the backup was TAKEN IN (the migrations its header
// lists) in a throwaway `restore_drill` schema inside one guarded
// transaction. It loads the dump, compares table by table against the
// trailer and against the schema the dump came from, and then ROLLS BACK,
// so nothing is left to clean up. Its source schema is only ever read.
//
// The catalog-by-name existence checks in the old chain are scoped to
// current_schema() by the runner (see migration-runner.ts scopeCatalogChecks);
// a lookup it does not recognise stops the drill rather than passing it.

const DRILL_SCHEMA = "restore_drill"

async function drill(inPath: string) {
  const source = targetSchema()
  const sql = await readDump(inPath)
  const listed = (/^-- migrations\s+(.*)$/m.exec(sql)?.[1] ?? "").split(",").map((s) => s.trim()).filter((s) => s && s !== "(none recorded)")
  const local = new Set(await localMigrationNames())
  const missing = listed.filter((m) => !local.has(m))
  const names = listed.filter((m) => local.has(m))
  if (!names.length) { console.error("the dump header lists no migration this repo has; cannot build its structure"); process.exit(1) }
  if (missing.length) console.log(`  note: the dump lists ${missing.length} migration(s) not in this repo (skipped): ${missing.join(", ")}`)
  const chain = await Promise.all(names.map(loadMigration))
  const batch = prepareBatch(inPath, "data", sql)

  printTarget(`${DRILL_SCHEMA} (rolled back), compared with ${source}`, "WRITE (scratch, rolled back)")
  const pg = await connect()
  try {
    await withGuardedTransaction(pg, { target: DRILL_SCHEMA, create: "fresh", commit: false }, async (g) => {
      console.log(`  building "${DRILL_SCHEMA}" from the dump's own ${chain.length} migration(s)`)
      for (const m of chain) await g.run(m.batch)
      const tables = Number((await g.query(`SELECT count(*) AS n FROM pg_tables WHERE schemaname = $1`, [DRILL_SCHEMA])).rows[0].n)
      console.log(`  schema built: ${tables} tables`)
      console.log(`  restoring ${inPath}`)
      await g.run(batch)

      let bad = 0, checkedTables = 0, rows = 0
      for (const [t, n] of trailerCounts(sql)) {
        const restored = Number((await g.query(`SELECT count(*) AS n FROM ${q(DRILL_SCHEMA, t)}`)).rows[0].n)
        const srcExists = (await g.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [q(source, t)])).rows[0].ok
        const live = srcExists ? Number((await g.query(`SELECT count(*) AS n FROM ${q(source, t)}`)).rows[0].n) : NaN
        checkedTables++; rows += restored
        if (restored !== n) { bad++; console.log(`  MISMATCH ${t}: file ${n}, restored ${restored}`) }
        else if (!srcExists) console.log(`  note     ${t}: not in "${source}" (the dump is from another layout)`)
        else if (restored !== live) console.log(`  note     ${t}: restored ${restored}, "${source}" is now ${live} (written since the dump)`)
      }
      const inv = await invariant(pg, DRILL_SCHEMA)
      console.log(`  restored ${rows} rows across ${checkedTables} tables`)
      for (const line of inv.lines) console.log(`  restored copy: ${line}`)

      // Spot-check that a timestamp survived the round trip as the same instant.
      const ts = (await g.query(`
        SELECT r."id", to_char(r."createdAt", 'YYYY-MM-DD HH24:MI:SS.MS') AS restored, to_char(p."createdAt", 'YYYY-MM-DD HH24:MI:SS.MS') AS live
        FROM ${q(DRILL_SCHEMA, "User")} r JOIN ${q(source, "User")} p ON p."id" = r."id"
        WHERE r."createdAt" IS DISTINCT FROM p."createdAt" LIMIT 5`)).rows
      if (ts.length) { bad++; for (const t of ts) console.log(`  TIMESTAMP DRIFT ${t.id}: restored ${t.restored}, source ${t.live}`) }
      else console.log(`  every User.createdAt in the restored copy is the same instant as "${source}"`)

      if (bad || !inv.ok) throw new GuardError("DRILL FAILED")
    })
    console.log(`\n  RESTORE DRILL PASSED -- this file rebuilds the database ("${DRILL_SCHEMA}" rolled back, nothing left behind)\n`)
  } catch (e) {
    console.error(`\n  ${(e as Error).message}\n`)
    process.exitCode = 1
  } finally {
    await pg.end()
  }
}

// ── counts (for the verifier) ────────────────────────────────────────────────

async function counts() {
  const schema = targetSchema()
  const pg = await connect()
  await pg.query(`SET SESSION default_transaction_read_only = on`)
  const { tables } = await plan(pg, schema)
  const out: string[] = []
  for (const t of tables) {
    out.push(`${t}=${Number((await pg.query(`SELECT count(*) AS n FROM ${q(schema, t)}`)).rows[0].n)}`)
  }
  const inv = await invariant(pg, schema)
  // Line 1 is parsed by backup-baylo-pg.ps1: keep it the bare counts.
  console.log(out.join(" "))
  console.log(`invariant: userLeaves=${inv.userLeaves} ledger=${inv.ledger}`)
  console.log(`escrow: escrow=${inv.escrow} held=${inv.held} issuance=${inv.issuance}`)
  await pg.end()
}

const [cmd, arg] = process.argv.slice(2)
const force = process.argv.includes("--force")
const run =
  cmd === "dump" && arg ? dump(arg)
  : cmd === "restore" && arg ? restore(arg, force)
  : cmd === "drill" && arg ? drill(arg)
  : cmd === "counts" ? counts()
  : (console.error("usage: pg-backup.ts dump <file> | restore <file> [--force] [--confirm-live-rollback] | drill <file> | counts"), process.exit(2))
void (run as Promise<void>).catch((e) => { console.error(e); process.exit(1) })
