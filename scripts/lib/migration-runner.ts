/**
 * THE ONE WAY A SCRIPT IN THIS REPO RUNS MIGRATION SQL, OR A DATA DUMP,
 * AGAINST POSTGRES.
 *
 * ── WHY (4 Oct 2026) ────────────────────────────────────────────────────────
 *
 * A scratch rebuild ran the pre-v2 migration chain inside BEGIN ... COMMIT
 * with `SET LOCAL search_path` pointing at a scratch schema.
 * `20260925000003_drop_removed_roles` carries its own `BEGIN; ... COMMIT;`.
 * Its COMMIT ended the outer transaction early, and with it the SET LOCAL,
 * so every later statement resolved through the default path to `public`,
 * which is LIVE. The first such statement was
 * `ALTER TYPE "ReportTargetType" ADD VALUE 'STORY'`, which failed because
 * live already had the label. That failure is the only reason nothing
 * changed. Every script that runs migration SQL here (build-scratch.ts,
 * pg-backup.ts drill and restore, cutover-rehearsal.ts) goes through this
 * module, and scripts/schema-v2/test-migration-guard.ts proves it.
 *
 * ── THE RULES ───────────────────────────────────────────────────────────────
 *
 *  1  ONE TRANSACTION. withGuardedTransaction() opens it and is the only
 *     place that commits. A batch may not carry transaction control of its
 *     own. A plain `BEGIN;` / `COMMIT;` statement is stripped, because it is
 *     redundant inside ours. Anything else refuses the batch BEFORE it runs:
 *     ROLLBACK, END, SAVEPOINT, COMMIT AND CHAIN, START TRANSACTION, and so on.
 *  2  NO PATH CHANGES. A batch may not touch search_path, role or session
 *     state (SET/RESET search_path, SET SCHEMA, set_config('search_path'),
 *     SET ROLE, DISCARD, RESET ALL), may not name `public` (neither
 *     `public.` nor `'public'`), and may not create, drop or alter a schema.
 *  3  PINNED, AND RE-CHECKED AROUND EVERY BATCH. search_path is set at
 *     SESSION level, never SET LOCAL (a COMMIT ends a SET LOCAL), and
 *     current_schema() plus search_path are asserted before and after every
 *     batch.
 *  4  A BACKSTOP ON THE PROTECTED SCHEMA (public), checked inside the
 *     transaction BEFORE commit. If any of these tripped, the whole
 *     transaction rolls back:
 *       - this transaction wrote no rows there (pg_stat_xact_user_tables);
 *       - it holds no lock stronger than ACCESS SHARE on any of its relations;
 *       - its catalog fingerprint (classes, types, enum labels, columns,
 *         constraints, functions, default ACLs: oid + xmin) is unchanged.
 *     Rules 1 to 3 are meant to make the backstop unreachable. It exists in
 *     case they are wrong in some way nobody has thought of yet.
 *  5  SCRATCH TARGETS ONLY: schema_v2_*, scratch_* or restore_drill. A
 *     write to `public` needs a LiveWriteAuthorization, and only
 *     confirmLiveWrite() can make one: an explicit flag, an interactive
 *     terminal, and a typed phrase with a one-time code.
 */
import type { Client } from "pg"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { createInterface } from "node:readline/promises"
import { LEDGER_INVARIANT_SQL, figuresFromRow, judge } from "./ledger-invariant"

export const MIGRATIONS_DIR = new URL("../../prisma/migrations/", import.meta.url)

export const V2_MIGRATIONS = [
  "20261003000000_schema_v2_core", "20261003000001_schema_v2_ledger", "20261003000002_schema_v2_trade",
  "20261004000000_schema_v2_audit_fixes", "20261004000001_schema_v2_trade_completed_backfill",
  "20261004000002_schema_v2_drop_trade_hidden",
] as const

/** The advisory-lock key `prisma migrate` takes, so a concurrent deploy cannot interleave. */
export const PRISMA_MIGRATE_LOCK_KEY = 72707369

