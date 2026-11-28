// Recalculate Baylo's value brackets from live listing values (28 Nov 2026).
//
//   npx tsx --tsconfig tsconfig.json --env-file=.env scripts/recalculate-brackets.ts            # dry run: prints, writes nothing
//   npx tsx --tsconfig tsconfig.json --env-file=.env scripts/recalculate-brackets.ts --propose  # records it as PROPOSED
//   npx tsx --tsconfig tsconfig.json --env-file=.env scripts/recalculate-brackets.ts --apply    # records it AND makes it ACTIVE
//   npx tsx ... scripts/recalculate-brackets.ts --activate <schemeId>                           # activate a recorded scheme (also: roll back)
//
// The same calculation the monthly cron runs (/api/cron/brackets), for doing
// it by hand. Writing on `public` (live) also needs --live, like every script
// that writes (scripts/lib/live-guard.ts). The dry run writes nothing.
//
// --apply re-brackets every listing in one transaction. Older app builds carry
// the hand-set table, so apply once the app build that reads
// GET /api/v1/brackets is out.

import { requireScratchSchema } from "./lib/live-guard"
import prisma from "../src/lib/prisma"
import { activateBracketScheme, recalculateBrackets } from "../src/lib/bracket-scheme"
import { DEFAULT_BRACKET_CEILINGS, bracketCeilings } from "../src/lib/brackets"
import { bracketCounts, gini } from "../src/lib/bracket-math"
import { listingValuesForBrackets } from "../src/lib/bracket-scheme"

const args = process.argv.slice(2)
const activateId = args.includes("--activate") ? args[args.indexOf("--activate") + 1] : null
const apply = args.includes("--apply")
const propose = args.includes("--propose") || apply
const writes = propose || !!activateId

const row = (label: string, c: readonly number[], values: number[]) => {
  const counts = bracketCounts(values, c)
  console.log(`  ${label.padEnd(10)} ${c.map((x) => String(x).padStart(6)).join("")}`)
  console.log(`  ${"listings".padEnd(10)} ${counts.map((x) => String(x).padStart(6)).join("")}   (Gini ${gini(counts)})`)
}

async function main() {
  if (writes) requireScratchSchema("scripts/recalculate-brackets.ts")

  const tables = await prisma.bracketScheme.findMany({ orderBy: { createdAt: "asc" } })
  console.log("\nBracket schemes on record:")
  for (const t of tables) console.log(`  ${t.status.padEnd(9)} ${t.id}  ${t.method.padEnd(9)} [${t.ceilings.join(", ")}]  n=${t.sampleSize}`)

  if (activateId) {
    const { itemsRebracketed } = await activateBracketScheme(activateId)
    console.log(`\nActivated ${activateId}; ${itemsRebracketed} listings re-bracketed.\n`)
    return
  }

  const result = await recalculateBrackets({ apply, dryRun: !propose })
  const { values, sample } = await listingValuesForBrackets()
  console.log(`\nSample: ${values.length} listing values (${sample}).`)
  if (result.outcome === "notEnoughData") {
    console.log(`Not enough data: ${result.sampleSize} values, need ${result.minSample}. The active table stays.\n`)
    return
  }
  const p = result.proposal
  console.log(`Anchors: ${p.stats.lowAnchor} (p${p.stats.lowQuantile * 100}) to ${p.stats.highAnchor} (p${p.stats.highQuantile * 100}); each bracket ≈ ${p.stats.stepRatio}× the one below.\n`)
  console.log(`  ${"bracket".padEnd(10)} ${Array.from({ length: 10 }, (_, i) => String(i + 1).padStart(6)).join("")}`)
  row("hand-set", DEFAULT_BRACKET_CEILINGS, values)
  if (result.outcome !== "unchanged") row("active", result.previous, values)
  row("proposed", p.ceilings, values)
  console.log(`\nOutcome: ${result.outcome}${"id" in result ? ` (${result.id})` : ""}${"itemsRebracketed" in result && result.itemsRebracketed !== undefined ? `, ${result.itemsRebracketed} listings re-bracketed` : ""}.`)
  console.log(`Active table now: [${bracketCeilings().join(", ")}]\n`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
