// Proves scripts/pg-backup.ts honours its target and refuses `public`, and
// that the test leaves live untouched.
//
//   npx tsx --env-file=.env scripts/schema-v2/test-pg-backup-target.ts <old-layout backup.sql> [--old-ref <schema>]
//
// Each step runs pg-backup.ts as a separate process with DATABASE_URL set, the
// same way an operator would. The only schemas written are schema_v2_cut_pgb,
// schema_v2_cut_pgb_v2 and schema_v2_cut_pgb_v2r (built here, dropped at the
// end) and restore_drill (inside a transaction that is rolled back). `public`
// is read, and snapshotted before and after.
//
// Sections 1-6 restore the OLD-layout backup. Their row-for-row check needs an
// old-layout copy of the same data: live `public` before the cutover, or
// --old-ref <schema> after it (e.g. schema_v2_cutgo_src).
//
// Section 8 (5 Oct 2026, after the cutover) is the v2 layout: a v2 copy seeded
// with report case -> AdminAction(caseId) -> appeal case(actionId), the rows
// that make AdminAction <-> ModerationCase a table-level cycle; dump, drill,
// restore into a second v2 copy and compare all 25 tables row for row; then
// two rows that truly reference each other must fail the dump, naming both.
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { Client } from "pg"
import { liveSnapshot, liveUrl } from "../lib/live-snapshot"

const S = "schema_v2_cut_pgb", V = "schema_v2_cut_pgb_v2", R = "schema_v2_cut_pgb_v2r"
const backup = process.argv[2]
if (!backup) { console.error("usage: test-pg-backup-target.ts <old-layout backup.sql> [--old-ref <schema>]"); process.exit(2) }
const refArg = process.argv.indexOf("--old-ref") > 0 ? process.argv[process.argv.indexOf("--old-ref") + 1] : undefined

let failures = 0
const ok = (cond: boolean, msg: string) => { console.log(`  ${cond ? "ok  " : "FAIL"}  ${msg}`); if (!cond) failures++ }
const withSchema = (schema?: string) => { const u = new URL(liveUrl()); if (schema) u.searchParams.set("schema", schema); return u.toString() }
const tsx = process.platform === "win32" ? "node_modules\\.bin\\tsx.cmd" : "node_modules/.bin/tsx"

function run(label: string, args: string[], schema?: string, stdin: "pipe" | "ignore" = "ignore") {
  const r = spawnSync(tsx, args, {
    env: { ...process.env, DATABASE_URL: withSchema(schema), DATABASE_POOL_URL: "" },
    encoding: "utf8", shell: process.platform === "win32", stdio: [stdin, "pipe", "pipe"], input: stdin === "pipe" ? "" : undefined, timeout: 300_000,
  })
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
  console.log(`  .. ${label}: exit ${r.status}`)
  for (const l of out.split(/\r?\n/).filter((l) => /target|REFUS|RESTORED|DRILL|MISMATCH|truncated|FAILED|confirm|interactive|not empty|note|restored /.test(l))) console.log(`       | ${l.trim().slice(0, 150)}`)
  return { code: r.status, out }
}

async function schemaCounts(schema: string): Promise<Record<string, number>> {
  const pg = new Client({ connectionString: liveUrl() }); await pg.connect()
  try {
    await pg.query(`SET SESSION default_transaction_read_only = on`)
    const t = (await pg.query(`SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename <> '_prisma_migrations' ORDER BY 1`, [schema])).rows.map((r) => r.tablename as string)
    const out: Record<string, number> = {}
    for (const x of t) out[x] = Number((await pg.query(`SELECT count(*) n FROM "${schema}"."${x}"`)).rows[0].n)
    return out
  } finally { await pg.end() }
}