const SCRATCH_TARGET = /^(schema_v2_[a-z0-9_]+|scratch_[a-z0-9_]+|restore_drill)$/
export const isScratchTarget = (s: string) => SCRATCH_TARGET.test(s)

export class GuardError extends Error {
  constructor(message: string) { super(`[migration guard] ${message}`); this.name = "GuardError" }
}

// ── Live authorization (rule 5) ─────────────────────────────────────────────

const LIVE_BRAND = Symbol("live-write-authorization")
export interface LiveWriteAuthorization { readonly [LIVE_BRAND]: true; readonly purpose: string; readonly at: string }

/**
 * The ONLY way to obtain permission to write `public`. It needs the explicit
 * `--confirm-live-<purpose>` flag on the command line and an interactive
 * terminal, and the operator must type the phrase back, including a one-time
 * code. No environment variable can supply it, and neither can a pipe, CI or
 * a pasted command, since the code is new on every run.
 */
export async function confirmLiveWrite(purpose: "rollback" | "cutover" | "lockdown" | "migrate", target: string): Promise<LiveWriteAuthorization> {
  const flag = `--confirm-live-${purpose}`
  if (!process.argv.includes(flag)) throw new GuardError(`refusing to write "public" (LIVE): pass ${flag} and type the confirmation`)
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new GuardError(`refusing to write "public" (LIVE): ${flag} needs an interactive terminal to type the confirmation`)
  const code = randomBytes(3).toString("hex").toUpperCase()
  const phrase = `${purpose.toUpperCase()} LIVE public ${code}`
  console.log(`\n  !! LIVE WRITE: ${purpose} against ${target}, schema "public"`)
  console.log(`  !! type exactly:  ${phrase}`)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const typed = (await rl.question("  > ")).trim()
  rl.close()
  if (typed !== phrase) throw new GuardError("confirmation did not match; nothing was done")
  return Object.freeze({ [LIVE_BRAND]: true as const, purpose, at: new Date().toISOString() })
}

// ── Lexing: mask strings, identifiers, comments and dollar bodies ───────────

type Keep = { strings?: boolean; idents?: boolean; dollar?: boolean }

/** Same length as `sql`; masked spans become spaces (newlines kept), delimiters kept. Comments are always masked. */
export function mask(sql: string, keep: Keep = {}): string {
  const out = sql.split("")
  const blank = (a: number, b: number) => { for (let k = a; k < b; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " " }
  let i = 0
  while (i < sql.length) {
    const c = sql[i], d = sql[i + 1]
    if (c === "-" && d === "-") { const e = sql.indexOf("\n", i); const end = e === -1 ? sql.length : e; blank(i, end); i = end; continue }
    if (c === "/" && d === "*") {
      let depth = 1, j = i + 2
      while (j < sql.length && depth) { if (sql[j] === "/" && sql[j + 1] === "*") { depth++; j += 2 } else if (sql[j] === "*" && sql[j + 1] === "/") { depth--; j += 2 } else j++ }
      blank(i, j); i = j; continue
    }
    if (c === "'") {
      const escapes = i > 0 && /[eE]/.test(sql[i - 1]) && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? " ")
      let j = i + 1
      while (j < sql.length) {
        if (escapes && sql[j] === "\\") { j += 2; continue }
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue } break }
        j++
      }
      if (!keep.strings) blank(i + 1, j)
      i = j + 1; continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < sql.length) { if (sql[j] === '"') { if (sql[j + 1] === '"') { j += 2; continue } break } j++ }
      if (!keep.idents) blank(i + 1, j)
      i = j + 1; continue
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (m && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? " ")) {
        const tag = m[0], close = sql.indexOf(tag, i + tag.length)
        const end = close === -1 ? sql.length : close
        if (!keep.dollar) blank(i + tag.length, end)
        i = end + tag.length; continue
      }
    }
    i++
  }
  return out.join("")
}

/** Statement spans [start, end) split on top-level semicolons. */
function statementSpans(masked: string): [number, number][] {
  const spans: [number, number][] = []
  let start = 0
  for (let i = 0; i < masked.length; i++) if (masked[i] === ";") { spans.push([start, i]); start = i + 1 }
  if (masked.slice(start).trim()) spans.push([start, masked.length])
  return spans
}

