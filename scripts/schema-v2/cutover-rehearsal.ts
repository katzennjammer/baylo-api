// Cutover rehearsal tooling for schema v2 (Stage 1: scratch only).
//
//   npx tsx --env-file=.env scripts/schema-v2/cutover-rehearsal.ts <command> [...]
//
//   target                                  print where DATABASE_URL points; touch nothing
//   inspect-live                            READ-ONLY report on live `public` (see below)
//   counts --schema S [--backup F]          per-table counts in S vs live public (and vs F's trailer)
//   restore-old F --schema S [--replace]    S := backup F in the PRE-v2 structure, plus
//                                           _prisma_migrations copied from live (read)
//   apply-single --schema S [--sleep-after N --sleep-secs K]
//                                           all six v2 migrations AND their _prisma_migrations
//                                           rows in ONE transaction (the proposed cutover shape)
//   apply-perfile --schema S [--sleep-after N --sleep-secs K]
//                                           the six as six transactions, the way
//                                           `prisma migrate deploy` runs them
//   kill --schema S --after-secs K          terminate the backend running in S after K s
//   state --schema S                        which layout S is in: old / new / HALF
//   rollback F --schema S                   restore backup F OVER S (whatever layout it is in),
//                                           in one transaction, timed
//   drop --schema S                         drop a schema_v2_cut* rehearsal schema
//
// SAFETY. Every write command refuses a schema that is not schema_v2_cut*,
// so it can never name `public` or the week-2 copy schema_v2_wk1. Every
// statement it runs is unqualified and goes through an explicit
// `SET search_path TO "<S>"`, the build-scratch.ts mechanism. inspect-live and
// counts open their session with default_transaction_read_only=on, so Postgres
// itself refuses a write there. Each command prints its target first.
import { Client, types } from "pg"
import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { LEDGER_INVARIANT_SQL, figuresFromRow, judge } from "../lib/ledger-invariant"

for (const oid of [1082, 1114, 1083, 1184]) types.setTypeParser(oid, (v) => v)
types.setTypeParser(20, (v) => v)
types.setTypeParser(1700, (v) => v)

const V2 = [
  "20261003000000_schema_v2_core", "20261003000001_schema_v2_ledger", "20261003000002_schema_v2_trade",
  "20261004000000_schema_v2_audit_fixes", "20261004000001_schema_v2_trade_completed_backfill",
  "20261004000002_schema_v2_drop_trade_hidden",
]
const TRAILER = "-- Baylo data dump complete"
const MIG = new URL("../../prisma/migrations/", import.meta.url)

const argv = process.argv.slice(2)
const cmd = argv[0]
const opt = (name: string) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1] }
const flag = (name: string) => argv.includes(name)
const positional = argv[1] && !argv[1].startsWith("--") ? argv[1] : undefined

function baseUrl(): URL {
  const raw = process.env.DATABASE_URL
  if (!raw?.startsWith("postgres")) { console.error("DATABASE_URL is not a Postgres URL"); process.exit(2) }
  const u = new URL(raw)
  u.searchParams.delete("schema") // irrelevant to pg; search_path is set explicitly
  return u
}

function printTarget(schema: string, mode: "READ-ONLY" | "WRITE") {
  const u = baseUrl()
  console.log(`  target  host=${u.hostname}:${u.port || 5432}  database=${u.pathname.slice(1)}  user=${decodeURIComponent(u.username)}`)
  console.log(`          schema=${schema}  mode=${mode}`)
}

function writableSchema(): string {
  const s = opt("--schema") ?? ""
  if (!/^schema_v2_cut[a-z0-9_]*$/.test(s)) {
    console.error(`  REFUSING: write commands only touch schema_v2_cut* rehearsal schemas (got "${s || "none = public = LIVE"}")`)
    process.exit(2)
  }
  printTarget(s, "WRITE")
  return s
}

async function connect(readOnly: boolean): Promise<Client> {
  // NOT the `options: "-c default_transaction_read_only=on"` startup
  // parameter: the Supavisor session pooler silently drops it (measured
  // 4 Oct 2026; it does forward search_path). A SET after connect is honoured,
  // and is asserted rather than assumed.
  const c = new Client({ connectionString: baseUrl().toString() })
  await c.connect()
  if (readOnly) {
    await c.query(`SET SESSION default_transaction_read_only = on`)
    const ro = (await c.query(`SHOW default_transaction_read_only`)).rows[0].default_transaction_read_only
    if (ro !== "on") { await c.end(); console.error("  could not make the session read-only; refusing"); process.exit(1) }
  }
  return c
}

