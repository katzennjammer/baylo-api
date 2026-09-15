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
// Usage:
//   npx tsx --env-file=.env scripts/pg-backup.ts dump <out-file>
//   npx tsx --env-file=.env scripts/pg-backup.ts restore <in-file> [--force]
//   npx tsx --env-file=.env scripts/pg-backup.ts drill <in-file>   (rehearse a restore safely)
//   npx tsx --env-file=.env scripts/pg-backup.ts counts            (live counts, for verification)
import { Client, types } from "pg"
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

function url(): string {
  const u = process.env.DATABASE_URL
  if (!u) { console.error("DATABASE_URL is not set."); process.exit(2) }
  if (!u.startsWith("postgres")) { console.error("DATABASE_URL is not a Postgres URL."); process.exit(2) }
  return u
}

async function connect(): Promise<Client> {
  const c = new Client({ connectionString: url() })
  await c.connect()
  return c
}

/** Tables in foreign-key dependency order, plus any self-referencing column. */
async function plan(pg: Client) {
  const tables: string[] = (await pg.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`))
    .rows.map((r) => r.tablename).filter((t: string) => !SKIP.has(t))

  const fks = (await pg.query(`
    SELECT ct.relname AS child, pt.relname AS parent,
           (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
              FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS child_cols
    FROM pg_constraint c
    JOIN pg_class ct ON ct.oid = c.conrelid
    JOIN pg_class pt ON pt.oid = c.confrelid
    WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`)).rows as
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

async function columnsOf(pg: Client, table: string): Promise<string[]> {
  return (await pg.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table]))
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

async function invariant(pg: Client) {
  const r = (await pg.query(`
    SELECT (SELECT COALESCE(SUM(leaves), 0) FROM "User")::text AS user_leaves,
           (SELECT COALESCE(SUM(amount), 0) FROM "LeafTransaction")::text AS ledger`)).rows[0]
  return { userLeaves: Number(r.user_leaves), ledger: Number(r.ledger) }
}

// ── dump ─────────────────────────────────────────────────────────────────────

async function dump(outPath: string) {
  const pg = await connect()
  const { order, selfRef } = await plan(pg)
  const out = createWriteStream(outPath, { encoding: "utf8" })
  const write = (s: string) => new Promise<void>((res, rej) => out.write(s, (e) => (e ? rej(e) : res())))

  const where = (await pg.query(
    `SELECT current_database() AS db, current_user AS usr, version() AS v`)).rows[0]
  const applied = (await pg.query(
    `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at`))
    .rows.map((r) => r.migration_name)
  const inv = await invariant(pg)

  await write(
    `-- Baylo Postgres backup -- DATA ONLY. The schema lives in prisma/migrations.\n` +
    `--\n` +
    `-- generated   ${new Date().toISOString()}\n` +
    `-- database    ${where.db} as ${where.usr}\n` +
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
    const cols = await columnsOf(pg, table)
    const quoted = cols.map((c) => `"${c}"`).join(", ")
    let rows: Record<string, unknown>[] = (await pg.query(`SELECT ${quoted} FROM "${table}"`)).rows
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
  // The trailer. backup-baylo-pg.ps1 parses these two lines and checks them
  // against the live database, so a half-written file cannot pass as whole.
  await write(`-- rowcounts: ${Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(" ")}\n`)
  await write(`-- invariant: userLeaves=${inv.userLeaves} ledger=${inv.ledger}\n`)
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
  if (!existsSync(inPath)) { console.error(`no such file: ${inPath}`); process.exit(2) }
  const sql = await readFile(inPath, "utf8")
  if (!sql.includes(TRAILER)) {
    console.error(`${inPath} has no "${TRAILER}" trailer -- it is truncated. Refusing to restore from it.`)
    process.exit(1)
  }
  const pg = await connect()
  const { tables } = await plan(pg)

  const occupied: string[] = []
  for (const t of tables) {
    const n = Number((await pg.query(`SELECT count(*) AS n FROM "${t}"`)).rows[0].n)
    if (n > 0) occupied.push(`${t}=${n}`)
  }
  if (occupied.length && !force) {
    console.error(
      `\n  REFUSING: the target is not empty (${occupied.join(" ")}).\n` +
      `  A restore is for an empty schema built by \`prisma migrate deploy\`.\n` +
      `  Pass --force to TRUNCATE every table first and replace its contents.\n`)
    process.exit(1)
  }
  if (occupied.length && force) {
    await pg.query(`TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")} CASCADE`)
    console.log(`  --force: truncated ${tables.length} tables`)
  }

  // The file carries its own BEGIN/COMMIT, so this is one transaction.
  await pg.query(sql)

  const trailer = /-- rowcounts: (.*)/.exec(sql)?.[1] ?? ""
  let bad = 0
  for (const pair of trailer.split(/\s+/).filter(Boolean)) {
    const [t, n] = pair.split("=")
    const live = Number((await pg.query(`SELECT count(*) AS n FROM "${t}"`)).rows[0].n)
    if (live !== Number(n)) { bad++; console.log(`  MISMATCH ${t}: file says ${n}, database has ${live}`) }
  }
  const inv = await invariant(pg)
  console.log(`  restored; invariant SUM(User.leaves)=${inv.userLeaves} SUM(amount)=${inv.ledger} ` +
    `${inv.userLeaves === inv.ledger ? "holds" : "BROKEN"}`)
  await pg.end()
  if (bad || inv.userLeaves !== inv.ledger) process.exit(1)
  console.log("\n  RESTORED AND VERIFIED\n")
}

