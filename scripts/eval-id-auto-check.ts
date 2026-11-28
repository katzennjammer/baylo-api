// Measures the automatic ID check on a folder of labelled ID photos (28 Nov 2026).
//
//   npx tsx --tsconfig tsconfig.json scripts/eval-id-auto-check.ts <folder>
//
// <folder>/cases.json lists each photo with what should happen:
//   { file, kind, expect, selectedType, typedNumber, accountName, accountDob }
// `expect` is APPROVED or a rejection reason. Reads files only; no database,
// no network. Prints the confusion table and the two numbers that matter:
//   - false approvals: a case that should be refused but was APPROVED
//   - automation rate: genuine IDs approved without anyone looking
// Use it on synthetic IDs, or on your own team's real IDs on your own PC: it
// prints outcomes only, never the text read from a card.

import { readFileSync } from "node:fs"
import path from "node:path"
import { autoCheckId, type IdTypeDb } from "../src/lib/id-auto-check"
import { measureSharpness, readIdText } from "../src/lib/id-ocr"
import { sanitizeImage } from "../src/lib/image-sanitize"

interface Case { file: string; kind: string; expect: string; selectedType: IdTypeDb; typedNumber: string; accountName: string; accountDob: string | null }

async function main() {
  const dir = process.argv[2]
  if (!dir) throw new Error("Usage: eval-id-auto-check.ts <folder with cases.json>")
  const cases: Case[] = JSON.parse(readFileSync(path.join(dir, "cases.json"), "utf8"))
  const limit = Number(process.env.LIMIT ?? cases.length)
  const rows: { kind: string; expect: string; got: string; conf: number; ms: number; detail?: unknown }[] = []
  for (const c of cases.slice(0, limit)) {
    // Through the same metadata-stripping re-encode the route applies first.
    const buf = (await sanitizeImage(readFileSync(path.join(dir, c.file)))).buffer
    const [sharpness, ocr] = await Promise.all([measureSharpness(buf), readIdText(buf)])
    const r = autoCheckId({
      text: ocr.text, ocrConfidence: ocr.confidence, sharpness,
      selectedType: c.selectedType, typedNumber: c.typedNumber, accountName: c.accountName,
      accountDob: c.accountDob ? new Date(c.accountDob + "T00:00:00Z") : null,
      today: new Date("2026-11-28T00:00:00Z"),
    })
    const got = r.decision === "APPROVED" ? "APPROVED" : (r.reason as string)
    rows.push({ kind: c.kind, expect: c.expect, got, conf: r.confidence, ms: ocr.ms, detail: process.env.VERBOSE && got !== c.expect ? { file: c.file, ...r.checks, ...r.detail } : undefined })
    if (process.env.VERBOSE && got !== c.expect) console.log(c.kind, "→", got, JSON.stringify(rows[rows.length - 1].detail))
  }

  const kinds = [...new Set(rows.map((r) => r.kind))]
  console.log(`\n${"kind".padEnd(16)} ${"n".padStart(4)} ${"correct".padStart(8)} ${"approved".padStart(9)}  outcomes`)
  for (const k of kinds) {
    const rs = rows.filter((r) => r.kind === k)
    const tally: Record<string, number> = {}
    for (const r of rs) tally[r.got] = (tally[r.got] ?? 0) + 1
    console.log(`${k.padEnd(16)} ${String(rs.length).padStart(4)} ${String(rs.filter((r) => r.got === r.expect).length).padStart(8)} ${String(rs.filter((r) => r.got === "APPROVED").length).padStart(9)}  ${JSON.stringify(tally)}`)
  }
  const genuine = rows.filter((r) => r.expect === "APPROVED")
  const bad = rows.filter((r) => r.expect !== "APPROVED")
  const falseApprove = bad.filter((r) => r.got === "APPROVED").length
  const correct = rows.filter((r) => r.got === r.expect).length
  console.log(`\nAutomation rate (genuine approved automatically): ${genuine.filter((r) => r.got === "APPROVED").length}/${genuine.length} = ${(100 * genuine.filter((r) => r.got === "APPROVED").length / Math.max(1, genuine.length)).toFixed(1)}%`)
  console.log(`False approvals (should be refused, approved):    ${falseApprove}/${bad.length} = ${(100 * falseApprove / Math.max(1, bad.length)).toFixed(1)}%`)
  console.log(`Exactly right (decision and reason):               ${correct}/${rows.length} = ${(100 * correct / rows.length).toFixed(1)}%`)
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b)
  console.log(`OCR time per photo: median ${ms[Math.floor(ms.length / 2)]} ms, slowest ${ms[ms.length - 1]} ms\n`)
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
