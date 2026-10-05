// THE live cutover tool for schema v2: lockdown, migrate and rollback, each
// armed once and run once. docs/cutover-runbook.md is the procedure; this is
// the only code in the repo that may write `public` for the cutover.
//
//   npx tsx --env-file=.env scripts/schema-v2/cutover-live.ts arm    --purpose lockdown|migrate|rollback --backup <file> [--target <schema>]
//   npx tsx --env-file=.env scripts/schema-v2/cutover-live.ts run    --purpose lockdown|migrate|rollback [--confirm-live-<purpose>]
//   npx tsx --env-file=.env scripts/schema-v2/cutover-live.ts verify --purpose lockdown|migrate|rollback --backup <file> [--target <schema>]
//   npx tsx --env-file=.env scripts/schema-v2/cutover-live.ts status
//
// --target defaults to `public` (LIVE). A schema_v2_cut* target runs the SAME
// code path end to end against a scratch copy of live; that is how the tool
// is rehearsed (scripts/schema-v2/test-cutover-live-e2e.ts). Two things
// differ for a scratch target: no LiveWriteAuthorization is needed (the
// runner's backstop also protects `public`), and the confirmation is passed as
// `--confirm "<phrase>"` because no human types into a test.
//
// The LIVE path itself (authorization, typed phrase, one use) is rehearsed on
// a stand-in: with BAYLO_LIVE_STANDIN=<schema_v2_cut*>, that schema takes the
// public path exactly, the banner and the phrase say "STAND-IN (not live)",
// and `public` is refused (scripts/schema-v2/test-cutover-live-path.ts). That
// test exists because the first live lockdown (5 Oct) was refused by a guard
// that no scratch rehearsal could reach.
//
// ── ARM (read-only on the target) ───────────────────────────────────────────
//   Runs the go/no-go checks for the purpose. If they all pass, it writes ONE
//   token, D:\BAYLO\backups\.cutover-armed.json, holding: purpose, target,
//   host, database, backup path + SHA-256, the target's per-table counts and
//   ledger figures, OS user, a one-time code, createdAt, and
//   expiresAt = createdAt + 15 min. It refuses if a token is already armed.
//   Nothing is written to the database.
//
// ── RUN ─────────────────────────────────────────────────────────────────────
//   1  BAYLO_CUTOVER_LIVE=1 must be set in this shell (both targets).
//   2  The token is CONSUMED FIRST: renamed to .cutover-used-<ts>.json before
//      anything else, so a crash, a kill, a refusal or a success all leave the
//      tool disarmed. A second run needs a new arm.
//   3  It refuses if the token has expired, names another purpose, or was
//      written by another OS user, or if the backup's SHA-256 changed.
//   4  Live: confirmLiveWrite(): `--confirm-live-<purpose>`, an interactive
//      terminal, and the operator types `<PURPOSE> LIVE public <code>`.
//      Scratch: `--confirm "<PURPOSE> SCRATCH <target> <token code>"`.
//   5  It re-reads the target: counts and ledger must equal the token's (so
//      nothing wrote since arming) and no app connection may be open.
//   6  The purpose runs as ONE guarded transaction (migration-runner.ts):
//        lockdown  REVOKE anon/authenticated on every table, sequence and
//                  routine, plus postgres's default privileges; 0 exposed is
//                  asserted before commit
//        migrate   applyV2InTransaction(): migrate lock, LOCK ... NOWAIT, six
//                  migrations + six _prisma_migrations rows, 25 tables and
//                  the ledger asserted before commit
//        rollback  drop the v2 tables and enums, delete the six v2 rows,
//                  rebuild the pre-v2 structure, restore the backup; counts =
//                  backup and the ledger asserted before commit
//   Everything is logged to D:\BAYLO\backups\cutover-<ts>.log.
//
// ── VERIFY (read-only) ──────────────────────────────────────────────────────
//   Layout (FULLY OLD / FULLY NEW), ledger, API-role exposure, table owners,
//   _prisma_migrations, and for migrate/rollback the counts against the backup.
import { Client, types } from "pg"
import { createHash, randomBytes } from "node:crypto"
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { userInfo } from "node:os"
import { LEDGER_INVARIANT_SQL, figuresFromRow, judge, type LedgerJudgement } from "../lib/ledger-invariant"
import {
  GuardError, V2_MIGRATIONS, applyV2InTransaction, confirmLiveWrite, isLiveTarget, isScratchTarget, liveLabel, prepareBatch, preV2Chain,
  refusePublicUnderStandIn, withGuardedTransaction, type Guarded, type LiveWriteAuthorization,
} from "../lib/migration-runner"
import { describe, exposure, lockdownStatements } from "../lib/api-role-lockdown"