const TX_STRIP = /^(BEGIN|COMMIT)(\s+(WORK|TRANSACTION))?$/i
const TX_REFUSE = /^(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION|COMMIT\s+PREPARED|ROLLBACK\s+PREPARED)\b/i
const SESSION_REFUSE = /^(SET|RESET)\s+(SESSION\s+|LOCAL\s+)?(search_path|SCHEMA|ROLE|SESSION\s+AUTHORIZATION|ALL)\b|^RESET\s+ALL\b|^DISCARD\b|^(CREATE|DROP|ALTER)\s+SCHEMA\b/i

export type BatchKind = "migration" | "data"
export interface Batch { readonly label: string; readonly kind: BatchKind; readonly sql: string; readonly stripped: number }

/**
 * Validate and prepare a batch. Throws a GuardError before anything runs.
 * - migration: DDL/DML as in prisma/migrations, with no path changes and no `public`.
 * - data: a pg-backup dump. Every statement must be `INSERT INTO "<Table>" (...)`
 *   (unqualified) or `SET standard_conforming_strings = on`.
 */
export function prepareBatch(label: string, kind: BatchKind, sql: string): Batch {
  const masked = mask(sql)
  const codeOnly = kind === "data" ? mask(sql, { strings: true, idents: true, dollar: true }) : ""
  let out = ""
  let last = 0, stripped = 0
  for (const [a, b] of statementSpans(masked)) {
    const head = masked.slice(a, b).trim().replace(/\s+/g, " ")
    if (!head) continue
    if (TX_STRIP.test(head)) { out += sql.slice(last, a); last = b; stripped++; continue }
    if (TX_REFUSE.test(head)) throw new GuardError(`${label}: transaction control "${head.slice(0, 40)}" is not allowed in a batch`)
    if (SESSION_REFUSE.test(head)) throw new GuardError(`${label}: "${head.slice(0, 40)}" changes the session's schema, role or state`)
    if (kind === "data") {
      const orig = codeOnly.slice(a, b).trim()
      if (!/^INSERT INTO "[^".]+" \(/.test(orig) && !/^SET\s+standard_conforming_strings\s*=\s*on$/i.test(orig))
        throw new GuardError(`${label}: a data batch may only hold unqualified INSERT INTO "<Table>" statements (found "${orig.slice(0, 40)}")`)
    }
  }
  out += sql.slice(last)
  if (kind === "migration") {
    const code = mask(sql, { strings: true, idents: true, dollar: true }) // comments masked only
    if (/search_path/i.test(code)) throw new GuardError(`${label}: mentions search_path`)
    if (/set_config\s*\(/i.test(code)) throw new GuardError(`${label}: calls set_config()`)
    if (/(^|[^A-Za-z0-9_$])"?public"?\s*\./i.test(code)) throw new GuardError(`${label}: names the public schema ("public.")`)
    if (/'public'/i.test(code)) throw new GuardError(`${label}: names the public schema as a string ('public')`)
    // Transaction control inside dollar bodies (DO blocks). Postgres refuses
    // it inside our transaction anyway; it is refused here first so the rule
    // does not depend on that.
    const inBodies = mask(sql, { dollar: true })
    for (const m of inBodies.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)?\$([\s\S]*?)\$\1\$/g)) {
      if (/\b(COMMIT|ROLLBACK)\s*(AND\s+(NO\s+)?CHAIN\s*)?;/i.test(mask(m[2]))) throw new GuardError(`${label}: COMMIT/ROLLBACK inside a dollar-quoted body`)
    }
  }
  return Object.freeze({ label, kind, sql: out, stripped })
}

// ── Pinning (rule 3) ────────────────────────────────────────────────────────

export async function assertPinned(pg: Client, schema: string, where: string) {
  const r = (await pg.query(`SELECT current_setting('search_path') AS sp, current_schema() AS cs`)).rows[0]
  if (r.cs !== schema || (r.sp !== `"${schema}"` && r.sp !== schema)) {
    throw new GuardError(`${where}: the session resolves to schema ${r.cs ?? "(none)"} (search_path ${r.sp}), not "${schema}"; rolling back`)
  }
}

