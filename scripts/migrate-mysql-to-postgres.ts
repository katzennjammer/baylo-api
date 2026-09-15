// One-shot data move: MySQL/MariaDB -> Postgres, for the 2026-09-15 migration
// to Supabase. Reads every table from MySQL with plain SELECTs inside a
// consistent-snapshot transaction (nothing is written to MySQL, ever) and
// inserts the rows into an EMPTY Postgres schema that `prisma migrate deploy`
// has already built.
//
// Why a script and not mysqldump: the dump is MySQL dialect end to end --
// backticks, ENUM(...) columns, tinyint(1) booleans, extended INSERTs -- and
// every translator that handles it is either Linux-only or lossy on exactly the
// things that matter here. This reads rows as VALUES and writes VALUES, and the
// three things that can silently go wrong across engines are handled by name:
//
//   DATETIME     read with dateStrings:true, so a DATETIME(3) arrives as the
//                literal text Prisma wrote ("2026-09-15 11:02:07.123", UTC,
//                because Prisma writes UTC to a zone-less column) and is
//                inserted into TIMESTAMP(3) verbatim. No JS Date, no session
//                zone, no shift. DATE (dateOfBirth) the same way.
//   BOOLEAN      MySQL tinyint(1) 0/1 -> Postgres boolean, decided per column
//                from the Postgres catalog, never by guessing from the value.
//   ENUM         a string on both sides; Postgres coerces the untyped literal
//                to the column's enum type and REJECTS a value that is not a
//                member, which is the check we want.
//
// Foreign keys are honoured by inserting tables in dependency order (derived
// from pg_constraint, not hand-listed) and, for the one self-referential table
// (PostComment.parentId), rows parent-first. Nothing disables triggers.
//
// Afterwards it proves the move: per-table row counts on both sides, every FK
// checked for orphans, and SUM(User.leaves) == SUM(LeafTransaction.amount)
// signed over all rows. It exits non-zero if any of those disagree.
//
// Run (from baylo/):
//   npx tsx --env-file=.env scripts/migrate-mysql-to-postgres.ts
// with DATABASE_URL = the Postgres target and MYSQL_URL = the MySQL source,
// e.g. MYSQL_URL="mysql://root:@127.0.0.1:3306/baylo". Refuses to run unless
// every Postgres table is empty; pass --truncate to empty them first (the
// scratch database only -- it will not ask twice).
import mariadb from "mariadb"
import { Client } from "pg"

const PG_URL = process.env.DATABASE_URL
const MY_URL = process.env.MYSQL_URL
if (!PG_URL || !MY_URL) {
  console.error("Need DATABASE_URL (Postgres target) and MYSQL_URL (MySQL source).")
  process.exit(2)
}
if (!PG_URL.startsWith("postgres")) { console.error("DATABASE_URL is not a Postgres URL."); process.exit(2) }
if (!MY_URL.startsWith("mysql")) { console.error("MYSQL_URL is not a MySQL URL."); process.exit(2) }
const TRUNCATE = process.argv.includes("--truncate")

// Prisma's own bookkeeping: each engine keeps its own. Never copied.
const SKIP = new Set(["_prisma_migrations"])

type Row = Record<string, unknown>
interface PgCol { name: string; type: string }

function myConfig(url: string) {
  const u = new URL(url)
  return {
    host: u.hostname, port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: u.pathname.slice(1),
    // THE timezone guard. DATETIME/DATE come back as the stored text, not as a
    // JS Date interpreted in some session zone.
    dateStrings: true,
    // Row counts here are small; no need to stream.
    bigIntAsNumber: true,
  }
}

function fail(msg: string): never { console.error(`\n  FAILED: ${msg}\n`); process.exit(1) }

