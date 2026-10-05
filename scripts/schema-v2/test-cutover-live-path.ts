// The LIVE path of scripts/schema-v2/cutover-live.ts, end to end, on a
// stand-in for `public`. Run by the OPERATOR in their own terminal: it asks
// for four typed phrases, exactly as the real cutover does.
//
//   node_modules\.bin\tsx.cmd --env-file=.env scripts/schema-v2/test-cutover-live-path.ts <backup.sql>
//
// WHY. On 5 Oct the first live lockdown was refused by the runner's
// protected-schema check (`target "public" is the protected schema`). Lockdown,
// migrate and rollback all shared that path, and no test had ever reached it:
// a LiveWriteAuthorization needs a human at a terminal, and every rehearsal
// targeted a scratch schema, which takes the `--confirm "<phrase>"` path
// instead. This test takes the live path itself.
//
// HOW. BAYLO_LIVE_STANDIN=schema_v2_cut_livepath makes that copy take the
// public path in every tool: --confirm-live-<purpose>, BAYLO_CUTOVER_LIVE=1, an
// interactive terminal, a typed phrase that says "STAND-IN (not live)", and an
// authorization good for one transaction. While it is set, `public` is refused
// by every tool, and the runner's backstop still guards real `public` (rows,
// locks, catalog, grants and default ACLs) inside every transaction.
//
// WRITES ONLY schema_v2_cut_livepath and schema_v2_cut_livepath_src, both
// dropped at the end. Live `public` is read, and fingerprinted before and after
// (counts, ledger, catalog, _prisma_migrations, grants and default ACLs).
//
//   1  build the stand-in from the backup, as live is (old layout, live's
//      migration history, live's anon/authenticated grants), plus the old-side
//      copy verify-v2 compares against
//   2  refusals: public under the stand-in (cutover-live arm/verify, a token
//      naming public, pg-backup), the scratch --confirm path on the stand-in,
//      the stand-in from a pipe
//   3  LOCKDOWN, 4 MIGRATE (+ verify-v2, prisma migrate status), 5 ROLLBACK:
//      arm (captured), run (YOUR terminal: type the phrase), verify (captured)
//   6  one authorization, one run: in-process, wrong purpose / public / reuse
//   7  clean up; live identical before and after
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { Client } from "pg"
import { liveSnapshot, liveUrl } from "../lib/live-snapshot"
import { confirmLiveWrite, GuardError, withGuardedTransaction } from "../lib/migration-runner"

const S = "schema_v2_cut_livepath", SRC = `${S}_src`
const backup = process.argv[2]
if (!backup) { console.error("usage: test-cutover-live-path.ts <backup.sql>"); process.exit(2) }
const TOKEN = "D:\\BAYLO\\backups\\.cutover-armed.json"
const tsx = process.platform === "win32" ? "node_modules\\.bin\\tsx.cmd" : "node_modules/.bin/tsx"
const prisma = process.platform === "win32" ? "node_modules\\.bin\\prisma.cmd" : "node_modules/.bin/prisma"

let failures = 0
const bare = (m: string) => m.replace(/^\[migration guard\] /, "").slice(0, 100)
const ok = (cond: boolean, msg: string) => { console.log(`  ${cond ? "ok  " : "FAIL"}  ${msg}`); if (!cond) failures++ }

// Children get exactly these. NONE = a plain process (no stand-in, no live flag).
const NONE = { BAYLO_LIVE_STANDIN: "", BAYLO_CUTOVER_LIVE: "" }
const STANDIN = { BAYLO_LIVE_STANDIN: S, BAYLO_CUTOVER_LIVE: "1" }
const quote = (args: string[]) => process.platform === "win32" ? args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args