// ── The backstop (rule 4) ───────────────────────────────────────────────────

export async function catalogFingerprint(pg: Client, schema: string): Promise<string> {
  return (await pg.query(`
    WITH ns AS (SELECT oid FROM pg_namespace WHERE nspname = $1)
    SELECT md5(coalesce(string_agg(x, ',' ORDER BY x), '')) AS fp FROM (
      SELECT 'c' || c.oid || ':' || c.xmin::text FROM pg_class c, ns WHERE c.relnamespace = ns.oid
      UNION ALL SELECT 't' || t.oid || ':' || t.xmin::text FROM pg_type t, ns WHERE t.typnamespace = ns.oid
      UNION ALL SELECT 'e' || e.oid || ':' || e.xmin::text FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid, ns WHERE t.typnamespace = ns.oid
      UNION ALL SELECT 'a' || a.attrelid || '.' || a.attnum || ':' || a.xmin::text FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid, ns WHERE c.relnamespace = ns.oid
      UNION ALL SELECT 'k' || k.oid || ':' || k.xmin::text FROM pg_constraint k, ns WHERE k.connamespace = ns.oid
      UNION ALL SELECT 'p' || p.oid || ':' || p.xmin::text FROM pg_proc p, ns WHERE p.pronamespace = ns.oid
      UNION ALL SELECT 'd' || d.oid || ':' || d.xmin::text FROM pg_default_acl d, ns WHERE d.defaclnamespace = ns.oid
      UNION ALL SELECT 'n' || n.oid || ':' || n.xmin::text FROM pg_namespace n, ns WHERE n.oid = ns.oid
    ) s(x)`, [schema])).rows[0].fp
}

async function protectedTouched(pg: Client, schema: string, fp0: string): Promise<string[]> {
  const why: string[] = []
  const w = Number((await pg.query(
    `SELECT coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) AS n FROM pg_stat_xact_user_tables WHERE schemaname = $1`, [schema])).rows[0].n)
  if (w) why.push(`${w} row writes in "${schema}"`)
  const locks = (await pg.query(
    `SELECT c.relname, l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
      WHERE l.pid = pg_backend_pid() AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1) AND l.mode <> 'AccessShareLock'`, [schema])).rows
  if (locks.length) why.push(`write locks in "${schema}": ${locks.map((r) => `${r.relname}/${r.mode}`).join(", ")}`)
  if ((await catalogFingerprint(pg, schema)) !== fp0) why.push(`the catalog of "${schema}" changed`)
  return why
}

// ── The guarded transaction ─────────────────────────────────────────────────

export interface GuardOptions {
  /** The schema the batches run in. */
  target: string
  /** "existing" (default), "fresh" (must not exist; created) or "replace" (dropped if present, then created). */
  create?: "existing" | "fresh" | "replace"
  /** The schema that must come out untouched. "public" unless a test names a decoy. */
  protect?: string
  /** Roll back instead of committing (drills). The guards still run. */
  commit?: boolean
  /** Required, and only accepted, when target is "public". */
  live?: LiveWriteAuthorization
  lockTimeout?: string
}

export interface Guarded {
  readonly pg: Client
  readonly target: string
  run(batch: Batch): Promise<unknown>
  /** A parameterised statement of the caller's own (bookkeeping, checks), pinned the same way. */
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>
}

