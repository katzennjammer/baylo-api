// Proves the post-cutover guards on branch feature/schema-v2-post-cutover.
//
//   npx tsx --env-file=.env scripts/schema-v2/test-post-cutover-guards.ts <v2 copy> <pre-v2 copy>
//   e.g.  ... schema_v2_cut_suite schema_v2_wk1_src
//
//   1  prisma/command-guard.ts, unit: on public only migrate status/deploy/diff/
//      resolve pass; reset, dev, db push and every other DB command refuse;
//      on a scratch copy everything passes; layoutVerdict
//   2  the REAL Prisma CLI through prisma.config.ts, against a DEAD host
//      (127.0.0.1:1): a refused command exits with the guard's message and
//      never tries to connect; an allowed one gets past the guard and fails
//      only on the connection. If the guard were wrong, there is nothing at
//      that address to harm.
//   3  the server's startup gate (checkV2Database, what instrumentation.ts runs):
//      the v2 copy STARTS, the pre-v2 copy REFUSES, and live `public`, still
//      pre-v2, REFUSES. Every one of these is a read (to_regclass lookups).
//   4  live untouched: the same snapshot before and after
import { spawnSync } from "node:child_process"
import { refusal, commandOf } from "../../prisma/command-guard"
import { layoutVerdict, V2_ONLY_TABLES, PRE_V2_ONLY_TABLES, assertV2Schema } from "../../src/lib/db-schema"
import { liveSnapshot, liveUrl } from "../lib/live-snapshot"

const [V2COPY, OLDCOPY] = process.argv.slice(2)
if (!V2COPY || !OLDCOPY) { console.error("usage: test-post-cutover-guards.ts <v2 copy> <pre-v2 copy>"); process.exit(2) }

let failures = 0
const ok = (c: boolean, m: string) => { console.log(`  ${c ? "ok  " : "FAIL"}  ${m}`); if (!c) failures++ }
const bin = (n: string) => (process.platform === "win32" ? `node_modules\\.bin\\${n}.cmd` : `node_modules/.bin/${n}`)
function run(b: string, args: string[], url: string) {
  if (process.platform === "win32") args = args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a))
  const r = spawnSync(b, args, { env: { ...process.env, DATABASE_URL: url, DATABASE_POOL_URL: "" }, encoding: "utf8", shell: process.platform === "win32", timeout: 180_000 })
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}
const withSchema = (s?: string) => { const u = new URL(liveUrl()); if (s) u.searchParams.set("schema", s); return u.toString() }

