// Acceptance harness for system-calculated brackets (28 Nov 2026).
//
// SCRATCH SCHEMA ONLY: it activates schemes and re-brackets listings, so it
// refuses `public` outright (no --live escape). It restores whatever scheme
// was active when it started.
//
//   DATABASE_URL=...?schema=scratch_x npx tsx --tsconfig tsconfig.json scripts/verify-bracket-scheme.ts
//
// What it pins down:
//   1  the maths (no database): nice() rounding, numpy-style quantile, ten
//      geometric steps between p2 and p98, strictly increasing ceilings, the
//      1.5x minimum step on a narrow range, too few values → no proposal
//   2  the trigger: Item.bracket equals bracketOf(valueLeaves) on every row,
//      on insert, on a value change, and when something writes bracket by hand
//   3  activation: one ACTIVE row at a time (and the database refuses a
//      second), every listing re-bracketed, the in-memory table follows, and
//      rolling back restores the old brackets
//   4  recalculation: a dry run writes nothing; an unchanged table records
//      nothing

import prisma from "../src/lib/prisma"
import { databaseSchema } from "../src/lib/db-schema"
import { bracketCeilings, bracketOf, DEFAULT_BRACKET_CEILINGS } from "../src/lib/brackets"
import { MIN_SAMPLE, geometricCeilings, nice, proposeGeometricScheme, quantile } from "../src/lib/bracket-math"
import { activateBracketScheme, activeBracketScheme, ensureBracketScheme, recalculateBrackets } from "../src/lib/bracket-scheme"

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail: unknown = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}   ${typeof detail === "string" ? detail : JSON.stringify(detail)}`) }
}

async function allBracketsMatch(): Promise<{ ok: boolean; wrong: number; n: number }> {
  const rows = await prisma.item.findMany({ select: { valueLeaves: true, bracket: true } })
  const wrong = rows.filter((r) => (r.valueLeaves === null ? r.bracket !== null : r.bracket !== bracketOf(r.valueLeaves))).length
  return { ok: wrong === 0, wrong, n: rows.length }
}

async function main() {
  const schema = databaseSchema()
  if (!/^scratch_/.test(schema)) throw new Error(`Refusing to run on schema "${schema}": scratch_* only.`)

  console.log("\n1. The maths")
  check("nice(137) = 150, nice(2140) = 2500, nice(100) = 100, nice(9001) = 10000",
    nice(137) === 150 && nice(2140) === 2500 && nice(100) === 100 && nice(9001) === 10000)
  check("quantile matches numpy (linear)", quantile([1, 2, 3, 4], 0.5) === 2.5 && quantile([10, 20], 0.02) === 10.2)
  const wide = Array.from({ length: 300 }, (_, i) => Math.round(30 * 1.03 ** i))
  const g = geometricCeilings([...wide].sort((a, b) => a - b), 0.02, 0.98)
  check("nine strictly increasing ceilings", g.length === 9 && g.every((c, i) => i === 0 || c > g[i - 1]), g)
  const narrow = Array.from({ length: 200 }, (_, i) => 100 + (i % 20))
  const n = proposeGeometricScheme(narrow)
  check("narrow range: every step is at least ~1.5x (no ₱100/110/120 brackets)",
    !!n && n.ceilings.every((c, i) => i === 0 || c / n.ceilings[i - 1] >= 1.2) && n.stats.stepRatio >= 1.45, n?.ceilings)
  check(`fewer than ${MIN_SAMPLE} values: no proposal`, proposeGeometricScheme(wide.slice(0, MIN_SAMPLE - 1)) === null)

  const start = await activeBracketScheme()
  if (!start) throw new Error("No ACTIVE bracket scheme: is the migration applied?")
  console.log(`\n(starting scheme: ${start.id} [${start.ceilings.join(", ")}])`)

  console.log("\n2. The trigger")
  const before = await allBracketsMatch()
  check(`Item.bracket == bracketOf(valueLeaves) on all ${before.n} rows`, before.ok, `${before.wrong} wrong`)
  const owner = await prisma.user.upsert({ where: { email: "zzbrsch@test.invalid" }, update: {}, create: { email: "zzbrsch@test.invalid", name: "ZZBRSCH" } })
  const probe = await prisma.item.create({
    data: { id: "zzbrsch-probe", title: "probe", description: "probe", category: "OTHER", condition: "GOOD" as never, userId: owner.id, valueLeaves: 4001 },
    select: { id: true, bracket: true },
  })
  check("insert: 4001 Leaves gets bracketOf(4001)", probe.bracket === bracketOf(4001), probe)
  const moved = await prisma.item.update({ where: { id: probe.id }, data: { valueLeaves: 50 }, select: { bracket: true } })
  check("value change: 50 Leaves is bracket 1", moved.bracket === 1, moved)
  await prisma.$executeRaw`UPDATE "Item" SET "bracket" = 9 WHERE "id" = ${probe.id}`
  const forced = await prisma.item.findUnique({ where: { id: probe.id }, select: { bracket: true } })
  check("a hand-written bracket is overwritten by the trigger", forced?.bracket === 1, forced)
  const cleared = await prisma.item.update({ where: { id: probe.id }, data: { valueLeaves: null }, select: { bracket: true } })
  check("no value: bracket NULL", cleared.bracket === null, cleared)

  console.log("\n3. Activation")
  const test = await prisma.bracketScheme.create({
    data: { ceilings: [50, 120, 250, 400, 700, 1200, 2000, 5000, 8000], method: "geometric", status: "PROPOSED", sampleSize: 0, stats: { note: "verify-bracket-scheme test" } },
  })
  let secondActiveRefused = false
  try {
    await prisma.$executeRaw`UPDATE "BracketScheme" SET "status" = 'ACTIVE' WHERE "id" = ${test.id}`
  } catch {
    secondActiveRefused = true
  }
  check("the database refuses a second ACTIVE row", secondActiveRefused)
  const { itemsRebracketed } = await activateBracketScheme(test.id)
  const active = await prisma.bracketScheme.findMany({ where: { status: "ACTIVE" }, select: { id: true } })
  check("exactly one ACTIVE row, and it is the new one", active.length === 1 && active[0].id === test.id, active)
  check("the in-memory table follows", bracketCeilings().join() === test.ceilings.join(), bracketCeilings())
  const after = await allBracketsMatch()
  check(`every listing re-bracketed under the new table (${itemsRebracketed} rows)`, after.ok, `${after.wrong} wrong`)
  check("bracketOf(100) is now 2 (was 1)", bracketOf(100) === 2)

  await activateBracketScheme(start.id)
  await ensureBracketScheme()
  const back = await allBracketsMatch()
  check("roll back: the starting scheme is ACTIVE again and brackets match it",
    back.ok && bracketCeilings().join() === start.ceilings.join(), { back, now: bracketCeilings() })

  console.log("\n4. Recalculation")
  const count0 = await prisma.bracketScheme.count()
  const dry = await recalculateBrackets({ apply: false, dryRun: true })
  check("dry run writes no scheme row", (await prisma.bracketScheme.count()) === count0, dry.outcome)
  check("dry run leaves the active table alone", bracketCeilings().join() === start.ceilings.join())

  // Clean up the probe and the test scheme.
  await prisma.item.delete({ where: { id: probe.id } })
  await prisma.user.delete({ where: { id: owner.id } })
  await prisma.bracketScheme.delete({ where: { id: test.id } })

  console.log(`\n  ${pass} passed, ${fail} failed`)
  console.log(`  (default table for reference: [${DEFAULT_BRACKET_CEILINGS.join(", ")}])\n`)
  if (fail) process.exitCode = 1
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
