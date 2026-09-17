// Demo listings for the bracket, premium-lock and BRIDGING FEE surfaces.
//
//   npx tsx --env-file=.env scripts/seed-demo-brackets.ts            # apply (upsert)
//   npx tsx --env-file=.env scripts/seed-demo-brackets.ts --remove   # delete them again
//
// WHY THIS EXISTS. The reach/bracket features are presentation over
// `valueLeaves`, and as of 16 Sep 2026 the most valuable AVAILABLE listing on
// the whole market was 425 Leaves (bracket 3). A viewer whose best shelf item
// is in bracket 3 reaches bracket 4 (≤900), so nothing on the market could be
// out of reach, nothing was in a premium bracket (≥7, >2500 Leaves), and every
// pair of items was in the same bracket — so no bridge was ever priced. All
// three features looked broken; the data simply could not exercise them.
//
// Three listings, each on a SEED account (*@baylo.test), never on a real one:
//
//   demo-brk-reach    1200 Leaves  bracket 5   grey tile + "1 bracket above your reach"
//                                              for a viewer reaching bracket 4
//   demo-brk-premium  3200 Leaves  bracket 7   the premium lock (PREMIUM_MIN_BRACKET)
//   demo-brk-bridge    480 Leaves  bracket 3   BOTH directions of a bridge, from
//                                              one listing. Offer a bracket-2 item
//                                              (101-250) for it and YOU pay 20;
//                                              offer a bracket-4 one (501-900) and
//                                              the OWNER pays 30 to accept. Seed
//                                              shelves hold items in both, so the
//                                              picker shows a chargeable row and a
//                                              free one side by side.
//
// Every id starts with `demo-brk-` so --remove can find them by prefix and so a
// row is recognisable in any table it turns up in. Values are `category_band`
// for the same reason prisma/seed.ts gives: the type says the column holds one
// of two literals, and inventing a third is a lie about the schema.

import prisma from "../src/lib/prisma"
import { requireScratchSchema } from "./lib/live-guard"

const PREFIX = "demo-brk-"

const LISTINGS = [
  {
    id: `${PREFIX}reach`,
    title: "Fender Player Stratocaster, sunburst",
    description:
      "Mexican-made Player series, alder body, maple neck. New strings, setup done last month. Gig bag included. Demo listing for the reach bracket.",
    image: "https://images.unsplash.com/photo-1564186763535-ebb21ef5277f?w=800&q=75",
    category: "MUSIC",
    condition: "GOOD",
    valueLeaves: 1200,
    ownerId: "seed-u-jun",
    wantedItems: "A decent acoustic, or a bass",
  },
  {
    id: `${PREFIX}premium`,
    title: "MacBook Pro 14, M3 Pro, 18GB",
    description:
      "2023 model, 512GB, Space Black. Battery at 96%, no dents, box and charger included. Demo listing for the premium bracket.",
    image: "https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=800&q=75",
    category: "ELECTRONICS",
    condition: "NEW",
    valueLeaves: 3200,
    ownerId: "seed-u-carlo",
    wantedItems: "A camera body, or a gaming desktop",
  },
  {
    id: `${PREFIX}bridge`,
    title: "Nintendo Switch OLED bundle",
    description:
      "White OLED model with two extra Joy-Con, Pro Controller, and five games (Zelda TOTK, Mario Kart 8, Splatoon 3, Animal Crossing, Metroid Dread). Demo listing for the bridging fee, in both directions.",
    image: "https://images.unsplash.com/photo-1578303512597-81e6cc155b3e?w=800&q=75",
    category: "GAMING",
    condition: "GOOD",
    valueLeaves: 480,
    ownerId: "seed-u-maria",
    wantedItems: "A bag, a backpack, or anything within one bracket",
  },
] as const

async function apply() {
  const owners = await prisma.user.findMany({
    where: { id: { in: LISTINGS.map((l) => l.ownerId) } },
    select: { id: true, email: true },
  })
  for (const l of LISTINGS) {
    const owner = owners.find((o) => o.id === l.ownerId)
    if (!owner) throw new Error(`${l.ownerId} is not in this database — run prisma/seed.ts first`)
    if (!owner.email.endsWith("@baylo.test")) {
      throw new Error(`${l.ownerId} is ${owner.email}, not a seed account; refusing`)
    }
  }

  for (const l of LISTINGS) {
    const shared = {
      title: l.title,
      description: l.description,
      images: JSON.stringify([l.image]),
      category: l.category as never,
      condition: l.condition as never,
      valueLeaves: l.valueLeaves,
      suggestedLeaves: l.valueLeaves,
      valuationSource: "category_band",
      status: "AVAILABLE" as never,
      wantedItems: l.wantedItems,
      userId: l.ownerId,
      moderationHiddenAt: null,
    }
    await prisma.item.upsert({
      where: { id: l.id },
      create: { id: l.id, ...shared },
      update: shared,
    })
    console.log(`  upsert ${l.id.padEnd(18)} ${String(l.valueLeaves).padStart(5)} Leaves  ${l.ownerId}`)
  }
}

async function remove() {
  const rows = await prisma.item.findMany({
    where: { id: { startsWith: PREFIX } },
    select: { id: true, _count: { select: { offers: true, offeredIn: true, requestedIn: true } } },
  })
  if (rows.length === 0) {
    console.log("  nothing to remove")
    return
  }
  // An offer or trade against a demo listing is real state that someone made
  // while demoing. Deleting the row from under it would cascade or orphan, so
  // the listing is REMOVED (hidden, the same path a user's own delete takes)
  // rather than deleted. A listing nobody touched is deleted outright.
  for (const r of rows) {
    const touched = r._count.offers + r._count.offeredIn + r._count.requestedIn
    if (touched > 0) {
      await prisma.item.update({ where: { id: r.id }, data: { status: "REMOVED" as never } })
      console.log(`  ${r.id.padEnd(18)} marked REMOVED (${touched} offer/trade rows reference it)`)
    } else {
      await prisma.item.delete({ where: { id: r.id } })
      console.log(`  ${r.id.padEnd(18)} deleted`)
    }
  }
}

async function main() {
  requireScratchSchema("scripts/seed-demo-brackets.ts")
  const removing = process.argv.includes("--remove")
  console.log(removing ? "\nRemoving demo bracket listings" : "\nSeeding demo bracket listings")
  if (removing) await remove()
  else await apply()

  const left = await prisma.item.count({ where: { id: { startsWith: PREFIX }, status: "AVAILABLE" } })
  console.log(`\n  ${left} demo listing(s) AVAILABLE\n`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
