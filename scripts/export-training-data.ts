// Export Baylo's own listings as training data for the in-house models (28 Nov 2026).
//
//   npx tsx --tsconfig tsconfig.json --env-file=.env scripts/export-training-data.ts
//
// READ-ONLY. It runs SELECTs and writes one file, ml-data/items.csv, next to
// the repo root. No rows are written, so it does not need --live.
//
// One row per listing photo (a listing with three photos gives three rows,
// all with the same label), which is what the photo classifier trains on.
// The value model de-duplicates by item_id.
//
// Which listings:
//   - status AVAILABLE, IN_TRADE, TRADED or OWNED (real, accepted values).
//     PENDING_REVIEW and REMOVED are left out: their value or content was not
//     accepted.
//   - not hidden by a moderator.
//   - perishables are kept but flagged; their values are clamped by a
//     different rule, so the value model can drop them.
//   - demo/seed listings are kept and flagged (`is_demo`), so the notebook
//     can train with or without them and report both.
//
// Nothing personal leaves the database: no user ids, names, emails or
// locations. Only what a listing shows publicly: title, description, category,
// condition, value and its public photo URL.

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import prisma from "../src/lib/prisma"

const OUT = resolve(__dirname, "../ml-data/items.csv")
const DEMO_PREFIXES = ["demo-", "def-", "defb-", "seed-"]

const csv = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function main() {
  const items = await prisma.item.findMany({
    where: {
      status: { in: ["AVAILABLE", "IN_TRADE", "TRADED", "OWNED"] as never },
      moderationHiddenAt: null,
    },
    select: {
      id: true,
      title: true,
      description: true,
      category: true,
      condition: true,
      valueLeaves: true,
      valuationSource: true,
      status: true,
      isPerishable: true,
      createdAt: true,
      images: { select: { url: true, position: true }, orderBy: { position: "asc" } },
    },
    orderBy: { createdAt: "asc" },
  })

  const header = ["item_id", "photo_index", "image_url", "title", "description", "category", "condition", "value", "valuation_source", "status", "is_perishable", "is_demo", "created_at"]
  const lines = [header.join(",")]
  const perCategory = new Map<string, { items: number; photos: number }>()
  let photos = 0
  for (const it of items) {
    const isDemo = DEMO_PREFIXES.some((p) => it.id.startsWith(p))
    const c = perCategory.get(it.category) ?? { items: 0, photos: 0 }
    c.items++
    for (const img of it.images) {
      if (!/^https:\/\//.test(img.url)) continue // only public, fetchable photos
      lines.push([it.id, img.position, img.url, it.title, it.description, it.category, it.condition, it.valueLeaves, it.valuationSource, it.status, it.isPerishable ? 1 : 0, isDemo ? 1 : 0, it.createdAt.toISOString()].map(csv).join(","))
      c.photos++
      photos++
    }
    perCategory.set(it.category, c)
  }

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, lines.join("\n") + "\n")

  console.log(`\n${items.length} listings, ${photos} photos -> ${OUT}\n`)
  console.log(`${"CATEGORY".padEnd(16)} LISTINGS  PHOTOS`)
  for (const [cat, c] of [...perCategory.entries()].sort((a, b) => b[1].photos - a[1].photos)) {
    console.log(`${cat.padEnd(16)} ${String(c.items).padStart(8)}  ${String(c.photos).padStart(6)}${c.photos < 15 ? "   <- thin" : ""}`)
  }
  console.log("\nUpload items.csv to the Colab notebook (ml/baylo_models.ipynb).\n")
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