// ── drill ────────────────────────────────────────────────────────────────────
//
// Actually restore the backup, and prove the result matches the live database.
//
// A backup nobody has restored is a hypothesis. The obvious way to test one --
// restore it over the real database -- is the one thing you must not do, so
// this builds the whole schema in a THROWAWAY SCHEMA alongside `public`, loads
// the dump into it, compares the two table by table, and drops it again.
// `public` is only ever read.
//
// It works because every statement in the baseline migration and in the dump
// is written UNQUALIFIED ("User", not public."User"), so a search_path is
// enough to redirect all of it. The one exception is the baseline's
// `CREATE SCHEMA IF NOT EXISTS "public"`, which is skipped below. If a future
// migration hard-codes `public.`, this drill will start failing loudly rather
// than silently testing nothing -- the count comparison at the end is what
// would catch it.
//
// It holds no locks on public and writes nothing to it, so it is safe to run
// against the live database while the app is up.

const DRILL_SCHEMA = "restore_drill"

async function drill(inPath: string) {
  if (!existsSync(inPath)) { console.error(`no such file: ${inPath}`); process.exit(2) }
  const sql = await readFile(inPath, "utf8")
  if (!sql.includes(TRAILER)) { console.error(`${inPath} has no trailer; verify it first.`); process.exit(1) }

  const migrationsDir = new URL("../prisma/migrations/", import.meta.url)
  const { readdir } = await import("node:fs/promises")
  const dirs = (await readdir(migrationsDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory()).map((d) => d.name).sort()
  if (!dirs.length) { console.error("no migrations found to build the schema from"); process.exit(1) }

  let ddl = ""
  for (const d of dirs) {
    const body = await readFile(new URL(`${d}/migration.sql`, migrationsDir), "utf8")
    // The only schema-qualified statement in the chain, and the only one that
    // must not run here.
    ddl += body.replace(/^\s*CREATE SCHEMA IF NOT EXISTS "public";\s*$/gim, "") + "\n"
  }

  const pg = await connect()
  let built = false
  try {
    const exists = (await pg.query(
      `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [DRILL_SCHEMA])).rowCount
    if (exists) {
      console.error(`schema "${DRILL_SCHEMA}" already exists -- a previous drill did not clean up. ` +
        `Drop it (DROP SCHEMA "${DRILL_SCHEMA}" CASCADE) and run again.`)
      process.exit(1)
    }

    console.log(`  building the schema in "${DRILL_SCHEMA}" from ${dirs.length} migration(s)`)
    await pg.query(`CREATE SCHEMA "${DRILL_SCHEMA}"`)
    built = true
    // Everything from here lands in the drill schema. public is not on the path.
    await pg.query(`SET search_path TO "${DRILL_SCHEMA}"`)
    await pg.query(ddl)

    const tables = Number((await pg.query(
      `SELECT count(*) AS n FROM pg_tables WHERE schemaname = $1`, [DRILL_SCHEMA])).rows[0].n)
    console.log(`  schema built: ${tables} tables`)

    console.log(`  restoring ${inPath}`)
    await pg.query(sql)

    // ── The comparison ──────────────────────────────────────────────────────
    const claimed = /-- rowcounts: (.*)/.exec(sql)?.[1] ?? ""
    let bad = 0, checkedTables = 0, rows = 0
    for (const pair of claimed.split(/\s+/).filter(Boolean)) {
      const [t, n] = pair.split("=")
      const restored = Number((await pg.query(`SELECT count(*) AS n FROM "${DRILL_SCHEMA}"."${t}"`)).rows[0].n)
      const live = Number((await pg.query(`SELECT count(*) AS n FROM public."${t}"`)).rows[0].n)
      checkedTables++; rows += restored
      if (restored !== Number(n)) { bad++; console.log(`  MISMATCH ${t}: file ${n}, restored ${restored}`) }
      else if (restored !== live) { console.log(`  note     ${t}: restored ${restored}, live is now ${live} (written since the dump)`) }
    }

    const inv = (await pg.query(`
      SELECT (SELECT COALESCE(SUM(leaves), 0) FROM "${DRILL_SCHEMA}"."User")::text AS u,
             (SELECT COALESCE(SUM(amount), 0) FROM "${DRILL_SCHEMA}"."LeafTransaction")::text AS l`)).rows[0]
    const u = Number(inv.u), l = Number(inv.l)
    console.log(`  restored ${rows} rows across ${checkedTables} tables`)
    console.log(`  invariant in the restored copy: SUM(User.leaves)=${u}  SUM(amount)=${l}  ${u === l ? "holds" : "BROKEN"}`)

    // Spot-check that a timestamp survived the round trip as the same instant.
    const ts = (await pg.query(`
      SELECT r."id",
             to_char(r."createdAt", 'YYYY-MM-DD HH24:MI:SS.MS') AS restored,
             to_char(p."createdAt", 'YYYY-MM-DD HH24:MI:SS.MS') AS live
      FROM "${DRILL_SCHEMA}"."User" r JOIN public."User" p ON p."id" = r."id"
      WHERE r."createdAt" IS DISTINCT FROM p."createdAt" LIMIT 5`)).rows
    if (ts.length) {
      bad++
      for (const t of ts) console.log(`  TIMESTAMP DRIFT ${t.id}: restored ${t.restored}, live ${t.live}`)
    } else {
      console.log(`  every User.createdAt in the restored copy is the same instant as live`)
    }

    if (bad || u !== l) { console.error("\n  DRILL FAILED\n"); process.exitCode = 1 }
    else console.log("\n  RESTORE DRILL PASSED -- this file rebuilds the database\n")
  } finally {
    if (built) {
      await pg.query(`DROP SCHEMA "${DRILL_SCHEMA}" CASCADE`).catch((e) =>
        console.error(`  WARNING: could not drop "${DRILL_SCHEMA}": ${(e as Error).message}`))
      console.log(`  dropped "${DRILL_SCHEMA}"`)
    }
    await pg.end()
  }
}

// ── counts (for the verifier) ────────────────────────────────────────────────

async function counts() {
  const pg = await connect()
  const { tables } = await plan(pg)
  const out: string[] = []
  for (const t of tables) {
    out.push(`${t}=${Number((await pg.query(`SELECT count(*) AS n FROM "${t}"`)).rows[0].n)}`)
  }
  const inv = await invariant(pg)
  console.log(out.join(" "))
  console.log(`invariant: userLeaves=${inv.userLeaves} ledger=${inv.ledger}`)
  await pg.end()
}

const [cmd, arg] = process.argv.slice(2)
const force = process.argv.includes("--force")
const run =
  cmd === "dump" && arg ? dump(arg)
  : cmd === "restore" && arg ? restore(arg, force)
  : cmd === "drill" && arg ? drill(arg)
  : cmd === "counts" ? counts()
  : (console.error("usage: pg-backup.ts dump <file> | restore <file> [--force] | drill <file> | counts"), process.exit(2))
void (run as Promise<void>).catch((e) => { console.error(e); process.exit(1) })