for (const oid of [1082, 1114, 1083, 1184]) types.setTypeParser(oid, (v) => v)
types.setTypeParser(20, (v) => v)
types.setTypeParser(1700, (v) => v)

const BACKUPS = process.env.BAYLO_CUTOVER_DIR ?? "D:\\BAYLO\\backups"
const TOKEN = `${BACKUPS}\\.cutover-armed.json`
const TTL_MIN = 15
const TRAILER = "-- Baylo data dump complete"
const PURPOSES = ["lockdown", "migrate", "rollback"] as const
type Purpose = (typeof PURPOSES)[number]

const argv = process.argv.slice(2)
const cmd = argv[0]
const opt = (n: string) => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1] }
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-")
const LOG = `${BACKUPS}\\cutover-${stamp}.log`
function log(line = "") { console.log(line); try { appendFileSync(LOG, `${line}\n`) } catch { /* the log is a convenience */ } }
function die(msg: string): never { log(`\n  REFUSING: ${msg}\n`); process.exit(1) }

interface Token {
  purpose: Purpose; target: string; host: string; database: string
  backup: string; backupSha256: string; counts: Record<string, number>; ledger: LedgerJudgement
  osUser: string; code: string; createdAt: string; expiresAt: string
}

function purposeArg(): Purpose {
  const p = opt("--purpose") as Purpose
  if (!PURPOSES.includes(p)) die(`--purpose must be one of ${PURPOSES.join(", ")}`)
  return p
}
function targetArg(): string {
  const t = opt("--target") ?? "public"
  try { refusePublicUnderStandIn(t) } catch (e) { die((e as Error).message) }
  if (t !== "public" && !/^schema_v2_cut[a-z0-9_]*$/.test(t)) die(`--target must be public or a schema_v2_cut* rehearsal copy (got "${t}")`)
  return t
}
function url(): URL {
  const raw = process.env.DATABASE_URL
  if (!raw?.startsWith("postgres")) die("DATABASE_URL is not a Postgres URL")
  const u = new URL(raw!)
  if (u.searchParams.get("schema")) die("DATABASE_URL must not carry ?schema=; the target is --target (default public)")
  return u
}
function printTarget(target: string, mode: string) {
  const u = url()
  log(`  target  host=${u.hostname}:${u.port || 5432}  database=${u.pathname.slice(1)}  schema=${target} (${isLiveTarget(target) ? liveLabel(target) : "scratch copy of live"})  mode=${mode}`)
}
async function connect(readOnly: boolean): Promise<Client> {
  const c = new Client({ connectionString: url().toString() })
  c.on("error", (e) => log(`  connection lost: ${e.message}`))
  await c.connect()
  if (readOnly) {
    await c.query(`SET SESSION default_transaction_read_only = on`)
    if ((await c.query(`SHOW default_transaction_read_only`)).rows[0].default_transaction_read_only !== "on") die("could not make the session read-only")
  }
  return c
}
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex")

