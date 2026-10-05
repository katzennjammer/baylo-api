// Proves scripts/lib/migration-runner.ts: a migration that carries its own
// BEGIN/COMMIT (or anything else that could leave the pinned schema) cannot
// reach `public`. It also proves that this test leaves live untouched.
//
//   npx tsx --env-file=.env scripts/schema-v2/test-migration-guard.ts
//
// NO LIVE WRITES, by construction. Every statement that could resolve to
// `public` if a guard were broken is a READ (current_schema(), txid). Every
// write in the test goes to schema_v2_cut_guardtest, or to a DECOY schema
// (schema_v2_cut_decoy) that stands in for `public` as the protected schema,
// so the backstop is tested by tripping it on the decoy, never on live.
//
//   0  every script that reads migration SQL imports the runner (static)
//   1  prepareBatch: strips plain BEGIN;/COMMIT;, refuses everything else
//      that could end the transaction or move the path, and does not
//      false-positive on strings or comments; the real chain and dump pass
//   2  the hazard is real: SET LOCAL plus an inner COMMIT leaves the session
//      on `public` (shown with a read)
//   3  the runner, given the same SQL, stays in ONE transaction on the
//      scratch schema
//   4  refusals happen before anything runs (target public, non-scratch),
//      and each one for the RIGHT reason (asserted by message); the live
//      stand-in refuses public; confirmLiveWrite's gates fire in order
//   5  backstop and pin re-check, tripped on the decoy: dynamic SQL that
//      writes rows, changes the catalog, takes a write lock, or moves the
//      search_path is rolled back, and the decoy is unchanged
//   6  live `public` is byte-for-byte the same before and after
import { Client } from "pg"
import { readFile, readdir } from "node:fs/promises"
import { GuardError, confirmLiveWrite, prepareBatch, preV2Chain, v2Chain, withGuardedTransaction } from "../lib/migration-runner"
import { liveSnapshot, liveUrl } from "../lib/live-snapshot"

const T = "schema_v2_cut_guardtest", DECOY = "schema_v2_cut_decoy"
let failures = 0
const ok = (cond: boolean, msg: string) => { console.log(`  ${cond ? "ok  " : "FAIL"}  ${msg}`); if (!cond) failures++ }
const throwsGuard = (fn: () => unknown) => { try { fn(); return false } catch (e) { return e instanceof GuardError } }
async function rejectsGuard(p: Promise<unknown>): Promise<string | false> {
  try { await p; return false } catch (e) { return e instanceof GuardError ? (e as Error).message : false }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (d.name === "node_modules" || d.name.startsWith(".")) continue
    const p = `${dir}/${d.name}`
    if (d.isDirectory()) out.push(...(await walk(p)))
    else if (/\.(ts|mts|mjs|js|ps1)$/.test(d.name)) out.push(p)
  }
  return out
}