async function main() {
  const u = new URL(liveUrl())
  console.log(`  target  host=${u.hostname}:${u.port}  database=${u.pathname.slice(1)}  writes ONLY to ${S} and a rolled-back restore_drill; public is read`)
  const before = await liveSnapshot()
  console.log(`  live before: ${before.summary}\n  grants:      ${before.grants}\n`)

  const claimed = Object.fromEntries((/-- rowcounts: (.*)/.exec(readFileSync(backup, "utf8"))?.[1] ?? "").split(/\s+/).filter(Boolean).map((p: string) => { const [t, n] = p.split("="); return [t, Number(n)] }))

  console.log("1. Build an empty pre-v2 structure in the scratch schema")
  ok(run("build-old", ["--env-file=.env", "scripts/schema-v2/cutover-rehearsal.ts", "build-old", "--schema", S, "--replace"]).code === 0, `${S} built`)

  console.log("\n2. restore into the scratch schema (?schema= honoured)")
  const r1 = run("restore", ["scripts/pg-backup.ts", "restore", backup], S)
  ok(r1.code === 0 && /RESTORED AND VERIFIED/.test(r1.out) && new RegExp(`schema=${S}`).test(r1.out), "restored and verified, and its target line names the scratch schema")
  const c1 = await schemaCounts(S)
  ok(Object.keys(claimed).every((t) => c1[t] === claimed[t]) && Object.keys(c1).length === 34, `all 34 tables in ${S} equal the backup trailer`)
  // Row-for-row against live (whole rows as text: each schema has its own enum types).
  {
    const pg = new Client({ connectionString: liveUrl() }); await pg.connect()
    await pg.query(`SET SESSION default_transaction_read_only = on`)
    // Live is v2 since the cutover, so the old-layout reference is --old-ref.
    const ref = refArg ?? "public"
    const refOld = (await pg.query(`SELECT to_regclass($1) IS NOT NULL ok`, [`"${ref}"."TradeRequest"`])).rows[0].ok
    if (!refOld) console.log(`  note  "${ref}" is not in the old layout; pass --old-ref <old-layout copy of this backup> for the row-for-row check`)
    for (const t of refOld ? ["User", "LeafTransaction", "TradeRequest"] : []) {
      const d = Number((await pg.query(`SELECT (SELECT count(*) FROM (SELECT x::text FROM "${S}"."${t}" x EXCEPT SELECT y::text FROM "${ref}"."${t}" y) a) + (SELECT count(*) FROM (SELECT y::text FROM "${ref}"."${t}" y EXCEPT SELECT x::text FROM "${S}"."${t}" x) b) n`)).rows[0].n)
      ok(d === 0, `${t}: identical to "${ref}" row for row, every column (${d} differ)`)
    }
    ok(refOld, `old-layout reference available ("${ref}")`)
    await pg.end()
  }

  console.log("\n3. restore again without --force: refused, scratch unchanged")
  const r2 = run("restore (occupied)", ["scripts/pg-backup.ts", "restore", backup], S)
  ok(r2.code !== 0 && /not empty/.test(r2.out), "refused: target not empty")
  ok(JSON.stringify(await schemaCounts(S)) === JSON.stringify(c1), "scratch counts unchanged")

  console.log("\n4. restore --force: TRUNCATE and reload in ONE transaction, on the scratch schema only")
  const r3 = run("restore --force", ["scripts/pg-backup.ts", "restore", backup, "--force"], S)
  ok(r3.code === 0 && /truncated 34 tables in "schema_v2_cut_pgb"/.test(r3.out) && /RESTORED AND VERIFIED/.test(r3.out), "truncated the scratch schema's 34 tables, reloaded, verified")
  ok(JSON.stringify(await schemaCounts(S)) === JSON.stringify(c1), "scratch counts equal the backup again")

  console.log("\n5. restore aimed at public: always refused (the one live rollback is cutover-live.ts)")
  const toCutover = (out: string) => /never writes "public"/.test(out) && /cutover-live\.ts arm\|run\|verify --purpose rollback/.test(out)
  const r4 = run("restore, no ?schema= (public)", ["scripts/pg-backup.ts", "restore", backup, "--force"])
  ok(r4.code !== 0 && toCutover(r4.out) && !/RESTORED/.test(r4.out), "public: refused before connecting, pointing at cutover-live.ts rollback")
  const r5 = run("restore public with the retired --confirm-live-rollback flag", ["scripts/pg-backup.ts", "restore", backup, "--force", "--confirm-live-rollback"], undefined, "pipe")
  ok(r5.code !== 0 && toCutover(r5.out) && !/RESTORED/.test(r5.out), "the old --confirm-live-rollback flag opens nothing")
  const r6 = run("restore ?schema=public explicitly", ["scripts/pg-backup.ts", "restore", backup], "public")
  ok(r6.code !== 0 && toCutover(r6.out), "?schema=public: refused the same way")
  const r7 = run("restore ?schema=auth", ["scripts/pg-backup.ts", "restore", backup], "auth")
  ok(r7.code !== 0 && /REFUSING/.test(r7.out), "a non-scratch schema (auth): refused")

  console.log("\n6. drill: builds the dump's own layout, restores, rolls back")
  const r8 = run("drill", ["scripts/pg-backup.ts", "drill", backup], refArg)
  ok(r8.code === 0 && /RESTORE DRILL PASSED/.test(r8.out), "drill passed")
  {
    const pg = new Client({ connectionString: liveUrl() }); await pg.connect()
    const left = (await pg.query(`SELECT count(*)::int n FROM pg_namespace WHERE nspname = 'restore_drill'`)).rows[0].n
    await pg.end()
    ok(left === 0, "no restore_drill schema left behind")
  }

  console.log("\n8. The v2 layout: the AdminAction <-> ModerationCase cycle, generated columns")
  await v2Case()

  {
    const pg = new Client({ connectionString: liveUrl() }); await pg.connect()
    for (const s of [S, V, R]) await pg.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`)
    await pg.end()
  }

  console.log("\n9. Live untouched")
  const after = await liveSnapshot()
  console.log(`  live after:  ${after.summary}\n  grants:      ${after.grants}`)
  ok(after.full === before.full, "live public is identical before and after (counts, ledger, catalog fingerprint, _prisma_migrations, grants and default ACLs)")

  console.log(failures ? `\n  PG-BACKUP TARGET TEST FAILED: ${failures}\n` : `\n  PG-BACKUP TARGET TEST PASSED\n`)
  process.exitCode = failures ? 1 : 0
}

/** Writes ONLY the test's own schema_v2_cut_pgb_* copies, always schema-qualified. */
async function scratch<T>(fn: (pg: Client) => Promise<T>): Promise<T> {
  const pg = new Client({ connectionString: liveUrl() }); await pg.connect()
  try { return await fn(pg) } finally { await pg.end() }
}

/** A v2 copy of the backup: the old layout, the six v2 migrations in one transaction. */
async function buildV2(schema: string) {
  if (!/^schema_v2_cut_pgb_/.test(schema)) throw new Error(`not this test's schema: ${schema}`)
  const a = run(`restore-old (${schema})`, ["--env-file=.env", "scripts/schema-v2/cutover-rehearsal.ts", "restore-old", backup, "--schema", schema, "--replace"])
  // restore-old copies live's _prisma_migrations, which holds the v2 rows since
  // the cutover; an old-layout copy must not claim them.
  const removed = await scratch(async (pg) => (await pg.query(`DELETE FROM "${schema}"."_prisma_migrations" WHERE migration_name LIKE '2026100%_schema_v2_%'`)).rowCount)
  const b = run(`apply-single (${schema})`, ["--env-file=.env", "scripts/schema-v2/cutover-rehearsal.ts", "apply-single", "--schema", schema])
  const n = await scratch(async (pg) => Number((await pg.query(`SELECT count(*) n FROM pg_tables WHERE schemaname = $1 AND tablename <> '_prisma_migrations'`, [schema])).rows[0].n))
  ok(a.code === 0 && b.code === 0 && n === 25, `${schema}: v2 copy built (${n} tables; ${removed} copied v2 _prisma_migrations rows removed first)`)
}

async function v2Case() {
  const tmp = process.env.TEMP ?? process.env.TMPDIR ?? "."
  const file = `${tmp}\\pgb-v2-${Date.now()}.sql`, bad = `${tmp}\\pgb-v2-cycle-${Date.now()}.sql`
  await buildV2(V)

  // report case -> action answering it (caseId) -> appeal of that action (actionId)
  await scratch(async (pg) => {
    const s = (t: string) => `"${V}"."${t}"`
    const { uid, iid } = (await pg.query(`SELECT (SELECT id FROM ${s("User")} ORDER BY id LIMIT 1) uid, (SELECT id FROM ${s("Item")} ORDER BY id LIMIT 1) iid`)).rows[0]
    await pg.query("BEGIN")
    await pg.query(`INSERT INTO ${s("ModerationCase")} (id, type, "filedById", status, "targetType", "targetId", category) VALUES ('pgbtest-report', 'REPORT', $1, 'ACTIONED', 'LISTING', $2, 'SPAM')`, [uid, iid])
    await pg.query(`INSERT INTO ${s("AdminAction")} (id, "actorId", action, "targetType", "targetId", "caseId", reason) VALUES ('pgbtest-action', $1, 'LISTING_HIDDEN', 'LISTING', $2, 'pgbtest-report', 'pg-backup test')`, [uid, iid])
    await pg.query(`INSERT INTO ${s("ModerationCase")} (id, type, "filedById", status, "itemId", "appealKind", message, "actionId") VALUES ('pgbtest-appeal', 'LISTING_APPEAL', $1, 'OPEN', $2, 'VALUE_REJECTION', 'pg-backup test', 'pgbtest-action')`, [uid, iid])
    await pg.query("COMMIT")
  })
  const caseSet = await scratch(async (pg) => Number((await pg.query(`SELECT count(*) n FROM "${V}"."AdminAction" WHERE "caseId" IS NOT NULL`)).rows[0].n))
  ok(caseSet >= 1, `${V}: seeded report -> AdminAction(caseId) -> appeal(actionId); ${caseSet} AdminAction row(s) with caseId set`)

  const d = run("dump the v2 copy", ["scripts/pg-backup.ts", "dump", file], V)
  ok(d.code === 0, "v2 dump written")
  const sql = readFileSync(file, "utf8")
  const at = (id: string) => sql.indexOf(`VALUES ('${id}'`)
  ok(at("pgbtest-report") > 0 && at("pgbtest-report") < at("pgbtest-action") && at("pgbtest-action") < at("pgbtest-appeal"),
    "rows interleaved in reference order: report case, then the action (caseId), then the appeal (actionId)")
  ok((sql.match(/^-- table: /gm) ?? []).length === 25 && /cyclic group AdminAction <-> ModerationCase/.test(sql), "25 `-- table:` lines, the cyclic group named")
  ok(!/"bracket"/.test(sql), "the generated column Item.bracket is not written")

  const dr = run("drill the v2 dump", ["scripts/pg-backup.ts", "drill", file], V)
  ok(dr.code === 0 && /RESTORE DRILL PASSED/.test(dr.out), "drill passed on the v2 dump")

  await buildV2(R)
  const rr = run("restore --force into the second v2 copy", ["scripts/pg-backup.ts", "restore", file, "--force"], R)
  ok(rr.code === 0 && /RESTORED AND VERIFIED/.test(rr.out), `restored into ${R}`)
  await scratch(async (pg) => {
    await pg.query(`SET SESSION default_transaction_read_only = on`)
    const tables = (await pg.query(`SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename <> '_prisma_migrations' ORDER BY 1`, [V])).rows.map((r) => r.tablename as string)
    const differ: string[] = []
    for (const t of tables) {
      const n = Number((await pg.query(`SELECT (SELECT count(*) FROM (SELECT x::text FROM "${V}"."${t}" x EXCEPT SELECT y::text FROM "${R}"."${t}" y) a) + (SELECT count(*) FROM (SELECT y::text FROM "${R}"."${t}" y EXCEPT SELECT x::text FROM "${V}"."${t}" x) b) n`)).rows[0].n)
      if (n) differ.push(`${t} ${n}`)
    }
    ok(tables.length === 25 && differ.length === 0, `all ${tables.length} tables identical row for row, every column incl. Item.bracket (${differ.join(", ") || "0 differ"})`)
  })

  // Negative: two rows that truly reference each other.
  await scratch(async (pg) => {
    const s = (t: string) => `"${V}"."${t}"`
    const { uid, iid } = (await pg.query(`SELECT (SELECT id FROM ${s("User")} ORDER BY id LIMIT 1) uid, (SELECT id FROM ${s("Item")} ORDER BY id LIMIT 1) iid`)).rows[0]
    await pg.query("BEGIN")
    await pg.query(`INSERT INTO ${s("AdminAction")} (id, "actorId", action, "targetType", "targetId", reason) VALUES ('pgbtest-cyc-action', $1, 'LISTING_HIDDEN', 'LISTING', $2, 'pg-backup test')`, [uid, iid])
    await pg.query(`INSERT INTO ${s("ModerationCase")} (id, type, "filedById", status, "itemId", "appealKind", message, "actionId") VALUES ('pgbtest-cyc-appeal', 'LISTING_APPEAL', $1, 'OPEN', $2, 'VALUE_REJECTION', 'pg-backup test', 'pgbtest-cyc-action')`, [uid, iid])
    await pg.query(`UPDATE ${s("AdminAction")} SET "caseId" = 'pgbtest-cyc-appeal' WHERE id = 'pgbtest-cyc-action'`)
    await pg.query("COMMIT")
  })
  const neg = run("dump with a true row-level cycle", ["scripts/pg-backup.ts", "dump", bad], V)
  ok(neg.code !== 0 && /row-level foreign-key cycle/.test(neg.out) && /pgbtest-cyc-action/.test(neg.out) && /pgbtest-cyc-appeal/.test(neg.out),
    `true cycle: the dump fails, naming both rows (${(/row-level[^\n]*/.exec(neg.out)?.[0] ?? "no message").slice(0, 170)})`)
}

main().catch((e) => { console.error(e); process.exit(1) })