function readBackup(file: string) {
  if (!file || !existsSync(file)) die(`no such backup: ${file}`)
  const sql = readFileSync(file, "utf8")
  if (!sql.includes(TRAILER)) die("the backup has no trailer; it is truncated")
  const claimed = Object.fromEntries((/-- rowcounts: (.*)/.exec(sql)?.[1] ?? "").split(/\s+/).filter(Boolean).map((p) => { const [t, n] = p.split("="); return [t, Number(n)] }))
  return { sql, claimed: claimed as Record<string, number> }
}

// ── Read-only facts about the target ────────────────────────────────────────

async function facts(pg: Client, target: string) {
  const one = async (sql: string, p: unknown[] = []) => Number(Object.values((await pg.query(sql, p)).rows[0])[0])
  const tables = (await pg.query(`SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename <> '_prisma_migrations' ORDER BY 1`, [target])).rows.map((r) => r.tablename as string)
  const counts: Record<string, number> = {}
  for (const t of tables) counts[t] = await one(`SELECT count(*) FROM "${target}"."${t}"`)
  const has = (t: string) => tables.includes(t)
  const layout = has("Trade") && !has("Offer") && !has("TradeRequest") && tables.length === 25 ? "NEW"
    : !has("Trade") && has("Offer") && has("TradeRequest") && tables.length === 34 ? "OLD" : "HALF"
  const ledger = judge(figuresFromRow((await pg.query(LEDGER_INVARIANT_SQL(target, layout === "NEW" ? "v2" : "v1"))).rows[0]))
  const hasMig = (await pg.query(`SELECT to_regclass($1) IS NOT NULL ok`, [`"${target}"."_prisma_migrations"`])).rows[0].ok
  const migs = hasMig ? (await pg.query(`SELECT migration_name, finished_at IS NOT NULL done, rolled_back_at IS NOT NULL rb FROM "${target}"."_prisma_migrations"`)).rows : []
  const v2rows = migs.filter((m) => V2_MIGRATIONS.includes(m.migration_name) && m.done && !m.rb).length
  const unfinished = migs.filter((m) => !m.done && !m.rb).length
  // Database-wide, like the runbook's step 4.3: app servers show up as
  // postgres/Supavisor through either pooler; pg_net is Supabase's own.
  const apps = (await pg.query(`SELECT pid, application_name, state, to_char(backend_start, 'MM-DD HH24:MI') started FROM pg_stat_activity
     WHERE datname = current_database() AND usename = 'postgres' AND pid <> pg_backend_pid() AND application_name NOT LIKE 'pg_net%'`)).rows
  const owners = (await pg.query(`SELECT tableowner, count(*)::int n FROM pg_tables WHERE schemaname = $1 GROUP BY 1`, [target])).rows
  return { tables, counts, layout, ledger, hasMig, migs: migs.length, v2rows, unfinished, apps, owners, exp: await exposure(pg, target) }
}

async function preconditions(pg: Client, target: string, purpose: Purpose) {
  const one = async (sql: string) => Number(Object.values((await pg.query(sql)).rows[0])[0])
  const s = (t: string) => `"${target}"."${t}"`
  const out: [string, boolean, string][] = []
  if (purpose === "migrate" || purpose === "lockdown") {
    const hidden = await one(`SELECT count(*) FROM ${s("TradeRequest")} WHERE "hiddenBySender" OR "hiddenByReceiver"`)
    out.push(["G3 hidden trades", hidden === 0, String(hidden)])
    const cl = await one(`SELECT count(*) FROM ${s("CommentLike")}`), ch = await one(`SELECT count(*) FROM ${s("ConversationHide")}`)
    out.push(["G4 CommentLike / ConversationHide", cl === 0 && ch === 0, `${cl} / ${ch}`])
    const dpa = await one(`SELECT count(*) FROM ${s("DeferredContract")} WHERE status::text <> 'FULFILLED'`)
    out.push(["G5 open DeferredContract", dpa === 0, String(dpa)])
    const orgs = await one(`SELECT count(*) FROM ${s("Organization")} g WHERE (SELECT count(*) FROM ${s("OrganizationMember")} m WHERE m."organizationId" = g.id AND m.role = 'OWNER' AND m.status = 'ACTIVE') <> 1`)
    out.push(["G6 orgs without one ACTIVE OWNER", orgs === 0, String(orgs)])
  }
  return out
}