async function main() {
  const u = new URL(liveUrl())
  console.log(`  target  host=${u.hostname}:${u.port}  database=${u.pathname.slice(1)}  writes ONLY to ${T}, ${DECOY}; public is read`)
  const before = await liveSnapshot()
  console.log(`  live before: ${before.summary}\n  grants:      ${before.grants}\n`)

  // ── 0 ──
  console.log("0. Every script that runs migration SQL goes through the runner")
  // The MySQL-era PowerShell script drives mysql.exe against MariaDB, never Postgres.
  const exempt = new Map([["scripts/apply-leaves-migration.ps1", "MariaDB only (mysql.exe), predates Postgres"]])
  for (const f of await walk("scripts")) {
    const src = await readFile(f, "utf8")
    if (!/migration\.sql|prisma\/migrations/.test(src) || f.endsWith("lib/migration-runner.ts") || f.endsWith("test-migration-guard.ts")) continue
    if (exempt.has(f)) { console.log(`  skip  ${f}: ${exempt.get(f)}`); continue }
    ok(/from ["'][./]*\/?lib\/migration-runner["']|from ["']\.\.\/lib\/migration-runner["']|from ["']\.\/lib\/migration-runner["']/.test(src), `${f} imports lib/migration-runner`)
  }

  // ── 1 ──
  console.log("\n1. prepareBatch")
  const strip = prepareBatch("t", "migration", `CREATE TABLE "a"(x int);\nBEGIN;\nCREATE TABLE "b"(x int);\nCOMMIT;\n`)
  ok(strip.stripped === 2 && !/\bBEGIN\b|\bCOMMIT\b/.test(strip.sql), "plain BEGIN; / COMMIT; are stripped (2)")
  const refused: [string, string][] = [
    ["ROLLBACK", `CREATE TABLE "a"(x int); ROLLBACK;`], ["END", `END;`], ["SAVEPOINT", `SAVEPOINT s;`],
    ["RELEASE", `RELEASE SAVEPOINT s;`], ["COMMIT AND CHAIN", `COMMIT AND CHAIN;`], ["START TRANSACTION", `START TRANSACTION;`],
    ["BEGIN ISOLATION LEVEL", `BEGIN ISOLATION LEVEL SERIALIZABLE;`], ["PREPARE TRANSACTION", `PREPARE TRANSACTION 'x';`],
    ["SET search_path", `SET search_path TO "x";`], ["SET LOCAL search_path", `SET LOCAL search_path = x;`],
    ["SET SESSION search_path", `SET SESSION search_path TO x;`], ["SET SCHEMA", `SET SCHEMA 'x';`],
    ["RESET search_path", `RESET search_path;`], ["RESET ALL", `RESET ALL;`], ["DISCARD", `DISCARD ALL;`],
    ["SET ROLE", `SET ROLE anon;`], ["SET SESSION AUTHORIZATION", `SET SESSION AUTHORIZATION anon;`],
    ["set_config", `SELECT set_config('search_path', 'x', false);`],
    ["public. qualified", `INSERT INTO public."User" (id) VALUES ('x');`], ["\"public\". qualified", `DELETE FROM "public"."User";`],
    ["'public' literal", `SELECT 1 FROM pg_tables WHERE schemaname = 'public';`], ["CREATE SCHEMA", `CREATE SCHEMA x;`],
    ["DROP SCHEMA", `DROP SCHEMA x CASCADE;`], ["COMMIT inside DO", `DO $$ BEGIN COMMIT; END $$;`],
    ["ROLLBACK inside tagged DO", `DO $body$ BEGIN ROLLBACK; END $body$;`],
  ]
  for (const [what, sql] of refused) ok(throwsGuard(() => prepareBatch("t", "migration", sql)), `refuses ${what}`)
  const benign = prepareBatch("t", "migration", `-- COMMIT; BEGIN; public.x\nINSERT INTO "t" VALUES ('BEGIN; COMMIT; ROLLBACK;');\n/* SET search_path */ DO $$ BEGIN IF true THEN NULL; END IF; END $$;`)
  ok(benign.stripped === 0 && benign.sql.includes("'BEGIN; COMMIT; ROLLBACK;'"), "no false positive on strings, comments or DO-block BEGIN/END")
  ok(throwsGuard(() => prepareBatch("d", "data", `INSERT INTO "public"."User" ("id") VALUES ('x');`)), "data: refuses a qualified INSERT")
  ok(throwsGuard(() => prepareBatch("d", "data", `DELETE FROM "User";`)), "data: refuses anything but INSERT")
  ok(!throwsGuard(() => prepareBatch("d", "data", `SET standard_conforming_strings = on;\nBEGIN;\nINSERT INTO "User" ("id") VALUES ('a; COMMIT; DROP TABLE x');\nCOMMIT;\n`)), "data: a dump with ';' and COMMIT inside a value passes")
  const chain = [...(await preV2Chain()), ...(await v2Chain())]
  const dr = chain.find((m) => m.name === "20260925000003_drop_removed_roles")!
  ok(chain.length === 33 && dr.batch.stripped === 2 && chain.filter((m) => m.batch.stripped).length === 1, `the real chain (33 files) passes; only drop_removed_roles needed stripping (${dr.batch.stripped})`)

  const pg = new Client({ connectionString: liveUrl() })
  await pg.connect()
  try {
    await pg.query(`DROP SCHEMA IF EXISTS "${T}" CASCADE`)
    await pg.query(`DROP SCHEMA IF EXISTS "${DECOY}" CASCADE`)
    await withGuardedTransaction(pg, { target: T, create: "fresh" }, async () => {})
    await withGuardedTransaction(pg, { target: DECOY, create: "fresh" }, async (g) => { await g.query(`CREATE TABLE "d" (x int)`) })

    // ── 2 ── the hazard, shown with READS only
    console.log("\n2. The hazard is real (naive SET LOCAL + inner COMMIT), shown with reads only")
    await pg.query("BEGIN")
    await pg.query(`SET LOCAL search_path TO "${T}"`)
    const naive = (await pg.query(`SELECT current_schema() AS s; BEGIN; SELECT 1; COMMIT; SELECT current_schema() AS s`)) as unknown as { rows: { s: string }[] }[]
    await pg.query("ROLLBACK").catch(() => {}) // already committed by the inner COMMIT; harmless
    const s0 = naive[0].rows[0].s, s1 = naive[naive.length - 1].rows[0].s
    ok(s0 === T && s1 === "public", `before the inner COMMIT the session was on "${s0}"; after it, on "${s1}" (this is how 4 Oct reached live)`)

    // ── 3 ── the runner with a migration that carries its own BEGIN/COMMIT
    console.log("\n3. The runner, same shape of migration")
    const mig = prepareBatch("synthetic", "migration",
      `SELECT txid_current() AS t, current_schema() AS s;\nCREATE TABLE "guard_a" (x int);\nBEGIN;\nCREATE TABLE "guard_b" (x int);\nCOMMIT;\nSELECT txid_current() AS t, current_schema() AS s;\n`)
    const res = (await withGuardedTransaction(pg, { target: T }, (g) => g.run(mig))) as { rows: { t: string; s: string }[] }[]
    const first = res.find((r) => r.rows?.[0]?.t)!.rows[0], last = [...res].reverse().find((r) => r.rows?.[0]?.t)!.rows[0]
    ok(first.t === last.t, `one transaction throughout: txid ${first.t} before and ${last.t} after the (stripped) COMMIT`)
    ok(first.s === T && last.s === T, `current_schema() was "${first.s}" before and "${last.s}" after`)
    const where = (await pg.query(`SELECT to_regclass('"${T}"."guard_a"') IS NOT NULL a, to_regclass('"${T}"."guard_b"') IS NOT NULL b, to_regclass('public."guard_a"') IS NOT NULL pa, to_regclass('public."guard_b"') IS NOT NULL pb`)).rows[0]
    ok(where.a && where.b && !where.pa && !where.pb, `guard_a and guard_b landed in ${T}; public has neither`)

    // ── 4 ── refusals before anything runs, each for the RIGHT reason. On
    // 5 Oct the live lockdown was refused by the protected-schema check, and
    // these used to assert only "refused", which any guard satisfies.
    console.log("\n4. Refused targets (before BEGIN), each for the right reason")
    const why = async (o: Parameters<typeof withGuardedTransaction>[1]) => (await rejectsGuard(withGuardedTransaction(pg, o, async () => {}))) || ""
    const because = (msg: string, re: RegExp, label: string) =>
      ok(re.test(msg), `${label}: ${msg ? msg.replace(/^\[migration guard\] /, "").slice(0, 110) : "NOT REFUSED"}`)
    const noAuth = /without a confirmed live authorization/
    because(await why({ target: "public" }), noAuth, "target public, no authorization")
    because(await why({ target: "public", live: { purpose: "lockdown", target: "public" } as never, purpose: "lockdown" }), noAuth, "target public, forged authorization object")
    for (const t of ["extensions", "auth", "storage", "Public"]) because(await why({ target: t }), /only schema_v2_\*, scratch_\* or restore_drill/, `target "${t}"`)
    because(await why({ target: T, protect: T }), /is the protected schema/, "scratch target equal to the protected schema")
    ok(!/protected schema/.test(await why({ target: "public" })), "public is never refused as 'the protected schema' (the 5 Oct bug)")

    console.log("\n4b. The live stand-in (BAYLO_LIVE_STANDIN), in-process")
    process.env.BAYLO_LIVE_STANDIN = T
    because(await why({ target: "public" }), /STAND-IN \(not live\) rehearsal/, "stand-in set: target public")
    because(await why({ target: T }), /refusing to write "schema_v2_cut_guardtest" \(STAND-IN \(not live\)\) without a confirmed live authorization/, "stand-in set: the stand-in itself, no authorization")
    because((await rejectsGuard(confirmLiveWrite("lockdown", "host", "public"))) || "", /STAND-IN \(not live\) rehearsal/, "stand-in set: confirmLiveWrite for public")
    process.env.BAYLO_LIVE_STANDIN = "schema_v2_wk1"
    because(await why({ target: T }), /is not a schema_v2_cut\* scratch schema/, "a stand-in that is not a schema_v2_cut* copy")
    delete process.env.BAYLO_LIVE_STANDIN

    console.log("\n4c. confirmLiveWrite's gates, in order")
    const envBefore = process.env.BAYLO_CUTOVER_LIVE
    delete process.env.BAYLO_CUTOVER_LIVE
    because((await rejectsGuard(confirmLiveWrite("lockdown", "host"))) || "", /BAYLO_CUTOVER_LIVE=1 is not set/, "no BAYLO_CUTOVER_LIVE=1")
    process.env.BAYLO_CUTOVER_LIVE = "1"
    because((await rejectsGuard(confirmLiveWrite("lockdown", "host"))) || "", /pass --confirm-live-lockdown/, "no --confirm-live-lockdown flag")
    because((await rejectsGuard(confirmLiveWrite("lockdown", "host", "schema_v2_wk1"))) || "", /is not a live target/, "a target that is neither public nor the stand-in")
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.argv.push("--confirm-live-lockdown")
      because((await rejectsGuard(confirmLiveWrite("lockdown", "host"))) || "", /needs an interactive terminal/, "flag but no terminal")
      process.argv.pop()
    } else console.log("  skip  flag-but-no-terminal (this run HAS a terminal; the e2e test covers it from a pipe)")
    if (envBefore === undefined) delete process.env.BAYLO_CUTOVER_LIVE; else process.env.BAYLO_CUTOVER_LIVE = envBefore

    // ── 5 ── backstop and pin, on the decoy
    console.log(`\n5. Backstop and pin re-check, tripped on the decoy "${DECOY}" (standing in for public)`)
    const dq = `quote_ident('${DECOY}')` // dynamic, so the static check cannot see it: this exercises the runtime layers
    const sneaky: [string, string][] = [
      ["dynamic INSERT", `DO $$ BEGIN EXECUTE 'INSERT INTO ' || ${dq} || '."d" VALUES (1)'; END $$;`],
      ["dynamic ALTER TABLE (catalog)", `DO $$ BEGIN EXECUTE 'ALTER TABLE ' || ${dq} || '."d" ADD COLUMN y int'; END $$;`],
      ["zero-row UPDATE (write lock only)", `DO $$ BEGIN EXECUTE 'UPDATE ' || ${dq} || '."d" SET x = 1 WHERE false'; END $$;`],
      ["dynamic CREATE TABLE in the decoy", `DO $$ BEGIN EXECUTE 'CREATE TABLE ' || ${dq} || '."sneak" (x int)'; END $$;`],
      ["dynamic path move (search_ + path)", `DO $$ BEGIN EXECUTE 'SET search_' || 'path TO ' || ${dq}; END $$;`],
      ["dynamic GRANT to anon (grants)", `DO $$ BEGIN EXECUTE 'GRANT SELECT ON ' || ${dq} || '."d" TO anon'; END $$;`],
      ["dynamic default privileges (default ACLs)", `DO $$ BEGIN EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA ' || ${dq} || ' GRANT SELECT ON TABLES TO authenticated'; END $$;`],
    ]
    for (const [what, sql] of sneaky) {
      const b = prepareBatch(what, "migration", `CREATE TABLE "victim_${what.replace(/\W+/g, "_")}" (x int);\n${sql}`)
      const msg = await rejectsGuard(withGuardedTransaction(pg, { target: T, protect: DECOY }, (g) => g.run(b)))
      ok(!!msg, `${what}: rolled back${msg ? ` (${msg.replace(/^\[migration guard\] /, "").slice(0, 240)})` : " -- NOT CAUGHT"}`)
      const kept = (await pg.query(`SELECT to_regclass('"${T}"."victim_${what.replace(/\W+/g, "_")}"') IS NOT NULL v`)).rows[0].v
      ok(!kept, `${what}: the batch's own scratch work was rolled back too`)
    }
    const decoy = (await pg.query(`SELECT (SELECT count(*)::int FROM "${DECOY}"."d") n,
      (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = '${DECOY}' AND table_name = 'd') cols,
      (SELECT count(*)::int FROM pg_tables WHERE schemaname = '${DECOY}') tables`)).rows[0]
    ok(decoy.n === 0 && decoy.cols === 1 && decoy.tables === 1, `decoy unchanged: ${decoy.n} rows, ${decoy.cols} column, ${decoy.tables} table`)
    const sp = (await pg.query(`SELECT current_setting('search_path') sp`)).rows[0].sp
    ok(!/schema_v2_cut/.test(sp), `session search_path reset after the runs (${sp})`)
  } finally {
    await pg.query(`DROP SCHEMA IF EXISTS "${T}" CASCADE`).catch(() => {})
    await pg.query(`DROP SCHEMA IF EXISTS "${DECOY}" CASCADE`).catch(() => {})
    await pg.end()
  }

  // ── 6 ──
  console.log("\n6. Live untouched")
  const after = await liveSnapshot()
  console.log(`  live after:  ${after.summary}\n  grants:      ${after.grants}`)
  ok(after.full === before.full, "live public is identical before and after (counts, ledger, catalog fingerprint, _prisma_migrations, grants and default ACLs)")

  console.log(failures ? `\n  MIGRATION GUARD TEST FAILED: ${failures}\n` : `\n  MIGRATION GUARD TEST PASSED\n`)
  process.exitCode = failures ? 1 : 0
}

main().catch((e) => { console.error(e); process.exit(1) })
