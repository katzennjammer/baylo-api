// Computes the DINOv2 embedding of every listing photo that has none yet, and
// each listing's "% similar to another listing" note (29 Nov 2026).
//
//   npm run models                                     (once: downloads the model)
//   npx tsx --tsconfig tsconfig.json --env-file=.env scripts/backfill-photo-embeddings.ts          # count only
//   npx tsx --tsconfig tsconfig.json --env-file=.env scripts/backfill-photo-embeddings.ts --run --live
//
// Photos posted from 29 Nov 2026 are embedded automatically after posting;
// this fills in the older ones. Safe to re-run: photos that already have an
// embedding are skipped. Writes only ItemImage.embedding and
// Item.similarPhotoPct. Writing on `public` (live) needs --live.

import { requireScratchSchema } from "./lib/live-guard"
import prisma from "../src/lib/prisma"
import { embedItemPhotos } from "../src/lib/photo-similarity"

async function main() {
  const run = process.argv.includes("--run")
  const items = await prisma.item.findMany({
    where: { images: { some: { embedding: { isEmpty: true } } } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  })
  console.log(`\n${items.length} listings have photos without an embedding.`)
  if (!run) {
    console.log("Dry run. Add --run (and --live on the live database) to compute them.\n")
    return
  }
  requireScratchSchema("scripts/backfill-photo-embeddings.ts")
  let done = 0
  for (const it of items) {
    await embedItemPhotos(it.id)
    if (++done % 20 === 0) console.log(`  ${done}/${items.length}`)
  }
  const left = await prisma.itemImage.count({ where: { embedding: { isEmpty: true } } })
  const noted = await prisma.item.count({ where: { similarPhotoPct: { not: null } } })
  console.log(`\nDone. Photos still without an embedding (unreadable): ${left}. Listings with a "% similar" note: ${noted}.\n`)
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