function report(f: Awaited<ReturnType<typeof facts>>) {
  log(`  layout ${f.layout} (${f.tables.length} tables); _prisma_migrations ${f.migs} rows, ${f.v2rows} v2, ${f.unfinished} unfinished`)
  log(`  ledger: ${f.ledger.lines.join("; ")}`)
  log(`  API roles: ${describe(f.exp)}`)
  log(`  owners: ${f.owners.map((o) => `${o.tableowner} x${o.n}`).join(", ")}`)
  log(`  app connections: ${f.apps.length ? f.apps.map((a) => `${a.pid} ${a.application_name || "-"} ${a.state} since ${a.started}`).join("; ") : "none"}`)
}

// ── arm ─────────────────────────────────────────────────────────────────────

async function arm() {
  const purpose = purposeArg(), target = targetArg(), backup = opt("--backup") ?? ""
  printTarget(target, `ARM ${purpose} (read-only)`)
  if (existsSync(TOKEN)) die(`a token is already armed (${TOKEN}). Run it, or delete it deliberately, before arming again`)
  const { claimed } = readBackup(backup)
  const pg = await connect(true)
  let f: Awaited<ReturnType<typeof facts>>, pre: [string, boolean, string][]
  // The precondition queries read pre-v2 tables; on any other layout the
  // layout check below is the NO-GO.
  try { f = await facts(pg, target); pre = f.layout === "OLD" ? await preconditions(pg, target, purpose) : [] } finally { await pg.end() }
  report(f)

  const checks: [string, boolean, string][] = [...pre]
  checks.push(["G2 ledger holds", f.ledger.ok, f.ledger.ok ? "all three" : "BROKEN"])
  checks.push(["G7 no app connections", f.apps.length === 0, `${f.apps.length}`])
  checks.push(["all tables owned by postgres", f.owners.every((o) => o.tableowner === "postgres"), f.owners.map((o) => `${o.tableowner} x${o.n}`).join(", ")])
  checks.push(["_prisma_migrations present, nothing unfinished", f.hasMig && f.unfinished === 0, `${f.migs} rows, ${f.unfinished} unfinished`])
  const drift = Object.keys(claimed).filter((t) => f.counts[t] !== claimed[t])
  if (purpose === "lockdown" || purpose === "migrate") {
    checks.push(["layout is pre-v2 (34 tables)", f.layout === "OLD", f.layout])
    checks.push(["G1 nothing written since the backup", drift.length === 0 && Object.keys(claimed).length === 34, drift.length ? drift.map((t) => `${t} ${claimed[t]}->${f.counts[t]}`).join(", ") : "34/34 equal"])
    checks.push(["G9 no v2 migration recorded", f.v2rows === 0, String(f.v2rows)])
  }
  if (purpose === "migrate") checks.push(["G11 lockdown done (0 tables exposed)", f.exp.tablesExposed === 0, `${f.exp.tablesExposed}/${f.exp.tables}`])
  if (purpose === "rollback") {
    checks.push(["layout is v2 (there is something to roll back)", f.layout === "NEW" || f.layout === "HALF", f.layout])
    checks.push(["the backup is pre-v2 (34 tables)", Object.keys(claimed).length === 34 && "Offer" in claimed, `${Object.keys(claimed).length} tables`])
  }
  log("")
  for (const [name, ok, detail] of checks) log(`  ${ok ? "GO   " : "NO-GO"}  ${name}: ${detail}`)
  if (checks.some((c) => !c[1])) die("a go/no-go check failed; nothing armed")

  const u = url(), now = new Date()
  const token: Token = {
    purpose, target, host: u.hostname, database: u.pathname.slice(1), backup, backupSha256: sha256(backup),
    counts: f.counts, ledger: f.ledger, osUser: userInfo().username, code: randomBytes(3).toString("hex").toUpperCase(),
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + TTL_MIN * 60_000).toISOString(),
  }
  writeFileSync(TOKEN, JSON.stringify(token, null, 2), { flag: "wx" }) // wx: never overwrite a token
  log(`\n  ARMED ${purpose} on ${target} until ${token.expiresAt} (${TTL_MIN} min, one run)`)
  if (!isLiveTarget(target)) log(`  scratch confirmation: --confirm "${purpose.toUpperCase()} SCRATCH ${target} ${token.code}"`)
  log(`  log: ${LOG}`)
}