async function main() {
  const u = new URL(liveUrl())
  console.log(`  target  host=${u.hostname}:${u.port}  database=${u.pathname.slice(1)}  READS ONLY (${V2COPY}, ${OLDCOPY}, public); the CLI tests use a dead host`)
  const before = await liveSnapshot()
  console.log(`  live before: ${before.summary}\n`)

  console.log("1. command-guard and layoutVerdict (unit)")
  const LIVE = "postgresql://u:p@db.example/postgres", COPY = "postgresql://u:p@db.example/postgres?schema=schema_v2_x"
  for (const a of [["migrate", "status"], ["migrate", "deploy"], ["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma"], ["migrate", "resolve", "--applied", "x"]])
    ok(refusal(a, LIVE) === null, `public: prisma ${a.join(" ")} allowed`)
  for (const a of [["migrate", "reset", "--force"], ["migrate", "dev"], ["migrate", "dev", "--create-only"], ["db", "push"], ["db", "push", "--accept-data-loss"], ["db", "execute", "--file", "x.sql"], ["db", "pull"], ["db", "seed"], ["studio"], ["introspect"], ["--schema", "prisma/schema.prisma", "migrate", "reset"]])
    ok(refusal(a, LIVE) !== null, `public: prisma ${a.join(" ")} REFUSED`)
  ok(refusal(["migrate", "reset", "--force"], "postgresql://u:p@h/postgres?schema=auth") !== null, "another non-scratch schema (auth): reset REFUSED")
  for (const a of [["migrate", "reset", "--force"], ["db", "push"], ["migrate", "dev"]]) ok(refusal(a, COPY) === null, `schema_v2_x: prisma ${a.join(" ")} allowed`)
  for (const a of [["generate"], ["validate"], ["format"]]) ok(commandOf(a) === null && refusal(a, LIVE) === null, `prisma ${a[0]}: needs no database, not inspected`)
  ok(layoutVerdict(new Set(V2_ONLY_TABLES)).ok, "layoutVerdict: the full v2 set is v2")
  ok(!layoutVerdict(new Set(PRE_V2_ONLY_TABLES)).ok, "layoutVerdict: the pre-v2 set is refused")
  ok(!layoutVerdict(new Set([...V2_ONLY_TABLES, "Offer"])).ok, "layoutVerdict: v2 plus a leftover Offer (half state) is refused")
  ok(!layoutVerdict(new Set(V2_ONLY_TABLES.filter((t) => t !== "Trade"))).ok, "layoutVerdict: v2 without Trade (trade held back) is refused on this branch")
  ok((() => { try { assertV2Schema("public"); assertV2Schema("schema_v2_x"); assertV2Schema("scratch_y"); return true } catch { return false } })(), "assertV2Schema: public, schema_v2_*, scratch_* accepted by name")
  ok((() => { try { assertV2Schema("auth"); return false } catch { return true } })(), "assertV2Schema: other names (auth) refused")

  console.log("\n2. The real Prisma CLI, through prisma.config.ts, against a dead host")
  const DEAD = "postgresql://nobody:nothing@127.0.0.1:1/postgres"
  for (const a of [["migrate", "reset", "--force"], ["migrate", "dev", "--name", "x"], ["db", "push", "--accept-data-loss"]]) {
    const r = run(bin("prisma"), a, DEAD)
    ok(r.code !== 0 && /\[schema v2\] REFUSING/.test(r.out) && !/P1001|Can't reach/.test(r.out), `prisma ${a.join(" ")} on public: refused by the guard before any connection`)
  }
  {
    const r = run(bin("prisma"), ["migrate", "status"], DEAD)
    ok(!/\[schema v2\] REFUSING/.test(r.out) && /P1001|Can't reach|ECONNREFUSED/.test(r.out), "prisma migrate status on public: passes the guard (fails only on the dead host)")
  }

  console.log("\n3. The server's startup gate (what instrumentation.ts runs at boot)")
  const gate = (s?: string) => run(bin("tsx"), ["scripts/schema-v2/_startup-gate.ts"], withSchema(s))
  const g1 = gate(V2COPY)
  console.log(`       | ${g1.out.trim().split(/\r?\n/).filter((l) => /schema v2/.test(l)).join(" | ").slice(0, 200)}`)
  ok(g1.code === 0 && /v2 layout confirmed/.test(g1.out), `${V2COPY} (v2): STARTS`)
  const g2 = gate(OLDCOPY)
  console.log(`       | ${g2.out.trim().split(/\r?\n/).filter((l) => /schema v2/.test(l)).join(" | ").slice(0, 200)}`)
  ok(g2.code === 1 && /REFUSING to start: schema "[^"]+" is not in the v2 layout/.test(g2.out) && /still has pre-v2/.test(g2.out), `${OLDCOPY} (pre-v2): REFUSES`)
  const g3 = gate(undefined)
  console.log(`       | ${g3.out.trim().split(/\r?\n/).filter((l) => /schema v2/.test(l)).join(" | ").slice(0, 200)}`)
  ok(g3.code === 1 && /schema "public" is not in the v2 layout/.test(g3.out) && /live has not been migrated/.test(g3.out), "public (live, still pre-v2): REFUSES")

  console.log("\n4. Live untouched")
  const after = await liveSnapshot()
  console.log(`  live after:  ${after.summary}`)
  ok(after.text === before.text, "live public is identical before and after")

  console.log(failures ? `\n  POST-CUTOVER GUARD TEST FAILED: ${failures}\n` : `\n  POST-CUTOVER GUARD TEST PASSED\n`)
  process.exitCode = failures ? 1 : 0
}
main().catch((e) => { console.error(e); process.exit(1) })