export async function withGuardedTransaction<T>(pg: Client, o: GuardOptions, fn: (g: Guarded) => Promise<T>): Promise<T> {
  const target = o.target
  const protect = o.protect ?? "public"
  if (target === "public") {
    if (!o.live || (o.live as LiveWriteAuthorization)[LIVE_BRAND] !== true) throw new GuardError(`refusing to write "public" (LIVE) without a confirmed live authorization`)
  } else if (!isScratchTarget(target)) {
    throw new GuardError(`refusing target schema "${target}": only schema_v2_*, scratch_* or restore_drill`)
  }
  if (target === protect) throw new GuardError(`target "${target}" is the protected schema`)
  const guardProtected = target !== "public" // with a live authorization there is no other schema to protect

  await pg.query("BEGIN")
  try {
    if (o.lockTimeout) await pg.query(`SET LOCAL lock_timeout = '${o.lockTimeout.replace(/[^0-9a-z]/gi, "")}'`)
    const fp0 = guardProtected ? await catalogFingerprint(pg, protect) : ""
    const exists = (await pg.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [target])).rowCount
    const create = o.create ?? "existing"
    if (create === "existing" && !exists) throw new GuardError(`schema "${target}" does not exist`)
    if (create === "fresh" && exists) throw new GuardError(`schema "${target}" already exists`)
    if (create === "replace" && exists) await pg.query(`DROP SCHEMA "${target}" CASCADE`)
    if (create !== "existing") await pg.query(`CREATE SCHEMA "${target}"`)

    await pg.query(`SET search_path TO "${target}"`) // SESSION level: a COMMIT cannot end it
    await assertPinned(pg, target, "after pinning")

    const g: Guarded = {
      pg, target,
      async run(batch) {
        await assertPinned(pg, target, `before ${batch.label}`)
        const r = await pg.query(batch.sql)
        await assertPinned(pg, target, `after ${batch.label}`)
        return r
      },
      async query(sql, params) {
        const r = await pg.query(sql, params)
        await assertPinned(pg, target, "after a pinned query")
        return r
      },
    }
    const result = await fn(g)

    await assertPinned(pg, target, "before commit")
    if (guardProtected) {
      const why = await protectedTouched(pg, protect, fp0)
      if (why.length) throw new GuardError(`the protected schema "${protect}" was touched (${why.join("; ")}); rolling back`)
    }
    await pg.query(o.commit === false ? "ROLLBACK" : "COMMIT")
    return result
  } catch (e) {
    await pg.query("ROLLBACK").catch(() => {})
    throw e
  } finally {
    await pg.query(`RESET search_path`).catch(() => {})
  }
}

// ── Migration files ─────────────────────────────────────────────────────────

export interface MigrationFile { name: string; batch: Batch; checksum: string }