// ── run ─────────────────────────────────────────────────────────────────────

async function run() {
  const purpose = purposeArg()
  if (process.env.BAYLO_CUTOVER_LIVE !== "1") die("BAYLO_CUTOVER_LIVE=1 is not set in this shell")
  if (!existsSync(TOKEN)) die(`nothing is armed (${TOKEN} not found)`)
  // CONSUME FIRST. From here on, whatever happens, the token is spent.
  const used = `${BACKUPS}\\.cutover-used-${stamp}.json`
  renameSync(TOKEN, used)
  const token = JSON.parse(readFileSync(used, "utf8")) as Token
  printTarget(token.target, `RUN ${purpose}`)
  log(`  token consumed: ${used}`)
  if (token.purpose !== purpose) die(`the token was armed for "${token.purpose}", not "${purpose}"`)
  if (Date.now() > Date.parse(token.expiresAt)) die(`the token expired at ${token.expiresAt}; arm again`)
  if (token.osUser !== userInfo().username) die(`the token was armed by ${token.osUser}, not ${userInfo().username}`)
  const u = url()
  if (token.host !== u.hostname || token.database !== u.pathname.slice(1)) die("the token was armed for another database")
  if (sha256(token.backup) !== token.backupSha256) die("the backup file changed since arming")
  const { sql: dumpSql, claimed } = readBackup(token.backup)

  let live: LiveWriteAuthorization | undefined
  if (isLiveTarget(token.target)) {
    // BAYLO_CUTOVER_LIVE=1, --confirm-live-<purpose>, an interactive terminal, and the typed phrase.
    try { live = await confirmLiveWrite(purpose, u.hostname, token.target) } catch (e) { die((e as Error).message) }
  } else {
    const want = `${purpose.toUpperCase()} SCRATCH ${token.target} ${token.code}`
    if (opt("--confirm") !== want) die(`scratch confirmation must be exactly: --confirm "${want}"`)
    if (!isScratchTarget(token.target)) die("not a scratch target")
  }

  const pg = await connect(false)
  const t0 = Date.now()
  try {
    // 5: nothing may have changed since arming, and nothing may be connected.
    await pg.query(`SET SESSION default_transaction_read_only = on`)
    const f = await facts(pg, token.target)
    await pg.query(`SET SESSION default_transaction_read_only = off`)
    const drift = Object.keys(token.counts).filter((t) => f.counts[t] !== token.counts[t])
    if (drift.length || Object.keys(f.counts).length !== Object.keys(token.counts).length) die(`the target changed since arming: ${drift.join(", ") || "table set differs"}`)
    if (JSON.stringify([f.ledger.userLeaves, f.ledger.ledger, f.ledger.escrow, f.ledger.issuance]) !== JSON.stringify([token.ledger.userLeaves, token.ledger.ledger, token.ledger.escrow, token.ledger.issuance])) die("the ledger changed since arming")
    if (f.apps.length) die(`${f.apps.length} app connection(s) open: ${f.apps.map((a) => a.pid).join(", ")}`)
    log(`  re-checked: counts and ledger as armed, no app connections`)

    await withGuardedTransaction(pg, { target: token.target, live, purpose, lockTimeout: "5s" }, async (g) => {
      if (purpose === "lockdown") await lockdownIn(g)
      else if (purpose === "migrate") await applyV2InTransaction(g, { log })
      else await rollbackIn(g, dumpSql, claimed)
    })
    log(`\n  ${purpose.toUpperCase()} COMMITTED on ${token.target} in ${Date.now() - t0} ms (one transaction)`)
    log(`  next: cutover-live.ts verify --purpose ${purpose} --backup ${token.backup}${token.target === "public" ? "" : ` --target ${token.target}`}`)
    log(`  log: ${LOG}`)
  } catch (e) {
    log(`\n  ${purpose.toUpperCase()} ROLLED BACK after ${Date.now() - t0} ms -- ${token.target} is exactly as it was: ${(e as Error).message}`)
    process.exitCode = 1
  } finally {
    await pg.end().catch(() => {})
  }
}

