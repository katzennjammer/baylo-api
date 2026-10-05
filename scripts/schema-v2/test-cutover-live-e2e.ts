// End-to-end test of scripts/schema-v2/cutover-live.ts, run EXACTLY as the
// runbook runs it (arm, run, verify for lockdown, then migrate, then
// rollback), against a scratch copy of live instead of `public`.
//
//   npx tsx --env-file=.env scripts/schema-v2/test-cutover-live-e2e.ts <backup.sql>
//
// The copy, schema_v2_cut_e2e, is the backup restored in the pre-v2 layout,
// with live's 28 _prisma_migrations rows and live's anon/authenticated grants
// (--mirror-grants), so every go/no-go check sees what it will see on live.
// schema_v2_cut_e2e_src is the same backup, used by verify-v2's comparison.
// Both are dropped at the end. Live is only read, and is snapshotted before
// and after.
//
// The one step it cannot perform as the runbook does is the human typing the
// live phrase into a terminal; a scratch target takes `--confirm "<phrase>"`
// instead. The live path's refusals (no flag, no terminal) are tested
// below without connecting.
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { Client } from "pg"
import { liveSnapshot, liveUrl } from "../lib/live-snapshot"

const S = "schema_v2_cut_e2e", SRC = `${S}_src`
const backup = process.argv[2]
if (!backup) { console.error("usage: test-cutover-live-e2e.ts <backup.sql>"); process.exit(2) }
const TOKEN = "D:\\BAYLO\\backups\\.cutover-armed.json"
const tsx = process.platform === "win32" ? "node_modules\\.bin\\tsx.cmd" : "node_modules/.bin/tsx"
const prisma = process.platform === "win32" ? "node_modules\\.bin\\prisma.cmd" : "node_modules/.bin/prisma"

let failures = 0
const timings: string[] = []
const ok = (cond: boolean, msg: string) => { console.log(`  ${cond ? "ok  " : "FAIL"}  ${msg}`); if (!cond) failures++ }

function sh(label: string, bin: string, args: string[], env: Record<string, string> = {}, show = /target|GO|NO-GO|ARMED|COMMITTED|ROLLED BACK|REFUSING|PASSED|FAILED|applied|lockdown:|dropped|rebuilt|restored|re-checked|VERIFIED|up to date|layout|API roles|FAIL|ok  /) {
  const t0 = Date.now()
  // shell: true on Windows joins args with spaces and no quoting, which would
  // split "--confirm <phrase>" into words; quote anything with a space.
  if (process.platform === "win32") args = args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
  const r = spawnSync(bin, args, {
    env: { ...process.env, DATABASE_URL: liveUrl(), DATABASE_POOL_URL: "", ...env }, encoding: "utf8",
    shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"], input: "", timeout: 600_000,
  })
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
  console.log(`  .. ${label}: exit ${r.status} (${Date.now() - t0} ms)`)
  for (const l of out.split(/\r?\n/).filter((l) => show.test(l))) console.log(`       | ${l.trim().slice(0, 160)}`)
  return { code: r.status, out, ms: Date.now() - t0 }
}
const tool = (label: string, args: string[], env: Record<string, string> = {}) =>
  sh(label, tsx, ["--env-file=.env", "scripts/schema-v2/cutover-live.ts", ...args], env)
const LIVE = { BAYLO_CUTOVER_LIVE: "1" }
const confirmFrom = (out: string) => /--confirm "([^"]+)"/.exec(out)?.[1] ?? ""

