// The SERVER half of the (0, 0) hub rule, driven over HTTP against real routes.
//
//   .\scripts\scratch.ps1 -Push  -Name scratch_hubnull
//   .\scripts\scratch.ps1 -Dev   -Name scratch_hubnull -Port 3100
//   # ...in another window, with BASE pointed at that server:
//   $env:ACCEPT_BASE="http://127.0.0.1:3100"
//   npx tsx --env-file=.env scripts/verify-hub-null-island.ts
//   .\scripts\scratch.ps1 -Drop  -Name scratch_hubnull
//
// WHY THIS IS AN HTTP HARNESS AND NOT A UNIT TEST OF THE SCHEMA. The point of
// the server-side check is that the ROUTE refuses — an argument that was made
// explicitly when this was requested: "a client-side check alone isn't enough
// since the API can be called directly." A test that imports createSchema and
// parses an object proves the schema is right and proves nothing about whether
// anybody consults it. So each case below is a real request with a real admin
// Bearer token, and the assertion is on the status code and the row count in
// the database afterwards.
//
// WHAT IT PINS:
//   1  POST   with (0, 0)           -> 400 VALIDATION_ERROR, and NO row written
//   2  POST   with real coordinates -> 200, the row exists where it was put
//   3  PATCH  moving onto (0, 0)    -> 400, and the row is UNCHANGED
//   4  PATCH  a real move still works (the guard is not a blanket refusal)
//   5  PATCH  isActive alone still works — the ordinary deactivation path is
//      not caught by a rule about coordinates
//   6  POST   with (0, 0) writes NO audit row, so a refused request does not
//      leave a HUB_CREATED entry describing a hub that does not exist
//   7  near-misses (0, 0.0001) and (0.0001, 0) are ACCEPTED — the rule is exact
//      and must not be quietly widened into a "near the equator" rejection
//
// WRITES ROWS: scratch schema only, enforced by requireScratchSchema().

import prisma from "../src/lib/prisma"
import { signAccessToken } from "../src/lib/auth-tokens"
import { requireScratchSchema } from "./lib/live-guard"

const BASE = process.env.ACCEPT_BASE ?? "http://127.0.0.1:3100"
const P = "ZZHUBNULL_"

let pass = 0
let fail = 0