/** The pre-v2 catalog-by-name checks, scoped to current_schema(); unknown lookups refuse. */
export function scopeCatalogChecks(label: string, ddl: string): string {
  const scoped = ddl
    .replace(/(FROM\s+pg_type\s+WHERE\s+typname\s*=\s*'[^']+')/gi, "$1 AND typnamespace = current_schema()::regnamespace")
    .replace(/(FROM\s+pg_constraint\s+WHERE\s+conname\s*=\s*'[^']+')/gi, "$1 AND connamespace = current_schema()::regnamespace")
    .replace(/(FROM\s+information_schema\.table_constraints\s+WHERE\s+constraint_name\s*=\s*'[^']+')/gi, "$1 AND constraint_schema = current_schema()")
  const lookups = mask(scoped, { strings: true, idents: true, dollar: true })
    .match(/FROM\s+(pg_type|pg_constraint|pg_class|pg_enum|pg_namespace|information_schema\.\w+)\b[^;]*/gi) ?? []
  const unscoped = lookups.filter((l) => !/current_schema\(\)/.test(l))
  if (unscoped.length) throw new GuardError(`${label}: catalog lookup not scoped to the target schema: ${unscoped[0].replace(/\s+/g, " ").slice(0, 120)}`)
  return scoped
}

/**
 * Prisma's checksum is SHA-256 of the file. It is taken over LF line endings
 * (the bytes git stores), so a CRLF checkout on Windows records the same
 * checksum live already holds for the 27 pre-v2 rows.
 */
export function prismaChecksum(buf: Buffer): string {
  return createHash("sha256").update(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8").digest("hex")
}

export async function loadMigration(name: string): Promise<MigrationFile> {
  const buf = await readFile(new URL(`${name}/migration.sql`, MIGRATIONS_DIR))
  // The baseline's CREATE SCHEMA "public" is the only schema statement in the chain.
  const sql = scopeCatalogChecks(name, buf.toString("utf8").replace(/^\s*CREATE SCHEMA IF NOT EXISTS "public";\s*$/gim, ""))
  return { name, batch: prepareBatch(name, "migration", sql), checksum: prismaChecksum(buf) }
}

export async function localMigrationNames(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()
}

/** The pre-v2 chain: every local migration that is not a v2 one. */
export async function preV2Chain(): Promise<MigrationFile[]> {
  const v2 = new Set<string>(V2_MIGRATIONS)
  return Promise.all((await localMigrationNames()).filter((n) => !v2.has(n)).map(loadMigration))
}

export async function v2Chain(): Promise<MigrationFile[]> {
  return Promise.all(V2_MIGRATIONS.map(loadMigration))
}

// ── The cutover method: all six v2 migrations in ONE transaction ────────────

export interface ApplyV2Options {
  /** Rehearsal only: sleep inside the transaction after migration N (1-based), so a kill lands mid-run. */
  sleepAfter?: number
  sleepSecs?: number
  log?: (line: string) => void
}

/**
 * Run inside withGuardedTransaction(). It takes Prisma's migrate lock, locks
 * every table NOWAIT (proof that no app is mid-work), refuses if any v2
 * migration is already recorded, runs the six migrations, writes their six
 * `_prisma_migrations` rows exactly as `prisma migrate deploy` writes them,
 * and re-checks the table count and the Leaves ledger before returning. The
 * caller's commit is then the only commit.
 */
export async function applyV2InTransaction(g: Guarded, o: ApplyV2Options = {}) {
  const log = o.log ?? ((l: string) => console.log(l))
  const files = await v2Chain()
  const t0 = Date.now()
  await g.query(`SELECT pg_advisory_xact_lock($1)`, [PRISMA_MIGRATE_LOCK_KEY])
  if (!(await g.query(`SELECT to_regclass('"_prisma_migrations"') IS NOT NULL AS ok`)).rows[0].ok)
    throw new GuardError(`no _prisma_migrations in "${g.target}"`)
  const done = (await g.query(`SELECT migration_name FROM "_prisma_migrations" WHERE migration_name = ANY($1) AND rolled_back_at IS NULL`, [[...V2_MIGRATIONS]])).rows
  if (done.length) throw new GuardError(`already recorded in _prisma_migrations: ${done.map((r) => r.migration_name).join(", ")}`)
  const tables = (await g.query(`SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY 1`, [g.target])).rows.map((r) => String(r.tablename))
  await g.query(`LOCK TABLE ${tables.map((t) => `"${t}"`).join(", ")} IN ACCESS EXCLUSIVE MODE NOWAIT`)
  log(`  locked ${tables.length} tables NOWAIT, migrate lock held`)

  for (let i = 0; i < files.length; i++) {
    const f = files[i], t = Date.now()
    const started = (await g.query(`SELECT clock_timestamp() AS t`)).rows[0].t
    await g.run(f.batch)
    await g.query(
      `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
       VALUES ($1, $2, clock_timestamp(), $3, NULL, NULL, $4, 1)`, [randomUUID(), f.checksum, f.name, started])
    log(`  applied ${f.name} (${Date.now() - t} ms)`)
    if (o.sleepAfter === i + 1) {
      log(`  sleeping ${o.sleepSecs ?? 30}s inside the transaction (kill window)`)
      await g.query(`SELECT pg_sleep($1)`, [o.sleepSecs ?? 30])
    }
  }

  const n = Number((await g.query(`SELECT count(*) AS n FROM pg_tables WHERE schemaname = $1 AND tablename <> '_prisma_migrations'`, [g.target])).rows[0].n)
  if (n !== 25) throw new GuardError(`expected 25 tables after v2, found ${n}`)
  const inv = judge(figuresFromRow((await g.query(LEDGER_INVARIANT_SQL(g.target, "v2"))).rows[0] as Record<string, string>))
  if (!inv.ok) throw new GuardError(`ledger invariant fails after v2: ${inv.lines.join("; ")}`)
  log(`  25 tables; ${inv.lines.join("; ")}`)
  return { ms: Date.now() - t0, ledger: inv }
}