function sh(label: string, bin: string, args: string[], env: Record<string, string>, show = /target|GO|NO-GO|ARMED|COMMITTED|ROLLED BACK|REFUSING|PASSED|FAILED|applied|lockdown:|dropped|rebuilt|restored|re-checked|VERIFIED|up to date|layout|API roles|FAIL|ok  |STAND-IN/) {
  const t0 = Date.now()
  const r = spawnSync(bin, quote(args), {
    env: { ...process.env, DATABASE_URL: liveUrl(), DATABASE_POOL_URL: "", ...env }, encoding: "utf8",
    shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"], input: "", timeout: 600_000,
  })
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
  console.log(`  .. ${label}: exit ${r.status} (${Date.now() - t0} ms)`)
  for (const l of out.split(/\r?\n/).filter((l) => show.test(l))) console.log(`       | ${l.trim().slice(0, 170)}`)
  return { code: r.status, out }
}
/** The one step that must have YOUR terminal: stdin and stdout are inherited, so the tool sees a TTY and you type. */
function interactive(label: string, args: string[]) {
  console.log(`\n  >> ${label}: the tool will print "!! type exactly:  ... STAND-IN (not live) ${S} <code>". Type it and press Enter.\n`)
  const r = spawnSync(tsx, quote(args), {
    env: { ...process.env, DATABASE_URL: liveUrl(), DATABASE_POOL_URL: "", ...STANDIN },
    shell: process.platform === "win32", stdio: "inherit", timeout: 900_000,
  })
  console.log(`\n  .. ${label}: exit ${r.status}`)
  return r.status
}
const tool = (label: string, args: string[], env: Record<string, string> = STANDIN) =>
  sh(label, tsx, ["--env-file=.env", "scripts/schema-v2/cutover-live.ts", ...args], env)
const rehearsal = (label: string, args: string[]) =>
  sh(label, tsx, ["--env-file=.env", "scripts/schema-v2/cutover-rehearsal.ts", ...args], NONE)

