// The Category table, its labels, and the code that still sends them.
//
//   npx tsx --env-file=.env scripts/verify-category-table.ts            (static checks + the schema in DATABASE_URL)
//   npx tsx --env-file=.env scripts/verify-category-table.ts --static   (files only; no database)
//
// The API sends CATEGORY_LABELS from src/lib/v1/taxonomy.ts, and the Category
// table holds a label too. Two copies can drift, so this fails if they do:
//   STATIC  CATEGORY_SEED (taxonomy + validation) == the rows the migration
//           hard-codes == the enum the rollback file recreates, in order.
//   DB      READ-ONLY. The Category rows in the target schema == CATEGORY_SEED;
//           the enum is gone; Item and ItemWantedCategory reference only known
//           codes; the foreign keys and RESTRICT are in place.
import "dotenv/config"
import { Client } from "pg"
import { readFileSync } from "node:fs"
import { CATEGORY_SEED } from "../prisma/category-seed"
import { targetSchema } from "./lib/live-guard"

const MIGRATION = "20261008000000_category_lookup_table"
let failures = 0
function check(ok: boolean, label: string, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`)
  if (!ok) failures++
}
const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
const want = CATEGORY_SEED.map((c) => `${c.id}|${c.label}|${c.sortOrder}`)

function staticChecks() {
  console.log("\n  static")
  check(CATEGORY_SEED.length === 20, "20 categories in CATEGORY_VALUES", String(CATEGORY_SEED.length))
  check(CATEGORY_SEED.every((c) => typeof c.label === "string" && c.label.length > 0), "every code has a label in CATEGORY_LABELS")
  check(new Set(CATEGORY_SEED.map((c) => c.label)).size === CATEGORY_SEED.length, "labels are unique (Category_label_key)")

  const fwd = read(`prisma/migrations/${MIGRATION}/migration.sql`)
  const rows = [...fwd.matchAll(/\('([A-Z_]+)', '((?:[^']|'')*)', (\d+)\)/g)].map((m) => `${m[1]}|${m[2].replace(/''/g, "'")}|${m[3]}`)
  const diff = want.filter((w, i) => rows[i] !== w)
  check(rows.length === want.length && diff.length === 0, "migration seed rows == taxonomy (code, label, order)", diff.length ? `differs at ${diff.join(", ")}` : `${rows.length} rows`)

  const back = read(`prisma/rollback/${MIGRATION}.sql`)
  const enumList = (/CREATE TYPE "Category_restore" AS ENUM \(([\s\S]*?)\);/.exec(back)?.[1] ?? "").match(/'([A-Z_]+)'/g)?.map((s) => s.slice(1, -1)) ?? []
  check(JSON.stringify(enumList) === JSON.stringify(CATEGORY_SEED.map((c) => c.id)), "rollback enum == CATEGORY_VALUES, same order", enumList.join(","))
}

async function dbChecks() {
  const schema = targetSchema()
  console.log(`\n  database, schema "${schema}" (read-only)`)
  const u = new URL(process.env.DATABASE_URL!)
  u.searchParams.delete("schema")
  const pg = new Client({ connectionString: u.toString() })
  await pg.connect()
  try {
    await pg.query("SET SESSION default_transaction_read_only = on")
    await pg.query("BEGIN READ ONLY")
    if ((await pg.query("SHOW transaction_read_only")).rows[0].transaction_read_only !== "on") throw new Error("session is not read-only")
    const s = (t: string) => `"${schema}"."${t}"`
    const got = (await pg.query(`SELECT id, label, "sortOrder" FROM ${s("Category")} ORDER BY "sortOrder"`)).rows.map((r) => `${r.id}|${r.label}|${r.sortOrder}`)
    const off = want.filter((w, i) => got[i] !== w)
    check(got.length === want.length && off.length === 0, "Category rows == taxonomy (code, label, order)", off.length ? `differs at ${off.join(", ")}` : `${got.length} rows`)
    const enumLeft = (await pg.query(`SELECT count(*)::int n FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname IN ('Category', 'Category_old', 'Category_restore') AND t.typtype = 'e'`, [schema])).rows[0].n
    check(enumLeft === 0, "enum Category is gone from the schema")
    for (const t of ["Item", "ItemWantedCategory"]) {
      const orphan = (await pg.query(`SELECT count(*)::int n FROM ${s(t)} x WHERE NOT EXISTS (SELECT 1 FROM ${s("Category")} c WHERE c.id = x."categoryId")`)).rows[0].n
      check(orphan === 0, `${t}.categoryId all reference Category`, `${orphan} orphan(s)`)
      const fk = (await pg.query(`SELECT confdeltype, confupdtype FROM pg_constraint WHERE conname = $1 AND connamespace = (SELECT oid FROM pg_namespace WHERE nspname = $2)`, [`${t}_categoryId_fkey`, schema])).rows[0]
      check(fk?.confdeltype === "r" && fk?.confupdtype === "c", `${t}_categoryId_fkey is ON DELETE RESTRICT ON UPDATE CASCADE`, fk ? `${fk.confdeltype}/${fk.confupdtype}` : "missing")
    }
    const pk = (await pg.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'ItemWantedCategory_pkey' AND connamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)`, [schema])).rows[0]?.d
    check(pk === 'PRIMARY KEY ("itemId", "categoryId")', "ItemWantedCategory PK is (itemId, categoryId)", pk ?? "missing")
    await pg.query("ROLLBACK")
  } finally { await pg.end() }
}

;(async () => {
  staticChecks()
  if (!process.argv.includes("--static")) await dbChecks()
  console.log(failures ? `\n  ${failures} FAILED\n` : "\n  ALL PASSED\n")
  process.exitCode = failures ? 1 : 0
})().catch((e) => { console.error(`  FAILED: ${(e as Error).message}`); process.exit(1) })