function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}   ${detail}`) }
}
function head(s: string) {
  console.log(`\n── ${s} ${"─".repeat(Math.max(0, 66 - s.length))}`)
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function cleanup() {
  const hubs = await prisma.safeZoneHub.findMany({
    where: { name: { startsWith: P } }, select: { id: true },
  })
  const hubIds = hubs.map((h) => h.id)
  if (hubIds.length) {
    // Both FKs onto SafeZoneHub are RESTRICT — association rows first.
    await prisma.itemSafeZone.deleteMany({ where: { hubId: { in: hubIds } } })
  }
  await prisma.adminAction.deleteMany({ where: { targetType: "HUB", targetId: { in: hubIds } } })
  await prisma.safeZoneHub.deleteMany({ where: { id: { in: hubIds } } })

  const users = await prisma.user.findMany({
    where: { email: { startsWith: P } }, select: { id: true },
  })
  const ids = users.map((u) => u.id)
  if (ids.length) {
    await prisma.adminAction.deleteMany({ where: { actorId: { in: ids } } })
    await prisma.user.deleteMany({ where: { id: { in: ids } } })
  }
}

async function mkAdmin() {
  const admin = await prisma.user.create({
    data: {
      name: `${P}admin`,
      email: `${P}admin-${Date.now()}@example.local`,
      password: "x",
      role: "ADMIN",
      isVerified: true,
    },
  })
  return { admin, token: await signAccessToken(admin.id) }
}

/** A create body that is valid in every respect except what a case changes. */
function createBody(over: Record<string, unknown> = {}) {
  const tag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  return {
    name: `${P}hub-${tag}`,
    type: "MALL",
    address: "North Reclamation Area",
    city: "Cebu City",
    landmark: "Main entrance",
    latitude: 10.3116,
    longitude: 123.9172,
    reason: "harness: created to test the (0, 0) guard",
    ...over,
  }
}

interface Result { status: number; body: any }

async function post(body: unknown, token: string): Promise<Result> {
  const res = await fetch(`${BASE}/api/admin/hubs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function patch(id: string, body: unknown, token: string): Promise<Result> {
  const res = await fetch(`${BASE}/api/admin/hubs/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const schema = requireScratchSchema("scripts/verify-hub-null-island.ts")
  console.log(`  base:   ${BASE}   (schema ${schema})\n`)

  await cleanup()
  const { admin, token } = await mkAdmin()

  // ── 1 ── POST refuses (0, 0)
  head("1  POST /api/admin/hubs refuses (0, 0)")
  const islandBody = createBody({ latitude: 0, longitude: 0 })
  const created = await post(islandBody, token)

  check("status is 400", created.status === 400, `got ${created.status}`)
  check(
    "error code is VALIDATION_ERROR",
    created.body?.error?.code === "VALIDATION_ERROR",
    JSON.stringify(created.body?.error),
  )
  check(
    "the message says what is wrong with (0, 0)",
    typeof created.body?.error?.message === "string" &&
      created.body.error.message.includes("(0, 0)"),
    JSON.stringify(created.body?.error?.message),
  )
  check(
    "meta.rule is NULL_ISLAND, for a client that branches on it",
    created.body?.meta?.rule === "NULL_ISLAND",
    JSON.stringify(created.body?.meta),
  )

  // The assertion that actually matters: nothing was stored. A 400 with a row
  // behind it is the failure mode this whole exercise is about.
  const storedIsland = await prisma.safeZoneHub.count({
    where: { name: islandBody.name },
  })
  check("NO row was written", storedIsland === 0, `found ${storedIsland}`)

  // ── 2 ── the guard is not a blanket refusal
  head("2  POST with real coordinates still works")
  const goodBody = createBody()
  const good = await post(goodBody, token)
  check("status is 200", good.status === 200, `got ${good.status}: ${JSON.stringify(good.body?.error)}`)
  const goodId: string | null = good.body?.data?.hub?.id ?? null
  check("a hub id came back", typeof goodId === "string" && goodId.length > 0)

  const goodRow = goodId
    ? await prisma.safeZoneHub.findUnique({ where: { id: goodId } })
    : null
  check(
    "the stored row has the coordinates that were sent",
    goodRow?.latitude === goodBody.latitude && goodRow?.longitude === goodBody.longitude,
    JSON.stringify({ lat: goodRow?.latitude, lng: goodRow?.longitude }),
  )

  // ── 3 ── PATCH refuses to move a hub onto (0, 0)
  head("3  PATCH /api/admin/hubs/[id] refuses to move a hub onto (0, 0)")
  if (!goodId) {
    check("skipped — no hub to patch", false, "setup failed at step 2")
  } else {
    const moved = await patch(
      goodId,
      { latitude: 0, longitude: 0, reason: "harness: try to move it to Null Island" },
      token,
    )
    check("status is 400", moved.status === 400, `got ${moved.status}`)
    check(
      "error code is VALIDATION_ERROR",
      moved.body?.error?.code === "VALIDATION_ERROR",
      JSON.stringify(moved.body?.error),
    )

    // The row must be untouched — a 400 that still moved it is worse than no
    // guard, because the audit log would say the edit was refused.
    const after = await prisma.safeZoneHub.findUnique({ where: { id: goodId } })
    check(
      "the row still has its ORIGINAL coordinates",
      after?.latitude === goodBody.latitude && after?.longitude === goodBody.longitude,
      JSON.stringify({ lat: after?.latitude, lng: after?.longitude }),
    )
  }

  // ── 4 ── a real move still works
  head("4  PATCH with real coordinates still works")
  if (!goodId) {
    check("skipped — no hub to patch", false, "setup failed at step 2")
  } else {
    const realMove = await patch(
      goodId,
      { latitude: 10.3201, longitude: 123.9001, reason: "harness: a genuine correction" },
      token,
    )
    check("status is 200", realMove.status === 200, `got ${realMove.status}`)
    const after = await prisma.safeZoneHub.findUnique({ where: { id: goodId } })
    check("the move landed", after?.latitude === 10.3201 && after?.longitude === 123.9001,
      JSON.stringify({ lat: after?.latitude, lng: after?.longitude }))
  }

  // ── 5 ── the ordinary deactivation path is unaffected
  head("5  a plain isActive toggle is not caught by the coordinate rule")
  if (!goodId) {
    check("skipped — no hub to patch", false, "setup failed at step 2")
  } else {
    const off = await patch(goodId, { isActive: false, reason: "harness: deactivate" }, token)
    check("deactivating returns 200", off.status === 200, `got ${off.status}`)
    const row = await prisma.safeZoneHub.findUnique({ where: { id: goodId } })
    check("the hub is inactive", row?.isActive === false)
    check("…and its coordinates were not touched",
      row?.latitude === 10.3201 && row?.longitude === 123.9001,
      JSON.stringify({ lat: row?.latitude, lng: row?.longitude }))

    const on = await patch(goodId, { isActive: true, reason: "harness: reactivate" }, token)
    check("reactivating returns 200", on.status === 200, `got ${on.status}`)
  }

  // ── 6 ── a refused request leaves no audit row
  head("6  a refused (0, 0) create writes NO audit entry")
  // An audit row for a hub that was never created would put a HUB_CREATED
  // entry in the moderation log pointing at an id that does not exist — the
  // log would describe an act that did not happen.
  //
  // `detail` is a plain Text column holding serialised JSON, not a Json type
  // (see the model note in prisma/schema.prisma), so this filters on a
  // substring of the serialised text rather than a JSON path. The name is
  // generated per invocation, so a match can only come from THIS run.
  const islandActions = await prisma.adminAction.count({
    where: {
      actorId: admin.id,
      action: "HUB_CREATED",
      detail: { contains: islandBody.name },
    },
  })
  check("no HUB_CREATED audit row for the refused request", islandActions === 0, `found ${islandActions}`)

  // ── 7 ── the rule is exact
  head("7  near-misses are ACCEPTED — the rule is (0, 0), not \"near the equator\"")
  // The Gulf of Guinea really is at latitude 0. Somebody may legitimately add a
  // hub in Ghana or Ecuador, and a country-shaped bounding box is a product
  // decision the schema deliberately does not make (see the note in route.ts).
  // Widening this rule to catch "latitude 0" would break that.
  const offByOne = [
    { label: "(0, 0.0001) is a real place", latitude: 0, longitude: 0.0001 },
    { label: "(0.0001, 0) is a real place", latitude: 0.0001, longitude: 0 },
  ]
  for (const c of offByOne) {
    const body = createBody({ latitude: c.latitude, longitude: c.longitude })
    const r = await post(body, token)
    check(`${c.label} — accepted`, r.status === 200, `got ${r.status}: ${JSON.stringify(r.body?.error)}`)
    const row = await prisma.safeZoneHub.findFirst({ where: { name: body.name } })
    check(`…and stored at ${c.latitude}, ${c.longitude}`,
      row?.latitude === c.latitude && row?.longitude === c.longitude,
      JSON.stringify({ lat: row?.latitude, lng: row?.longitude }))
  }

  console.log(`\n${"═".repeat(72)}`)
  console.log(`  ${pass} passed, ${fail} failed`)
  console.log(`${"═".repeat(72)}\n`)

  await cleanup()
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error(e)
  await cleanup().catch(() => {})
  await prisma.$disconnect()
  process.exit(1)
})