async function lockdownIn(g: Guarded) {
  const stmts = lockdownStatements(g.target, "postgres")
  for (const s of stmts) await g.query(s)
  const e = await exposure((sql, p) => g.query(sql, p), g.target)
  log(`  lockdown: ${stmts.length} statements; ${describe(e)}`)
  if (e.tablesExposed || e.sequencesExposed || e.routinesExposed || e.defaultAclExposed.some((x) => x.startsWith("postgres/")))
    throw new GuardError("anon/authenticated still reach the schema after the lockdown")
}

async function rollbackIn(g: Guarded, dumpSql: string, claimed: Record<string, number>) {
  const t = g.target
  const tables = (await g.query(`SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename <> '_prisma_migrations'`, [t])).rows.map((r) => String(r.tablename))
  await g.query(`LOCK TABLE ${[...tables, "_prisma_migrations"].map((x) => `"${x}"`).join(", ")} IN ACCESS EXCLUSIVE MODE NOWAIT`)
  if (tables.length) await g.query(`DROP TABLE ${tables.map((x) => `"${x}"`).join(", ")} CASCADE`)
  const enums = (await g.query(`SELECT typname FROM pg_type WHERE typnamespace = $1::regnamespace AND typtype = 'e'`, [t])).rows.map((r) => String(r.typname))
  if (enums.length) await g.query(`DROP TYPE ${enums.map((x) => `"${x}"`).join(", ")} CASCADE`)
  const left = Number((await g.query(`SELECT count(*) n FROM pg_class WHERE relnamespace = $1::regnamespace AND relname NOT IN ('_prisma_migrations', '_prisma_migrations_pkey')`, [t])).rows[0].n)
  if (left) throw new GuardError(`${left} objects left after the drop; refusing to rebuild over them`)
  const removed = (await g.query(`DELETE FROM "_prisma_migrations" WHERE migration_name = ANY($1)`, [[...V2_MIGRATIONS]])).rowCount
  log(`  dropped ${tables.length} tables + ${enums.length} enums, removed ${removed} v2 _prisma_migrations rows`)
  const chain = await preV2Chain()
  for (const m of chain) await g.run(m.batch)
  log(`  rebuilt the pre-v2 structure from ${chain.length} migrations`)
  await g.run(prepareBatch("backup", "data", dumpSql))
  let bad = 0
  for (const [tbl, n] of Object.entries(claimed)) if (Number((await g.query(`SELECT count(*) n FROM "${tbl}"`)).rows[0].n) !== n) bad++
  const inv = judge(figuresFromRow((await g.query(LEDGER_INVARIANT_SQL(t, "v1"))).rows[0] as Record<string, string>))
  log(`  restored the backup: ${Object.keys(claimed).length - bad}/${Object.keys(claimed).length} tables equal; ${inv.lines.join("; ")}`)
  if (bad || !inv.ok) throw new GuardError("the restore did not verify")
}