function step(purpose: "lockdown" | "migrate" | "rollback") {
  const a = tool(`arm ${purpose}`, ["arm", "--purpose", purpose, "--backup", backup, "--target", S])
  ok(a.code === 0 && /ARMED/.test(a.out) && existsSync(TOKEN), `${purpose}: armed`)
  ok(/schema=schema_v2_cut_livepath \(STAND-IN \(not live\)\)/.test(a.out), `${purpose}: the banner says STAND-IN (not live)`)
  ok(!/scratch confirmation/.test(a.out), `${purpose}: no scratch --confirm phrase is offered (the stand-in takes the live path)`)
  const code = interactive(`run ${purpose}`, ["--env-file=.env", "scripts/schema-v2/cutover-live.ts", "run", "--purpose", purpose, `--confirm-live-${purpose}`])
  ok(code === 0 && !existsSync(TOKEN), `${purpose}: COMMITTED through the live path (exit ${code}); token consumed`)
  const v = tool(`verify ${purpose}`, ["verify", "--purpose", purpose, "--backup", backup, "--target", S])
  ok(v.code === 0 && new RegExp(`VERIFY ${purpose.toUpperCase()} PASSED`).test(v.out), `${purpose}: verify passed`)
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) { console.error("  run this in your own terminal: it needs you to type four phrases"); process.exit(2) }
  if (process.env.BAYLO_LIVE_STANDIN || process.env.BAYLO_CUTOVER_LIVE) { console.error("  unset BAYLO_LIVE_STANDIN and BAYLO_CUTOVER_LIVE first; this test sets them for its own child processes only"); process.exit(2) }
  if (existsSync(TOKEN)) { console.error(`  a token is already armed at ${TOKEN}; refusing to start`); process.exit(1) }
  const u = new URL(liveUrl())
  console.log(`  target  host=${u.hostname}:${u.port}  database=${u.pathname.slice(1)}  writes ONLY to ${S}, ${SRC} (STAND-IN (not live)); public is read`)
  const before = await liveSnapshot()
  console.log(`  live before: ${before.summary}\n  grants:      ${before.grants}\n`)

  console.log(`1. The stand-in: a copy of live as live is (old layout, live's migration history, live's API-role grants)`)
  const r1 = rehearsal("restore-old (stand-in)", ["restore-old", backup, "--schema", S, "--replace", "--mirror-grants"])
  const r2 = rehearsal("restore-old (old side for verify-v2)", ["restore-old", backup, "--schema", SRC, "--replace"])
  ok(r1.code === 0 && r2.code === 0, `${S} and ${SRC} built`)

  console.log("\n2. Refusals")
  ok(/STAND-IN \(not live\) rehearsal/.test(tool("arm, target public, stand-in set", ["arm", "--purpose", "lockdown", "--backup", backup, "--target", "public"]).out) && !existsSync(TOKEN),
    "cutover-live arm --target public: refused while a stand-in is set, nothing armed")
  ok(/STAND-IN \(not live\) rehearsal/.test(tool("verify, default target (public), stand-in set", ["verify", "--purpose", "lockdown", "--backup", backup]).out),
    "cutover-live verify with the default target (public): refused while a stand-in is set")
  const pgb = sh("pg-backup counts (public), stand-in set", tsx, ["--env-file=.env", "scripts/pg-backup.ts", "counts"], STANDIN)
  ok(pgb.code !== 0 && /STAND-IN \(not live\) rehearsal/.test(pgb.out), "pg-backup.ts on public: refused while a stand-in is set")
  const pgr = sh("pg-backup restore public, no stand-in", tsx, ["--env-file=.env", "scripts/pg-backup.ts", "restore", backup, "--force", "--confirm-live-rollback"], NONE)
  ok(pgr.code !== 0 && /never writes "public"/.test(pgr.out) && /cutover-live\.ts arm\|run\|verify --purpose rollback/.test(pgr.out), "pg-backup.ts restore public: refused always, pointing at cutover-live.ts rollback")
  {
    const a = tool("arm lockdown (to tamper: token names public)", ["arm", "--purpose", "lockdown", "--backup", backup, "--target", S])
    const t = JSON.parse(readFileSync(TOKEN, "utf8")); t.target = "public"; writeFileSync(TOKEN, JSON.stringify(t))
    const r = tool("run, token naming public, stand-in set", ["run", "--purpose", "lockdown", "--confirm-live-lockdown"])
    ok(a.code === 0 && r.code !== 0 && /STAND-IN \(not live\) rehearsal/.test(r.out) && !existsSync(TOKEN), "a token naming public: refused while a stand-in is set, token consumed")
  }
  {
    const a = tool("arm lockdown (scratch --confirm on the stand-in)", ["arm", "--purpose", "lockdown", "--backup", backup, "--target", S])
    const r = tool("run with a scratch --confirm phrase", ["run", "--purpose", "lockdown", "--confirm", `LOCKDOWN SCRATCH ${S} ${JSON.parse(readFileSync(TOKEN, "utf8")).code}`])
    ok(a.code === 0 && r.code !== 0 && /pass --confirm-live-lockdown/.test(r.out) && !existsSync(TOKEN), "the stand-in ignores the scratch --confirm path (needs the live flag), token consumed")
  }
  {
    tool("arm lockdown (stand-in from a pipe)", ["arm", "--purpose", "lockdown", "--backup", backup, "--target", S])
    const r = tool("run from a pipe", ["run", "--purpose", "lockdown", "--confirm-live-lockdown"])
    ok(r.code !== 0 && /needs an interactive terminal/.test(r.out) && !existsSync(TOKEN), "the stand-in from a pipe: refused (needs a terminal), token consumed")
  }
  const st = tool("state after the refusals", ["verify", "--purpose", "rollback", "--backup", backup, "--target", S])
  ok(/FULLY OLD, all 34 tables equal the backup, no v2 rows: OLD, 34\/34/.test(st.out) && /35\/35 reachable/.test(st.out), "after every refusal the stand-in is untouched: pre-v2, 34/34, still exposed like live")

  console.log("\n3. LOCKDOWN through the live path")
  step("lockdown")

  console.log("\n4. MIGRATE through the live path")
  step("migrate")
  const vv = sh("verify-v2 --new <stand-in> --old <src> (the post-cutover form)", tsx, ["--env-file=.env", "scripts/schema-v2/verify-v2.ts", "--new", S, "--old", SRC], NONE, /read-only|FAIL|VERIFIED/)
  ok(vv.code === 0 && /SCHEMA V2 VERIFIED/.test(vv.out) && !/\bFAIL\b/.test(vv.out), "verify-v2: SCHEMA V2 VERIFIED, 0 FAIL")
  const ps = sh("prisma migrate status", prisma, ["migrate", "status"], { ...NONE, DATABASE_URL: `${liveUrl()}${liveUrl().includes("?") ? "&" : "?"}schema=${S}` }, /up to date|not yet been applied|different|Datasource/)
  ok(ps.code === 0 && /Database schema is up to date/.test(ps.out), "prisma migrate status: up to date")

  console.log("\n5. ROLLBACK through the live path")
  step("rollback")

  console.log("\n6. One authorization, one run (in-process; type the fourth phrase)")
  {
    process.env.BAYLO_LIVE_STANDIN = S
    process.env.BAYLO_CUTOVER_LIVE = "1"
    process.argv.push("--confirm-live-lockdown")
    const pg = new Client({ connectionString: liveUrl() })
    try {
      const auth = await confirmLiveWrite("lockdown", u.hostname, S)
      await pg.connect()
      const refused = async (o: Parameters<typeof withGuardedTransaction>[1]) => {
        try { await withGuardedTransaction(pg, o, async () => {}); return "" } catch (e) { return e instanceof GuardError ? e.message : `not a guard error: ${(e as Error).message}` }
      }
      const m1 = await refused({ target: S, live: auth, purpose: "migrate" })
      ok(/confirmed for lockdown on "schema_v2_cut_livepath", not migrate/.test(m1), `an authorization for lockdown, used for migrate: refused (${bare(m1)})`)
      const m2 = await refused({ target: "public", live: auth, purpose: "lockdown" })
      ok(/STAND-IN \(not live\) rehearsal/.test(m2), `the stand-in's authorization aimed at public: refused (${bare(m2)})`)
      const m3 = await refused({ target: S, live: auth, purpose: "lockdown" })
      ok(m3 === "", `first use, right target and purpose: accepted (an empty transaction on ${S})${m3 ? ` -- ${m3}` : ""}`)
      const m4 = await refused({ target: S, live: auth, purpose: "lockdown" })
      ok(/already used/.test(m4), `second use of the same authorization: refused (${bare(m4)})`)
    } catch (e) {
      ok(false, `in-process authorization: ${(e as Error).message}`)
    } finally {
      await pg.end().catch(() => {})
      process.argv.pop()
      delete process.env.BAYLO_LIVE_STANDIN
      delete process.env.BAYLO_CUTOVER_LIVE
    }
  }

  console.log("\n7. Clean up, then live")
  for (const s of [S, SRC]) rehearsal(`drop ${s}`, ["drop", "--schema", s])
  ok(!existsSync(TOKEN), "no token left armed")
  const after = await liveSnapshot()
  console.log(`  live after:  ${after.summary}\n  grants:      ${after.grants}`)
  ok(after.full === before.full, "live public is identical before and after (counts, ledger, catalog fingerprint, _prisma_migrations, grants and default ACLs)")

  console.log(failures ? `\n  LIVE PATH TEST FAILED: ${failures}\n` : `\n  LIVE PATH TEST PASSED\n`)
  process.exitCode = failures ? 1 : 0
}

main().catch((e) => { console.error(e); process.exit(1) })
