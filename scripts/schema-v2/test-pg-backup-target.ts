// Proves scripts/pg-backup.ts honours its target and refuses `public`, and
// that the test leaves live untouched.
//
//   npx tsx --env-file=.env scripts/schema-v2/test-pg-backup-target.ts <backup.sql>
//
// Each step runs pg-backup.ts as a separate process with DATABASE_URL set, the
// same way an operator would. The only schemas written are schema_v2_cut_pgb
// (built here, dropped at the end) and restore_drill (inside a transaction
// that is rolled back). `public` is read, and snapshotted before and after.
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { Client } from "pg"
import { liveSnapshot, liveUrl } from "../lib/live-snapshot"

const S = "schema_v2_cut_pgb"
const backup = process.argv[2]
if (!backup) { console.error("usage: test-pg-backup-target.ts <backup.sql>"); process.exit(2) }

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
    for (const t of ["User", "LeafTransaction", "TradeRequest"]) {
      const d = Number((await pg.query(`SELECT (SELECT count(*) FROM (SELECT x::text FROM "${S}"."${t}" x EXCEPT SELECT y::text FROM public."${t}" y) a) + (SELECT count(*) FROM (SELECT y::text FROM public."${t}" y EXCEPT SELECT x::text FROM "${S}"."${t}" x) b) n`)).rows[0].n)
      ok(d === 0, `${t}: identical to live row for row, every column (${d} differ)`)
    }
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
  const r8 = run("drill", ["scripts/pg-backup.ts", "drill", backup])
  ok(r8.code === 0 && /RESTORE DRILL PASSED/.test(r8.out), "drill passed")
  {
    const pg = new Client({ connectionString: liveUrl() }); await pg.connect()
    const left = (await pg.query(`SELECT count(*)::int n FROM pg_namespace WHERE nspname = 'restore_drill'`)).rows[0].n
    await pg.end()
    ok(left === 0, "no restore_drill schema left behind")
  }

  {
    const pg = new Client({ connectionString: liveUrl() }); await pg.connect()
    await pg.query(`DROP SCHEMA IF EXISTS "${S}" CASCADE`)
    await pg.end()
  }

  console.log("\n7. Live untouched")
  const after = await liveSnapshot()
  console.log(`  live after:  ${after.summary}\n  grants:      ${after.grants}`)
  ok(after.full === before.full, "live public is identical before and after (counts, ledger, catalog fingerprint, _prisma_migrations, grants and default ACLs)")

  console.log(failures ? `\n  PG-BACKUP TARGET TEST FAILED: ${failures}\n` : `\n  PG-BACKUP TARGET TEST PASSED\n`)
  process.exitCode = failures ? 1 : 0
}

main().catch((e) => { console.error(e); process.exit(1) })
