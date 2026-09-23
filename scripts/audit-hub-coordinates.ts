// READ-ONLY audit of SafeZoneHub coordinates. Writes nothing, changes nothing.
//
//   npx tsx --tsconfig tsconfig.json scripts/audit-hub-coordinates.ts
//
// Reports three populations, because (0, 0) and the other two are different
// problems with different fixes:
//
//   1  latitude = 0 AND longitude = 0     — Null Island. The sentinel a form
//                                           submits when nobody chose a place.
//                                           Now rejected by both hub routes.
//   2  latitude = 0 XOR longitude = 0     — half a coordinate. Not something
//                                           the current UI can produce (it sets
//                                           both fields together) but a row like
//                                           this pinpoints on a line, not a
//                                           point, and is worth knowing about.
//   3  NULL / NaN on either column        — nothing renders a pin at all, and
//                                           any consumer doing arithmetic on it
//                                           gets NaN through the whole calculation.
//
// It does NOT fix anything. A row on Null Island cannot be corrected without
// deciding where that hub really is, and that is a guess about the physical
// world — the one kind of guess a script must not make on somebody else's
// behalf. See the note printed at the end.
//
// This is a read, so it deliberately does NOT call requireScratchSchema():
// reading live is the normal, correct thing for such a script to do (see the
// note at the bottom of scripts/lib/live-guard.ts).

import prisma from "../src/lib/prisma"
import { databaseSchema } from "../src/lib/prisma"
import { SAFE_ZONE_TYPE_LABELS, type SafeZoneTypeValue } from "../src/lib/safe-zones"

type HubRow = {
  id: string
  name: string
  type: string
  city: string
  address: string
  landmark: string
  latitude: number | null
  longitude: number | null
  isActive: boolean
  _count: { items: number }
}

function line(label: string, value: string) {
  console.log(`  ${label.padEnd(22)}${value}`)
}

function table(rows: HubRow[]) {
  if (rows.length === 0) return
  console.log("")
  for (const r of rows) {
    console.log(`    ${r.id}`)
    console.log(`      name       ${r.name}  (${SAFE_ZONE_TYPE_LABELS[r.type as SafeZoneTypeValue] ?? r.type})`)
    console.log(`      city       ${r.city}`)
    console.log(`      address    ${r.address}`)
    console.log(`      landmark   ${r.landmark}`)
    console.log(`      lat / lng  ${r.latitude} / ${r.longitude}`)
    console.log(`      isActive   ${r.isActive}    listings: ${r._count.items}`)
    console.log("")
  }
}

async function main() {
  console.log(`\n  schema: ${databaseSchema()}\n`)

  const select = {
    id: true, name: true, type: true, city: true, address: true, landmark: true,
    latitude: true, longitude: true, isActive: true,
    _count: { select: { items: true } },
  } as const

  const all = await prisma.safeZoneHub.findMany({ select, orderBy: { name: "asc" } })

  // Prisma types these as non-null, but the audit is about the case where the
  // assumption does not hold, so read them through a widened shape rather than
  // trusting the generated type.
  const rows = all as unknown as HubRow[]

  const nullIsland = rows.filter(
    (r) => r.latitude === 0 && r.longitude === 0,
  )
  const missing = rows.filter(
    (r) =>
      r.latitude === null || r.longitude === null ||
      Number.isNaN(r.latitude as number) || Number.isNaN(r.longitude as number) ||
      !Number.isFinite(r.latitude as number) || !Number.isFinite(r.longitude as number),
  )
  // Half a pair. Excludes the rows already reported above so the three lists
  // never overlap and the counts add up.
  const halfPair = rows.filter(
    (r) =>
      !missing.includes(r) && !nullIsland.includes(r) &&
      ((r.latitude === 0) !== (r.longitude === 0)),
  )

  console.log("  ── SafeZoneHub coordinate audit ──────────────────────")
  line("total hubs", String(rows.length))
  line("active / inactive", `${rows.filter((r) => r.isActive).length} / ${rows.filter((r) => !r.isActive).length}`)
  console.log("")

  console.log(`  ── 1. (0, 0) — Null Island ───────────────────────────`)
  line("rows", String(nullIsland.length))
  line("listings affected", String(nullIsland.reduce((n, r) => n + r._count.items, 0)))
  table(nullIsland)

  console.log(`  ── 2. half a coordinate pair ─────────────────────────`)
  line("rows", String(halfPair.length))
  table(halfPair)

  console.log(`  ── 3. null / NaN coordinates ─────────────────────────`)
  line("rows", String(missing.length))
  table(missing)

  const bad = nullIsland.length + halfPair.length + missing.length
  console.log("  ─────────────────────")
  if (bad === 0) {
    console.log("  No existing row needs attention.\n")
  } else {
    console.log(`  ${bad} row(s) need attention. NOTHING HAS BEEN CHANGED.`)
    console.log("")
    console.log("  Fixing any of these means deciding where the hub really is, which")
    console.log("  is a fact about the physical world that only a person has. Edit each")
    console.log("  one through /admin/hubs (the pin picker writes the coordinates and the")
    console.log("  audit log records who moved it, and from what), or supply explicit")
    console.log("  coordinates before asking for a backfill.\n")
  }

  await prisma.$disconnect()
  process.exit(0)
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