function armRun(purpose: string) {
  const a = tool(`arm ${purpose}`, ["arm", "--purpose", purpose, "--backup", backup, "--target", S])
  ok(a.code === 0 && /ARMED/.test(a.out) && existsSync(TOKEN), `${purpose}: armed (every go/no-go check GO)`)
  const r = tool(`run ${purpose}`, ["run", "--purpose", purpose, "--confirm", confirmFrom(a.out)], LIVE)
  const ms = Number(/COMMITTED on .* in (\d+) ms/.exec(r.out)?.[1] ?? NaN)
  ok(r.code === 0 && /COMMITTED/.test(r.out) && !existsSync(TOKEN), `${purpose}: committed in one transaction (${ms} ms); token consumed`)
  timings.push(`${purpose}: arm ${a.ms} ms, run ${r.ms} ms wall (${ms} ms in the transaction)`)
  const v = tool(`verify ${purpose}`, ["verify", "--purpose", purpose, "--backup", backup, "--target", S])
  ok(v.code === 0 && new RegExp(`VERIFY ${purpose.toUpperCase()} PASSED`).test(v.out), `${purpose}: verify passed`)
  timings.push(`${purpose}: verify ${v.ms} ms`)
}

async function main() {
  const u = new URL(liveUrl())
  console.log(`  target  host=${u.hostname}:${u.port}  database=${u.pathname.slice(1)}  writes ONLY to ${S}, ${SRC}; public is read`)
  if (existsSync(TOKEN)) { console.error(`  a token is already armed at ${TOKEN}; refusing to start`); process.exit(1) }
  const before = await liveSnapshot()
  console.log(`  live before: ${before.summary}\n`)

  console.log("1. A scratch copy of live, as live is: old layout, live's migration history, live's API-role grants")
  const r1 = sh("restore-old (target)", tsx, ["--env-file=.env", "scripts/schema-v2/cutover-rehearsal.ts", "restore-old", backup, "--schema", S, "--replace", "--mirror-grants"])
  const r2 = sh("restore-old (old side for verify-v2)", tsx, ["--env-file=.env", "scripts/schema-v2/cutover-rehearsal.ts", "restore-old", backup, "--schema", SRC, "--replace"])
  ok(r1.code === 0 && r2.code === 0, `${S} and ${SRC} built`)

  console.log("\n2. Refusals before anything is armed")
  ok(/nothing is armed/.test(tool("run, nothing armed", ["run", "--purpose", "lockdown"], LIVE).out), "run with no token: refused")
  ok(/BAYLO_CUTOVER_LIVE=1 is not set/.test(tool("run, no env flag", ["run", "--purpose", "lockdown"]).out), "run without BAYLO_CUTOVER_LIVE=1: refused")
  const early = tool("arm migrate before the lockdown", ["arm", "--purpose", "migrate", "--backup", backup, "--target", S])
  ok(early.code !== 0 && /NO-GO\s+G11/.test(early.out) && !existsSync(TOKEN), "arm migrate before the lockdown: NO-GO on G11, nothing armed")
  ok(/must be public or a schema_v2_cut/.test(tool("arm, bad target", ["arm", "--purpose", "lockdown", "--backup", backup, "--target", "schema_v2_wk1"]).out), "target schema_v2_wk1 (not a cut copy): refused")

  console.log("\n3. LOCKDOWN (runbook 4b)")
  armRun("lockdown")

  console.log("\n4. Token rules, on a migrate arm")
  {
    const a = tool("arm migrate", ["arm", "--purpose", "migrate", "--backup", backup, "--target", S])
    ok(a.code === 0 && existsSync(TOKEN), "armed")
    ok(/already armed/.test(tool("arm again", ["arm", "--purpose", "migrate", "--backup", backup, "--target", S]).out), "a second arm while armed: refused")
    const w = tool("run with the wrong purpose", ["run", "--purpose", "rollback", "--confirm", confirmFrom(a.out)], LIVE)
    ok(/armed for "migrate"/.test(w.out) && !existsSync(TOKEN), "wrong purpose: refused, AND the token is consumed (disarmed)")

    const tamper = (label: string, edit: (t: Record<string, unknown>) => void, expect: RegExp, extra: string[] = []) => {
      const a2 = tool(`arm migrate (${label})`, ["arm", "--purpose", "migrate", "--backup", backup, "--target", S])
      const t = JSON.parse(readFileSync(TOKEN, "utf8")); edit(t); writeFileSync(TOKEN, JSON.stringify(t))
      const r = tool(`run (${label})`, ["run", "--purpose", "migrate", "--confirm", confirmFrom(a2.out), ...extra], LIVE)
      ok(r.code !== 0 && expect.test(r.out) && !existsSync(TOKEN), `${label}: refused, token consumed`)
    }
    tamper("expired token", (t) => { t.expiresAt = new Date(Date.now() - 1000).toISOString() }, /expired/)
    tamper("counts changed since arming", (t) => { (t.counts as Record<string, number>).User += 1 }, /changed since arming/)
    tamper("backup hash changed", (t) => { t.backupSha256 = "0".repeat(64) }, /backup file changed/)
    tamper("another OS user", (t) => { t.osUser = "someone-else" }, /armed by someone-else/)
    tamper("wrong confirmation phrase", (t) => { t.code = "ZZZZZZ" }, /scratch confirmation must be exactly/)
    // The live path, without ever connecting: a token naming public, run from a pipe.
    tamper("live target, no terminal", (t) => { t.target = "public" }, /interactive terminal/, ["--confirm-live-migrate"])
    tamper("live target, no --confirm-live flag", (t) => { t.target = "public" }, /pass --confirm-live-migrate/)
    const st = tool("state after the refusals", ["verify", "--purpose", "lockdown", "--backup", backup, "--target", S])
    ok(/VERIFY LOCKDOWN PASSED/.test(st.out), "after every refusal the copy is still pre-v2, locked down, equal to the backup")
  }

  console.log("\n5. MIGRATE (runbook 5)")
  armRun("migrate")
  const vv = sh("verify-v2 --new <copy> --old <src> (the post-cutover form)", tsx, ["--env-file=.env", "scripts/schema-v2/verify-v2.ts", "--new", S, "--old", SRC], {},
    /read-only|FAIL|VERIFIED/)
  ok(vv.code === 0 && /SCHEMA V2 VERIFIED/.test(vv.out) && !/\bFAIL\b/.test(vv.out), "verify-v2: SCHEMA V2 VERIFIED, 0 FAIL, read-only proven")
  const ps = sh("prisma migrate status", prisma, ["migrate", "status"], { DATABASE_URL: `${liveUrl()}${liveUrl().includes("?") ? "&" : "?"}schema=${S}` }, /up to date|not yet been applied|different|Datasource/)
  ok(ps.code === 0 && /Database schema is up to date/.test(ps.out), "prisma migrate status: up to date")
  const again = tool("arm migrate again", ["arm", "--purpose", "migrate", "--backup", backup, "--target", S])
  ok(again.code !== 0 && /NO-GO/.test(again.out) && !existsSync(TOKEN), "arming migrate again on a migrated copy: NO-GO")

  console.log("\n6. ROLLBACK (runbook 8)")
  armRun("rollback")

  console.log("\n7. Clean up, then live")
  {
    const pg = new Client({ connectionString: liveUrl() }); await pg.connect()
    for (const s of [S, SRC]) await pg.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`)
    await pg.end()
  }
  ok(!existsSync(TOKEN), "no token left armed")
  const after = await liveSnapshot()
  console.log(`  live after:  ${after.summary}`)
  ok(after.text === before.text, "live public is identical before and after (counts, ledger, catalog fingerprint, _prisma_migrations)")

  console.log(`\n  timings:\n${timings.map((t) => `    ${t}`).join("\n")}`)
  console.log(failures ? `\n  CUTOVER TOOL E2E FAILED: ${failures}\n` : `\n  CUTOVER TOOL E2E PASSED\n`)
  process.exitCode = failures ? 1 : 0
}

main().catch((e) => { console.error(e); process.exit(1) })