// ── verify / status ─────────────────────────────────────────────────────────

async function verify() {
  const purpose = purposeArg(), target = targetArg(), backup = opt("--backup") ?? ""
  printTarget(target, `VERIFY ${purpose} (read-only)`)
  const { claimed } = readBackup(backup)
  const pg = await connect(true)
  let f: Awaited<ReturnType<typeof facts>>
  try { f = await facts(pg, target) } finally { await pg.end() }
  report(f)
  const checks: [string, boolean, string][] = [["ledger holds", f.ledger.ok, f.ledger.ok ? "all three" : "BROKEN"],
    ["0 tables reachable by anon/authenticated", f.exp.tablesExposed === 0 && !f.exp.defaultAclExposed.some((x) => x.startsWith("postgres/")), `${f.exp.tablesExposed}/${f.exp.tables}`],
    ["all tables owned by postgres", f.owners.every((o) => o.tableowner === "postgres"), f.owners.map((o) => `${o.tableowner} x${o.n}`).join(", ")],
    ["nothing unfinished in _prisma_migrations", f.unfinished === 0, String(f.unfinished)]]
  const equal = Object.keys(claimed).filter((t) => f.counts[t] === claimed[t]).length
  if (purpose === "lockdown") checks.push(["still pre-v2, data as backed up", f.layout === "OLD" && equal === 34, `${f.layout}, ${equal}/34 equal`])
  if (purpose === "migrate") {
    checks.push(["FULLY NEW: 25 tables, 6 v2 rows", f.layout === "NEW" && f.v2rows === 6, `${f.layout}, ${f.v2rows} v2 rows`])
    const sameNames = ["User", "Follow", "Item", "Message", "Review", "Block", "IdVerification", "AdminAction", "SafeZoneHub", "ItemSafeZone", "Achievement", "Organization", "Story", "StoryView"]
    const carried = sameNames.filter((t) => f.counts[t] === claimed[t]).length
    checks.push(["carried-over tables equal the backup", carried === sameNames.length, `${carried}/${sameNames.length}`])
    const trade = claimed.TradeRequest + claimed.Offer
    checks.push(["Trade between max(Offer, TradeRequest) and their sum", f.counts.Trade >= Math.max(claimed.Offer, claimed.TradeRequest) && f.counts.Trade <= trade, `${f.counts.Trade} (Offer ${claimed.Offer} + TradeRequest ${claimed.TradeRequest})`])
    checks.push(["AuthToken = the three token tables", f.counts.AuthToken === claimed.RefreshToken + claimed.EmailVerificationToken + claimed.PasswordResetToken, `${f.counts.AuthToken}`])
  }
  if (purpose === "rollback") checks.push(["FULLY OLD, all 34 tables equal the backup, no v2 rows", f.layout === "OLD" && equal === 34 && f.v2rows === 0, `${f.layout}, ${equal}/34, ${f.v2rows} v2 rows`])
  log("")
  for (const [name, ok, detail] of checks) log(`  ${ok ? "ok  " : "FAIL"}  ${name}: ${detail}`)
  const bad = checks.filter((c) => !c[1]).length
  log(bad ? `\n  VERIFY ${purpose.toUpperCase()} FAILED: ${bad}\n` : `\n  VERIFY ${purpose.toUpperCase()} PASSED on ${target}\n`)
  process.exitCode = bad ? 1 : 0
}

function status() {
  log(existsSync(TOKEN) ? `  ARMED: ${readFileSync(TOKEN, "utf8")}` : "  nothing armed")
}

const commands: Record<string, () => unknown> = { arm, run, verify, status }
if (!commands[cmd]) die(`usage: cutover-live.ts arm|run|verify|status (see the header)`)
Promise.resolve(commands[cmd]()).catch((e) => { log(`  ERROR: ${(e as Error).message}`); process.exit(1) })
