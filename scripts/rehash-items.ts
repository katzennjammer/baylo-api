/**
 * One-time backfill: recompute dHash for every item that has images stored,
 * replacing any old aHash values so all existing listings are protected by
 * the two-stage duplicate detection.
 *
 * Run from the project root:
 *   npx tsx --env-file=.env scripts/rehash-items.ts
 *
 * --env-file loads DATABASE_URL (and other vars) from .env without needing
 * the dotenv package. Safe to re-run — idempotent.
 */

// Import from the custom generator output path, NOT "@prisma/client"
// (schema.prisma output; resolved through the tsconfig "@/generated/prisma" alias)
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import sharp from "sharp"
import { requireScratchSchema } from "./lib/live-guard"

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Run with: npx tsx --env-file=.env scripts/rehash-items.ts")
  process.exit(1)
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 2 })
const prisma  = new PrismaClient({ adapter })

async function computeDHash(buffer: Buffer): Promise<string> {
  const { data } = await sharp(buffer)
    .resize(9, 8, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const pixels = Array.from(data as Uint8Array)
  const bits: string[] = []
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      bits.push(pixels[row * 9 + col] > pixels[row * 9 + col + 1] ? "1" : "0")
    }
  }
  return bits.join("")
}

async function main() {
  requireScratchSchema("scripts/rehash-items.ts")
  // Every listing with a cover photo (ItemImage position 0, schema v2).
  const items = await prisma.item.findMany({
    where:  { images: { some: { position: 0 } } },
    select: { id: true, images: { where: { position: 0 }, select: { url: true } } },
  })

  console.log(`Found ${items.length} items to rehash…\n`)

  let updated = 0
  let skipped = 0
  let failed  = 0

  for (const item of items) {
    const firstUrl = item.images[0]?.url ?? ""

    if (!firstUrl) { skipped++; continue }

    try {
      const res = await fetch(firstUrl, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buffer = Buffer.from(await res.arrayBuffer())
      const hash   = await computeDHash(buffer)
      // The cover photo's hash -- what the duplicate scan reads (was Item.imageHash).
      await prisma.itemImage.update({ where: { itemId_position: { itemId: item.id, position: 0 } }, data: { hash } })
      updated++
      process.stdout.write(`  ✓ ${updated}/${items.length}\r`)
    } catch (e) {
      console.error(`\n  ✗ item ${item.id}: ${e instanceof Error ? e.message : e}`)
      failed++
    }
  }

  console.log(`\n\nDone.`)
  console.log(`  ✓ ${updated} updated`)
  console.log(`  - ${skipped} skipped (no image URL)`)
  console.log(`  ✗ ${failed} failed`)

  await prisma.$disconnect()
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