// ── SQL sources ─────────────────────────────────────────────────────────────

function scopeCatalogChecks(ddl: string): string {
  const scoped = ddl
    .replace(/(FROM\s+pg_type\s+WHERE\s+typname\s*=\s*'[^']+')/gi, "$1 AND typnamespace = current_schema()::regnamespace")
    .replace(/(FROM\s+pg_constraint\s+WHERE\s+conname\s*=\s*'[^']+')/gi, "$1 AND connamespace = current_schema()::regnamespace")
    .replace(/(FROM\s+information_schema\.table_constraints\s+WHERE\s+constraint_name\s*=\s*'[^']+')/gi, "$1 AND constraint_schema = current_schema()")
  const lookups = scoped.match(/FROM\s+(pg_type|pg_constraint|pg_class|pg_enum|pg_namespace|information_schema\.\w+)\b[^;]*/gi) ?? []
  const unscoped = lookups.filter((l) => !/current_schema\(\)/.test(l))
  if (unscoped.length) { for (const l of unscoped) console.error(`  unscoped catalog lookup: ${l.slice(0, 140)}`); process.exit(1) }
  return scoped
}

async function oldChain(): Promise<{ names: string[]; ddl: string }> {
  const names = (await readdir(MIG, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && !V2.includes(d.name)).map((d) => d.name).sort()
  let ddl = ""
  for (const d of names) {
    const body = await readFile(new URL(`${d}/migration.sql`, MIG), "utf8")
    ddl += body.replace(/^\s*CREATE SCHEMA IF NOT EXISTS "public";\s*$/gim, "") + "\n"
  }
  // 20260925000003_drop_removed_roles carries its own BEGIN; ... COMMIT;. Run
  // inside an outer transaction, that COMMIT ends the outer one early, and on
  // 4 Oct 2026 it also ended a SET LOCAL search_path, so the rest of the chain
  // resolved to public (LIVE). It failed harmlessly on its first statement. The
  // pair is redundant inside our own transaction, so it is stripped, and any
  // transaction control still left stops the run.
  ddl = ddl.replace(/^\s*(BEGIN|COMMIT);\s*$/gim, "")
  if (/^\s*(BEGIN|COMMIT|ROLLBACK|END|START\s+TRANSACTION|SAVEPOINT|RELEASE)\b[^;]*;/im.test(ddl.replace(/\$\$[\s\S]*?\$\$/g, ""))) {
    console.error("  the pre-v2 chain still contains transaction control after stripping; refusing"); process.exit(1)
  }
  return { names, ddl: scopeCatalogChecks(ddl) }
}

/** Session-level (never SET LOCAL: a COMMIT would end it) and asserted. */
async function pinSchema(pg: Client, s: string) {
  await pg.query(`SET search_path TO "${s}"`)
  await assertPinned(pg, s)
}
async function assertPinned(pg: Client, s: string) {
  const sp = (await pg.query(`SELECT current_setting('search_path') sp`)).rows[0].sp
  if (sp !== `"${s}"` && sp !== s) throw new Error(`search_path is ${sp}, not ${s}; stopping`)
}

async function v2File(name: string): Promise<{ sql: string; checksum: string }> {
  const buf = await readFile(new URL(`${name}/migration.sql`, MIG))
  const sql = buf.toString("utf8")
  const code = sql.replace(/--.*$/gm, "")
  if (/\bpublic\s*\./i.test(code) || /search_path/i.test(code)) { console.error(`${name} names public; refusing`); process.exit(1) }
  // Prisma's checksum: SHA-256 hex of the file bytes as read (validated
  // against live's recorded checksums by `restore-old`).
  return { sql, checksum: createHash("sha256").update(buf).digest("hex") }
}

async function readBackup(file: string): Promise<string> {
  if (!existsSync(file)) { console.error(`no such file: ${file}`); process.exit(2) }
  const dump = await readFile(file, "utf8")
  if (!dump.includes(TRAILER)) { console.error("backup has no trailer; it is truncated"); process.exit(1) }
  return dump
}

const PRISMA_MIGRATIONS_DDL = `CREATE TABLE "_prisma_migrations" (
  "id" VARCHAR(36) PRIMARY KEY NOT NULL, "checksum" VARCHAR(64) NOT NULL, "finished_at" TIMESTAMPTZ,
  "migration_name" VARCHAR(255) NOT NULL, "logs" TEXT, "rolled_back_at" TIMESTAMPTZ,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "applied_steps_count" INTEGER NOT NULL DEFAULT 0)`

// ── commands ────────────────────────────────────────────────────────────────

async function tableCounts(pg: Client, schema: string) {
  const tables = (await pg.query(`SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename <> '_prisma_migrations' ORDER BY 1`, [schema])).rows.map((r) => r.tablename as string)
  const out: Record<string, number> = {}
  for (const t of tables) out[t] = Number((await pg.query(`SELECT count(*) n FROM "${schema}"."${t}"`)).rows[0].n)
  return out
}

async function invariantOf(pg: Client, schema: string) {
  const v2 = (await pg.query(`SELECT to_regclass($1) IS NOT NULL AS v2`, [`"${schema}"."Trade"`])).rows[0].v2
  return judge(figuresFromRow((await pg.query(LEDGER_INVARIANT_SQL(schema, v2 ? "v2" : "v1"))).rows[0]))
}

async function inspectLive() {
  printTarget("public (LIVE)", "READ-ONLY")
  const pg = await connect(true)
  const q = async (sql: string, p: unknown[] = []) => (await pg.query(sql, p)).rows
  try {
    console.log(`  session read-only: ${(await q(`SHOW default_transaction_read_only`))[0].default_transaction_read_only} (asserted)`)
    const live = await tableCounts(pg, "public")
    console.log(`\n== live public: ${Object.keys(live).length} tables, ${Object.values(live).reduce((a, b) => a + b, 0)} rows`)
    console.log("  " + Object.entries(live).map(([t, n]) => `${t}=${n}`).join(" "))
    console.log(`  ledger: ${(await invariantOf(pg, "public")).lines.join("; ")}`)

    console.log("\n== migration preconditions (each v2 migration refuses if violated)")
    const one = async (sql: string) => Number(Object.values((await q(sql))[0])[0])
    console.log(`  TradeRequest hidden (hiddenBySender OR hiddenByReceiver): ${await one(`SELECT count(*) FROM public."TradeRequest" WHERE "hiddenBySender" OR "hiddenByReceiver"`)}`)
    console.log(`  CommentLike rows: ${await one(`SELECT count(*) FROM public."CommentLike"`)}   ConversationHide rows: ${await one(`SELECT count(*) FROM public."ConversationHide"`)}`)
    console.log(`  DeferredContract not FULFILLED: ${await one(`SELECT count(*) FROM public."DeferredContract" WHERE status::text <> 'FULFILLED'`)}`)
    console.log(`  COMPLETED TradeRequest with completedAt NULL (backfill set): ${await one(`SELECT count(*) FROM public."TradeRequest" WHERE status = 'COMPLETED' AND "completedAt" IS NULL`)}`)
    console.log(`  orgs without exactly one ACTIVE OWNER: ${await one(`SELECT count(*) FROM public."Organization" g WHERE (SELECT count(*) FROM public."OrganizationMember" m WHERE m."organizationId" = g.id AND m.role = 'OWNER' AND m.status = 'ACTIVE') <> 1`)}`)
    console.log(`  live item boosts (isFeatured or featuredUntil > now): ${await one(`SELECT count(*) FROM public."Item" WHERE "isFeatured" OR "featuredUntil" > now()`)}`)

    console.log("\n== pg_stat_activity (who is connected to this database)")
    for (const r of await q(`SELECT pid, usename, application_name, client_addr::text, state, backend_type,
        to_char(backend_start, 'MM-DD HH24:MI') started, to_char(state_change, 'MM-DD HH24:MI') changed, left(regexp_replace(query, '\\s+', ' ', 'g'), 70) query
        FROM pg_stat_activity WHERE datname = current_database() ORDER BY usename, backend_start`))
      console.log(`  ${String(r.pid).padStart(7)} ${String(r.usename).padEnd(22)} ${String(r.application_name || "-").padEnd(28)} ${String(r.state || "-").padEnd(20)} ${r.started}  ${r.pid === undefined ? "" : r.query}`)
    for (const r of await q(`SELECT usename, application_name, count(*) n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() GROUP BY 1,2 ORDER BY 3 DESC`))
      console.log(`  summary: ${r.n} x ${r.usename} / ${r.application_name || "(none)"}`)

    // Tables v2 drops or renames, plus every table v2 rewrites in place.
    const affected = ["Offer", "TradeRequest", "TaskCompletion", "RefreshToken", "PasswordResetToken", "EmailVerificationToken",
      "Report", "ListingAppeal", "OrganizationMember", "QuestAssignment", "UserAchievement", "ItemImageHash", "SwapConfirmationCode",
      "PostLike", "PostComment", "CommentLike", "ConversationHide", "DeferredContract", "Item", "LeafTransaction", "Organization",
      "AdminAction", "Notification", "Message", "Review"]
    console.log("\n== Supabase objects that could reference affected tables")
    console.log(`  RLS enabled on public tables: ${(await q(`SELECT string_agg(relname, ', ') s FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relrowsecurity`))[0].s ?? "none"}`)
    const pol = await q(`SELECT schemaname, tablename, policyname, cmd, roles::text FROM pg_policies ORDER BY 1,2`)
    console.log(`  pg_policies (all schemas): ${pol.length}`)
    for (const r of pol) console.log(`    ${r.schemaname}.${r.tablename} ${r.policyname} ${r.cmd} ${r.roles}${affected.includes(r.tablename) ? "   <-- AFFECTED" : ""}`)
    const views = await q(`SELECT n.nspname s, c.relname v, c.relkind k FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('v','m') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%' ORDER BY 1,2`)
    const viewDeps = await q(`SELECT DISTINCT vn.nspname vs, v.relname vname, tn.nspname ts, t.relname tname
      FROM pg_depend d JOIN pg_rewrite rw ON rw.oid = d.objid JOIN pg_class v ON v.oid = rw.ev_class JOIN pg_namespace vn ON vn.oid = v.relnamespace
      JOIN pg_class t ON t.oid = d.refobjid JOIN pg_namespace tn ON tn.oid = t.relnamespace
      WHERE tn.nspname = 'public' AND v.oid <> t.oid`)
    console.log(`  views/matviews outside system schemas: ${views.length} (${views.filter((v) => !["auth", "storage", "realtime", "extensions", "graphql", "graphql_public", "vault", "pgsodium", "supabase_functions", "net", "cron"].includes(v.s)).map((v) => `${v.s}.${v.v}`).join(", ") || "none outside Supabase-managed schemas"})`)
    console.log(`  views depending on a public table: ${viewDeps.length ? viewDeps.map((r) => `${r.vs}.${r.vname} -> ${r.tname}`).join(", ") : "none"}`)
    const funcs = await q(`SELECT n.nspname s, p.proname f, pg_get_functiondef(p.oid) def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind IN ('f','p')`)
    console.log(`  functions/procedures in public: ${funcs.length}`)
    for (const f of funcs) {
      const hits = affected.filter((t) => new RegExp(`\\b${t}\\b`).test(f.def))
      console.log(`    public.${f.f}${hits.length ? `   <-- mentions ${hits.join(", ")}` : ""}`)
    }
    const otherFuncs = await q(`SELECT n.nspname s, p.proname f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema','public') AND n.nspname NOT LIKE 'pg_%' AND n.nspname NOT LIKE 'schema_v2_%'
        AND p.prokind IN ('f','p') AND p.prolang <> (SELECT oid FROM pg_language WHERE lanname = 'c')
        AND (${affected.map((t) => `p.prosrc ~ '\\m${t}\\M'`).join(" OR ")})`)
    console.log(`  functions in other schemas mentioning an affected table name: ${otherFuncs.length ? otherFuncs.map((r) => `${r.s}.${r.f}`).join(", ") : "none"}`)
    const trg = await q(`SELECT c.relname t, tg.tgname g FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid WHERE c.relnamespace = 'public'::regnamespace AND NOT tg.tgisinternal ORDER BY 1`)
    console.log(`  user triggers on public tables: ${trg.length ? trg.map((r) => `${r.t}.${r.g}`).join(", ") : "none"}`)
    const evt = await q(`SELECT evtname, evtevent, evtenabled FROM pg_event_trigger ORDER BY 1`)
    console.log(`  event triggers (database-wide, fire on DDL): ${evt.map((r) => `${r.evtname}[${r.evtevent},${r.evtenabled}]`).join(", ") || "none"}`)
    const pubs = await q(`SELECT pubname, puballtables FROM pg_publication ORDER BY 1`)
    console.log(`  publications: ${pubs.map((r) => `${r.pubname}${r.puballtables ? " (ALL TABLES)" : ""}`).join(", ") || "none"}`)
    const pubt = await q(`SELECT pubname, schemaname, tablename FROM pg_publication_tables ORDER BY 1,2,3`)
    console.log(`  publication tables: ${pubt.length ? pubt.map((r) => `${r.pubname}:${r.schemaname}.${r.tablename}`).join(", ") : "none"}`)
    const ext = await q(`SELECT extname, n.nspname s FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace ORDER BY 1`)
    console.log(`  extensions: ${ext.map((r) => `${r.extname}@${r.s}`).join(", ")}`)
    const grants = await q(`SELECT grantee, string_agg(DISTINCT privilege_type, ',') p, count(DISTINCT table_name) n FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND grantee IN ('anon','authenticated','service_role') GROUP BY 1`)
    console.log(`  PostgREST role grants on public tables: ${grants.map((r) => `${r.grantee} ${r.p} on ${r.n} tables`).join("; ") || "none"}`)
    const defacl = await q(`SELECT pg_get_userbyid(defaclrole) owner, defaclobjtype t, defaclacl::text acl FROM pg_default_acl WHERE defaclnamespace = 'public'::regnamespace`)
    console.log(`  default ACLs in public (grants new tables get): ${defacl.map((r) => `${r.owner}/${r.t}: ${r.acl}`).join(" | ") || "none"}`)
    const scratch = await q(`SELECT schema_name FROM information_schema.schemata WHERE schema_name ~ '^(schema_v2_|scratch_|restore_drill)' ORDER BY 1`)
    console.log(`  scratch schemas on this server: ${scratch.map((r) => r.schema_name).join(", ") || "none"}`)

    console.log("\n== live _prisma_migrations")
    const migs = await q(`SELECT migration_name, checksum, finished_at IS NOT NULL done, rolled_back_at IS NOT NULL rb, applied_steps_count steps FROM public."_prisma_migrations" ORDER BY started_at, migration_name`)
    const local = (await readdir(MIG, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    console.log(`  rows: ${migs.length}; finished: ${migs.filter((m) => m.done && !m.rb).length}; failed/unfinished: ${migs.filter((m) => !m.done && !m.rb).length}; rolled back: ${migs.filter((m) => m.rb).length}`)
    const names = new Set(migs.filter((m) => m.done && !m.rb).map((m) => m.migration_name))
    const notLocal = [...new Set(migs.map((m) => m.migration_name))].filter((n) => !local.includes(n))
    const pending = local.filter((n) => !names.has(n))
    console.log(`  recorded on live but NOT in this branch's prisma/migrations: ${notLocal.join(", ") || "none"}`)
    console.log(`  in this branch but NOT applied on live (what deploy would run): ${pending.join(", ") || "none"}`)
    let mism = 0
    for (const m of migs.filter((x) => x.done && local.includes(x.migration_name))) {
      const buf = await readFile(new URL(`${m.migration_name}/migration.sql`, MIG))
      const sum = createHash("sha256").update(buf).digest("hex")
      if (sum !== m.checksum) { mism++; console.log(`  CHECKSUM DIFFERS: ${m.migration_name} live=${m.checksum.slice(0, 12)} file=${sum.slice(0, 12)}`) }
    }
    console.log(`  checksum of each applied migration vs this branch's file: ${mism} differ`)
    for (const m of migs.filter((x) => !x.done || x.rb)) console.log(`  non-clean row: ${m.migration_name} done=${m.done} rolledBack=${m.rb}`)
  } finally { await pg.end() }
}

async function counts() {
  const s = opt("--schema") ?? ""
  if (!/^schema_v2_[a-z0-9_]+$/.test(s)) { console.error("counts needs --schema schema_v2_*"); process.exit(2) }
  printTarget(`${s} vs public (LIVE)`, "READ-ONLY")
  const pg = await connect(true)
  try {
    const a = await tableCounts(pg, s), live = await tableCounts(pg, "public")
    let claimed: Record<string, number> | undefined
    const f = opt("--backup")
    if (f) claimed = Object.fromEntries(((/-- rowcounts: (.*)/.exec(await readBackup(f)))?.[1] ?? "").split(/\s+/).filter(Boolean).map((p) => { const [t, n] = p.split("="); return [t, Number(n)] }))
    const all = [...new Set([...Object.keys(live), ...Object.keys(a)])].sort()
    let liveDiff = 0, fileDiff = 0
    console.log(`  ${"table".padEnd(24)} ${"live".padStart(6)} ${s.padStart(20)}${claimed ? "   backup" : ""}`)
    for (const t of all) {
      const l = live[t], x = a[t], c = claimed?.[t]
      if (l !== x) liveDiff++
      if (claimed && c !== x) fileDiff++
      console.log(`  ${t.padEnd(24)} ${String(l ?? "-").padStart(6)} ${String(x ?? "-").padStart(20)}${claimed ? String(c ?? "-").padStart(9) : ""}${l !== x ? "   <-- differs from live" : ""}${claimed && c !== x ? "   <-- differs from backup" : ""}`)
    }
    console.log(`  tables: live ${Object.keys(live).length}, ${s} ${Object.keys(a).length}; differ from live: ${liveDiff}${claimed ? `; differ from backup: ${fileDiff}` : ""}`)
    console.log(`  ${s} ledger: ${(await invariantOf(pg, s)).lines.join("; ")}`)
    console.log(`  live ledger: ${(await invariantOf(pg, "public")).lines.join("; ")}`)
    if (liveDiff || fileDiff) process.exitCode = 1
  } finally { await pg.end() }
}

async function liveMigrationRows(): Promise<Record<string, unknown>[]> {
  const ro = await connect(true)
  try {
    return (await ro.query(`SELECT * FROM public."_prisma_migrations" ORDER BY started_at`)).rows
  } finally { await ro.end() }
}

async function restoreOld() {
  const s = writableSchema()
  const file = positional ?? ""
  const dump = await readBackup(file)
  const { names, ddl } = await oldChain()
  const rows = await liveMigrationRows() // READ from live, written only into s
  const pg = await connect(false)
  try {
    const exists = (await pg.query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [s])).rowCount
    if (exists && !flag("--replace")) { console.error(`schema "${s}" exists; pass --replace`); process.exit(1) }
    const t0 = Date.now()
    await pg.query("BEGIN")
    if (exists) await pg.query(`DROP SCHEMA "${s}" CASCADE`)
    await pg.query(`CREATE SCHEMA "${s}"`)
    await pinSchema(pg, s)
    await pg.query(ddl)
    await assertPinned(pg, s)
    await pg.query(dump.replace(/^\s*(BEGIN|COMMIT);\s*$/gim, "")) // already inside our transaction
    await assertPinned(pg, s)
    await pg.query(PRISMA_MIGRATIONS_DDL)
    for (const r of rows) {
      const cols = Object.keys(r)
      await pg.query(`INSERT INTO "_prisma_migrations" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, cols.map((c) => r[c]))
    }
    await pg.query("COMMIT")
    const n = (await pg.query(`SELECT count(*)::int n FROM pg_tables WHERE schemaname = $1`, [s])).rows[0].n
    console.log(`  "${s}": pre-v2 structure from ${names.length} migrations, backup restored, ${rows.length} live _prisma_migrations rows copied; ${n} tables incl. _prisma_migrations (${Date.now() - t0} ms)`)
  } catch (e) { await pg.query("ROLLBACK").catch(() => {}); throw e } finally { await pg.end() }
}

async function apply(single: boolean) {
  const s = writableSchema()
  const sleepAfter = opt("--sleep-after"), sleepSecs = Number(opt("--sleep-secs") ?? 0)
  const files = await Promise.all(V2.map(v2File))
  const pg = await connect(false)
  const pid = (await pg.query(`SELECT pg_backend_pid() p`)).rows[0].p
  console.log(`  backend pid ${pid}; mode ${single ? "ONE transaction for all six + bookkeeping" : "six transactions (migrate deploy shape)"}`)
  const t0 = Date.now()
  try {
    await pinSchema(pg, s)
    if (single) await pg.query("BEGIN")
    for (let i = 0; i < V2.length; i++) {
      const t = Date.now()
      const id = randomUUID()
      if (!single) await pg.query(`INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, applied_steps_count) VALUES ($1, $2, $3, now(), 0)`, [id, files[i].checksum, V2[i]])
      const killHere = sleepAfter === V2[i] || sleepAfter === String(i + 1)
      // The kill window sits INSIDE this migration's own transaction (appended
      // to the same multi-statement string), so a kill lands mid-migration.
      if (killHere) console.log(`  ${V2[i]}: running with a ${sleepSecs}s sleep after its last statement (kill window)`)
      await pg.query(files[i].sql + (killHere ? `
;SELECT pg_sleep(${sleepSecs});` : "")) // implicit transaction when not inside BEGIN
      if (single) await pg.query(`INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, finished_at, applied_steps_count) VALUES ($1, $2, $3, now(), clock_timestamp(), 1)`, [id, files[i].checksum, V2[i]])
      else await pg.query(`UPDATE "_prisma_migrations" SET finished_at = now(), applied_steps_count = 1 WHERE id = $1`, [id])
      await assertPinned(pg, s)
      console.log(`  applied ${V2[i]} (${Date.now() - t} ms)`)
    }
    if (single) await pg.query("COMMIT")
    console.log(`  DONE in ${Date.now() - t0} ms`)
  } catch (e) {
    console.log(`  ABORTED after ${Date.now() - t0} ms: ${(e as Error).message}`)
    process.exitCode = 1
  } finally { await pg.end().catch(() => {}) }
}

async function kill() {
  const s = writableSchema()
  const after = Number(opt("--after-secs") ?? 5)
  const pg = await connect(false)
  try {
    const deadline = Date.now() + 120_000
    await new Promise((r) => setTimeout(r, after * 1000))
    while (Date.now() < deadline) {
      // Only a backend whose search_path is this rehearsal schema and that is
      // running pg_sleep: never anything else on the server.
      const r = (await pg.query(`SELECT pid, query FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active' AND wait_event = 'PgSleep'`)).rows
      const mine = []
      for (const x of r) {
        // the sleeping backend is in a transaction that touched s; confirm via its locks
        const locks = (await pg.query(`SELECT count(*)::int n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE l.pid = $1 AND c.relnamespace = $2::regnamespace`, [x.pid, s])).rows[0].n
        if (locks > 0) mine.push(x.pid)
      }
      if (mine.length === 1) {
        const ok = (await pg.query(`SELECT pg_terminate_backend($1) ok`, [mine[0]])).rows[0].ok
        console.log(`  terminated backend ${mine[0]} (holding locks in ${s}) mid-run: ${ok}`)
        return
      }
      if (mine.length > 1) { console.error(`  ${mine.length} candidate backends; refusing to guess`); process.exit(1) }
      await new Promise((r) => setTimeout(r, 1000))
    }
    console.error("  no sleeping backend found within 120 s")
    process.exitCode = 1
  } finally { await pg.end() }
}

async function state() {
  const s = opt("--schema") ?? ""
  if (!/^schema_v2_[a-z0-9_]+$/.test(s)) { console.error("state needs --schema schema_v2_*"); process.exit(2) }
  printTarget(s, "READ-ONLY")
  const pg = await connect(true)
  try {
    const t = new Set((await pg.query(`SELECT tablename FROM pg_tables WHERE schemaname = $1`, [s])).rows.map((r) => r.tablename))
    const markers: [string, boolean, boolean][] = [ // [what, present in OLD, present in NEW]
      ["RefreshToken", true, false], ["AuthToken", false, true], ["TaskCompletion", true, false],
      ["Offer", true, false], ["TradeRequest", true, false], ["Trade", false, true], ["ItemImage", false, true],
    ]
    const cols = async (tbl: string, c: string) => (await pg.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`, [s, tbl, c])).rowCount! > 0
    const hidden = t.has("Trade") ? await cols("Trade", "hiddenBySender") : null
    const ltIdx = (await pg.query(`SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = 'LeafTransaction_userId_idx'`, [s])).rowCount! > 0
    let oldHits = 0, newHits = 0
    for (const [m, o, n] of markers) { const p = t.has(m); if (p === o) oldHits++; if (p === n) newHits++; console.log(`  ${m.padEnd(16)} ${p ? "present" : "absent"}`) }
    console.log(`  Trade.hiddenBySender ${hidden === null ? "n/a" : hidden ? "present" : "absent"}; LeafTransaction_userId_idx ${ltIdx ? "present" : "absent"}`)
    const migs = t.has("_prisma_migrations") ? (await pg.query(`SELECT migration_name FROM "${s}"."_prisma_migrations" WHERE migration_name LIKE '%schema_v2%' AND finished_at IS NOT NULL ORDER BY 1`)).rows.map((r) => r.migration_name) : []
    console.log(`  v2 rows in _prisma_migrations: ${migs.length} ${migs.join(", ")}`)
    const tables = [...t].filter((x) => x !== "_prisma_migrations").length
    const verdict = oldHits === markers.length && migs.length === 0 && tables === 34 ? "FULLY OLD (34 tables, no v2 bookkeeping)"
      : newHits === markers.length && hidden === false && !ltIdx && migs.length === 6 && tables === 25 ? "FULLY NEW (25 tables, 6 v2 rows)"
      : `HALF-MIGRATED (${tables} tables, ${migs.length} v2 rows)`
    console.log(`  VERDICT: ${verdict}`)
    console.log(`  ledger: ${(await invariantOf(pg, s)).lines.join("; ")}`)
  } finally { await pg.end() }
}

async function rollback() {
  const s = writableSchema()
  const file = positional ?? ""
  const dump = await readBackup(file)
  const { ddl } = await oldChain()
  const pg = await connect(false)
  try {
    const t0 = Date.now()
    await pg.query("BEGIN")
    await pinSchema(pg, s)
    // Drop every application object in s but keep _prisma_migrations: on live,
    // public itself (its grants, default ACLs, extensions' references) must
    // survive, so the rollback empties the schema rather than dropping it.
    const tables = (await pg.query(`SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename <> '_prisma_migrations'`, [s])).rows.map((r) => r.tablename)
    if (tables.length) await pg.query(`DROP TABLE ${tables.map((x) => `"${x}"`).join(", ")} CASCADE`)
    const enums = (await pg.query(`SELECT typname FROM pg_type WHERE typnamespace = $1::regnamespace AND typtype = 'e'`, [s])).rows.map((r) => r.typname)
    if (enums.length) await pg.query(`DROP TYPE ${enums.map((x) => `"${x}"`).join(", ")} CASCADE`)
    const leftovers = (await pg.query(`SELECT count(*)::int n FROM pg_class WHERE relnamespace = $1::regnamespace AND relname <> '_prisma_migrations' AND relname <> '_prisma_migrations_pkey'`, [s])).rows[0].n
    if (leftovers) throw new Error(`${leftovers} objects left in ${s} after the drop; refusing to rebuild over them`)
    const removed = (await pg.query(`DELETE FROM "_prisma_migrations" WHERE migration_name = ANY($1)`, [V2])).rowCount
    const tDrop = Date.now() - t0
    await pg.query(ddl)
    await assertPinned(pg, s)
    const tDdl = Date.now() - t0 - tDrop
    await pg.query(dump.replace(/^\s*(BEGIN|COMMIT);\s*$/gim, ""))
    await pg.query("COMMIT")
    const total = Date.now() - t0
    console.log(`  dropped ${tables.length} tables + ${enums.length} enums, removed ${removed} v2 _prisma_migrations rows (${tDrop} ms)`)
    console.log(`  rebuilt pre-v2 structure (${tDdl} ms), restored ${file} (${total - tDrop - tDdl} ms)`)
    console.log(`  ROLLBACK COMPLETE in ${total} ms (one transaction)`)
  } catch (e) { await pg.query("ROLLBACK").catch(() => {}); throw e } finally { await pg.end() }
}

async function drop() {
  const s = writableSchema()
  const pg = await connect(false)
  try { await pg.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`); console.log(`  dropped ${s}`) } finally { await pg.end() }
}

const run: Record<string, () => Promise<void>> = {
  target: async () => printTarget(opt("--schema") ?? "(none given = public = LIVE)", "READ-ONLY"),
  "inspect-live": inspectLive, counts, "restore-old": restoreOld,
  "apply-single": () => apply(true), "apply-perfile": () => apply(false),
  kill, state, rollback, drop,
}
if (!run[cmd]) { console.error(`usage: see header (got "${cmd}")`); process.exit(2) }
run[cmd]().catch((e) => { console.error(e); process.exit(1) })