async function main() {
  const my = await mariadb.createConnection(myConfig(MY_URL!))
  const pg = new Client({ connectionString: PG_URL })
  await pg.connect()

  // ── Catalogs ───────────────────────────────────────────────────────────────
  const pgTables: string[] = (await pg.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).rows.map((r) => r.tablename)
  const pgCols = new Map<string, PgCol[]>()
  for (const t of pgTables) {
    const r = await pg.query(
      `SELECT column_name, data_type, udt_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [t])
    pgCols.set(t, r.rows.map((c) => ({ name: c.column_name, type: c.data_type === "USER-DEFINED" ? c.udt_name : c.data_type })))
  }

  // MySQL on Windows lower-cases table names on disk; match case-insensitively.
  const myTablesRaw: string[] = (await my.query(
    `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name`)).map((r: { t: string }) => r.t)
  const myByLower = new Map(myTablesRaw.map((t) => [t.toLowerCase(), t]))

  const tables = pgTables.filter((t) => !SKIP.has(t))
  for (const t of tables) {
    if (!myByLower.has(t.toLowerCase())) fail(`Postgres table "${t}" has no MySQL counterpart`)
  }
  for (const t of myTablesRaw) {
    if (SKIP.has(t.toLowerCase())) continue
    if (!pgTables.some((p) => p.toLowerCase() === t.toLowerCase())) fail(`MySQL table "${t}" has no Postgres counterpart`)
  }

  // Column sets must be identical, by name. Prisma named both sides, so any
  // difference is a schema drift and this script is the wrong tool for it.
  for (const t of tables) {
    const myT = myByLower.get(t.toLowerCase())!
    const cols: string[] = (await my.query(
      `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position`, [myT]))
      .map((r: { c: string }) => r.c)
    const pgNames = pgCols.get(t)!.map((c) => c.name)
    const onlyMy = cols.filter((c) => !pgNames.includes(c))
    const onlyPg = pgNames.filter((c) => !cols.includes(c))
    if (onlyMy.length || onlyPg.length) {
      fail(`column mismatch on ${t}: only in MySQL [${onlyMy}], only in Postgres [${onlyPg}]`)
    }
  }

  // ── Dependency order, from the Postgres FKs ────────────────────────────────
  const fks = (await pg.query(`
    SELECT c.conname AS name, ct.relname AS child, pt.relname AS parent,
           (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS child_cols,
           (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS parent_cols
    FROM pg_constraint c
    JOIN pg_class ct ON ct.oid = c.conrelid
    JOIN pg_class pt ON pt.oid = c.confrelid
    WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
    ORDER BY 1`)).rows as { name: string; child: string; parent: string; child_cols: string; parent_cols: string }[]

  const deps = new Map<string, Set<string>>(tables.map((t) => [t, new Set()]))
  const selfRef = new Map<string, string>() // table -> self-referencing column
  for (const f of fks) {
    if (f.child === f.parent) { selfRef.set(f.child, f.child_cols); continue }
    deps.get(f.child)!.add(f.parent)
  }
  const order: string[] = []
  const placed = new Set<string>()
  while (order.length < tables.length) {
    const ready = tables.filter((t) => !placed.has(t) && [...deps.get(t)!].every((d) => placed.has(d)))
    if (!ready.length) fail(`cannot order tables: cycle among ${tables.filter((t) => !placed.has(t))}`)
    for (const t of ready) { order.push(t); placed.add(t) }
  }

  // ── Target must be empty ───────────────────────────────────────────────────
  if (TRUNCATE) {
    const list = tables.map((t) => `"${t}"`).join(", ")
    await pg.query(`TRUNCATE ${list} CASCADE`)
    console.log(`  truncated ${tables.length} Postgres tables (--truncate)`)
  }
  for (const t of tables) {
    const n = Number((await pg.query(`SELECT count(*) AS n FROM "${t}"`)).rows[0].n)
    if (n > 0) fail(`Postgres table "${t}" is not empty (${n} rows). This script only loads into an empty schema; pass --truncate for the scratch database.`)
  }

  // ── Copy ───────────────────────────────────────────────────────────────────
  // One consistent snapshot of MySQL for the whole read, so a write landing
  // mid-copy cannot make table A and table B disagree about the same trade.
  await my.query("START TRANSACTION WITH CONSISTENT SNAPSHOT")
  await pg.query("BEGIN")

  const copied = new Map<string, { my: number; pg: number }>()
  const width = Math.max(...tables.map((t) => t.length))
  console.log(`\n  ${"table".padEnd(width)}  mysql  ->  postgres`)
  for (const t of order) {
    const myT = myByLower.get(t.toLowerCase())!
    const cols = pgCols.get(t)!
    const colList = cols.map((c) => `\`${c.name}\``).join(", ")
    let rows: Row[] = await my.query(`SELECT ${colList} FROM \`${myT}\``)
    // mariadb returns a meta property on the array; strip to plain rows.
    rows = Array.from(rows)

    const self = selfRef.get(t)
    if (self && rows.length) rows = parentFirst(rows, "id", self)

    const inserted = await insertRows(pg, t, cols, rows)
    copied.set(t, { my: rows.length, pg: inserted })
    console.log(`  ${t.padEnd(width)}  ${String(rows.length).padStart(5)}  ->  ${String(inserted).padStart(8)}`)
  }

  await pg.query("COMMIT")
  await my.query("ROLLBACK") // read-only snapshot; nothing to keep

  // ── Verify: counts ─────────────────────────────────────────────────────────
  console.log("\n  verifying row counts against MySQL, table by table")
  let bad = 0
  for (const t of tables) {
    const myT = myByLower.get(t.toLowerCase())!
    const myN = Number((await my.query(`SELECT COUNT(*) AS n FROM \`${myT}\``))[0].n)
    const pgN = Number((await pg.query(`SELECT count(*) AS n FROM "${t}"`)).rows[0].n)
    const ok = myN === pgN
    if (!ok) bad++
    console.log(`  ${ok ? "OK  " : "DIFF"}  ${t.padEnd(width)}  mysql ${String(myN).padStart(5)}  postgres ${String(pgN).padStart(5)}`)
  }

  // ── Verify: every FK has no orphans ────────────────────────────────────────
  console.log("\n  verifying foreign keys (orphan rows)")
  for (const f of fks) {
    const cc = f.child_cols.split(",").map((c) => `c."${c}"`)
    const pc = f.parent_cols.split(",").map((c) => `p."${c}"`)
    const join = cc.map((c, i) => `${c} = ${pc[i]}`).join(" AND ")
    const notNull = cc.map((c) => `${c} IS NOT NULL`).join(" AND ")
    const n = Number((await pg.query(
      `SELECT count(*) AS n FROM "${f.child}" c WHERE ${notNull} AND NOT EXISTS (SELECT 1 FROM "${f.parent}" p WHERE ${join})`)).rows[0].n)
    if (n > 0) { bad++; console.log(`  ORPHANS  ${f.name}: ${n} rows`) }
  }
  console.log(`  ${fks.length} foreign keys checked`)

  // ── Verify: the ledger invariant, signed, all rows ─────────────────────────
  const inv = (await pg.query(`
    SELECT (SELECT COALESCE(SUM(leaves), 0) FROM "User") AS user_leaves,
           (SELECT COALESCE(SUM(amount), 0) FROM "LeafTransaction") AS ledger`)).rows[0]
  const myInv = (await my.query(`
    SELECT (SELECT COALESCE(SUM(leaves), 0) FROM \`${myByLower.get("user")}\`) AS user_leaves,
           (SELECT COALESCE(SUM(amount), 0) FROM \`${myByLower.get("leaftransaction")}\`) AS ledger`))[0]
  const pgU = Number(inv.user_leaves), pgL = Number(inv.ledger)
  const myU = Number(myInv.user_leaves), myL = Number(myInv.ledger)
  console.log(`\n  ledger invariant, signed over all rows`)
  console.log(`    MySQL     SUM(User.leaves) = ${myU}   SUM(LeafTransaction.amount) = ${myL}   ${myU === myL ? "holds" : "BROKEN"}`)
  console.log(`    Postgres  SUM(User.leaves) = ${pgU}   SUM(LeafTransaction.amount) = ${pgL}   ${pgU === pgL ? "holds" : "BROKEN"}`)
  if (pgU !== pgL || pgU !== myU || pgL !== myL) bad++

  await my.end()
  await pg.end()
  if (bad) fail(`${bad} verification problem(s) above`)
  console.log("\n  DATA MOVED AND VERIFIED\n")
}

/** Rows of a self-referencing table ordered so every parent precedes its children. */
function parentFirst(rows: Row[], idCol: string, parentCol: string): Row[] {
  const out: Row[] = []
  const done = new Set<unknown>()
  let pending = rows
  while (pending.length) {
    const ready = pending.filter((r) => r[parentCol] == null || done.has(r[parentCol]))
    if (!ready.length) fail(`self-reference cycle or dangling parent in ${parentCol}`)
    for (const r of ready) { out.push(r); done.add(r[idCol]) }
    pending = pending.filter((r) => !ready.includes(r))
  }
  return out
}

async function insertRows(pg: Client, table: string, cols: PgCol[], rows: Row[]): Promise<number> {
  if (!rows.length) return 0
  const names = cols.map((c) => `"${c.name}"`).join(", ")
  const BATCH = 200
  let total = 0
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH)
    const params: unknown[] = []
    const tuples = chunk.map((r) => {
      const ph = cols.map((c) => { params.push(convert(r[c.name], c)); return `$${params.length}` })
      return `(${ph.join(", ")})`
    })
    const res = await pg.query(`INSERT INTO "${table}" (${names}) VALUES ${tuples.join(", ")}`, params)
    total += res.rowCount ?? 0
  }
  return total
}

/** MySQL value -> Postgres parameter, decided by the Postgres column type. */
function convert(v: unknown, col: PgCol): unknown {
  if (v === null || v === undefined) return null
  switch (col.type) {
    case "boolean":
      // tinyint(1) arrives as 0/1 (or, defensively, a boolean already).
      if (typeof v === "boolean") return v
      if (typeof v === "number") return v !== 0
      fail(`boolean column ${col.name} got ${typeof v} ${String(v)}`)
    // Dates and timestamps: pass the literal text through untouched.
    case "timestamp without time zone":
    case "date":
      if (typeof v !== "string") fail(`expected date text for ${col.name}, got ${typeof v}`)
      return v
    default:
      return v
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
