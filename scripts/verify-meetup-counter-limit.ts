// Acceptance harness for the meetup counter limit and the fair hub (29 Nov 2026).
//
// SCRATCH SCHEMA ONLY (it creates users, listings, hubs and a trade, and
// deletes them). Drives the REAL route over HTTP:
//
//   DATABASE_URL=...?schema=scratch_x npx tsx --tsconfig tsconfig.json scripts/verify-meetup-counter-limit.ts
//   (with a server on ACCEPT_BASE, default http://127.0.0.1:3124, same DATABASE_URL)
//
// What it pins down:
//   1  fairMeetupHub(): the hub whose distance to the FARTHER side is smallest,
//      preferring hubs both listings named
//   2  GET shows 3 counters left for each side, and the fair hub
//   3  a fresh pick and changing your own suggestion are NOT counters
//   4  three counters land; the fourth is refused (409 MEETUP_COUNTER_LIMIT)
//      and the refusal carries the fair hub
//   5  past the limit, the FAIR hub may still be proposed (the way out)
//   6  the partner's counters are counted separately

import prisma from "../src/lib/prisma"
import { signAccessToken } from "../src/lib/auth-tokens"
import { fairMeetupHub, MAX_MEETUP_COUNTERS } from "../src/lib/meetup"
import { requireScratchSchema } from "./lib/live-guard"

const BASE = process.env.ACCEPT_BASE ?? "http://127.0.0.1:3124"
const P = "zzmcl-"
let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail: unknown = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}   ${typeof detail === "string" ? detail : JSON.stringify(detail)}`) }
}

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: P } }, select: { id: true } })
  const ids = users.map((u) => u.id)
  await prisma.trade.deleteMany({ where: { OR: [{ senderId: { in: ids } }, { receiverId: { in: ids } }] } })
  await prisma.itemSafeZone.deleteMany({ where: { hubId: { startsWith: P } } })
  await prisma.item.deleteMany({ where: { userId: { in: ids } } })
  await prisma.safeZoneHub.deleteMany({ where: { id: { startsWith: P } } })
  await prisma.user.deleteMany({ where: { id: { in: ids } } })
}

const hub = (tag: string, lat: number, lng: number) =>
  prisma.safeZoneHub.create({
    data: { id: `${P}${tag}`, name: `${P}${tag}`, type: "MALL", address: "x", latitude: lat, longitude: lng, city: "Lapu-Lapu City", landmark: "x", isActive: true },
  })

async function call(token: string, method: "GET" | "POST", path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: (await res.json()) as { data: any; error: any; meta: any } } // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function main() {
  requireScratchSchema("scripts/verify-meetup-counter-limit.ts")
  await cleanup()

  // A's listing names hubs in the north, B's in the south; "mid" is between
  // them and named by both; "far" is named by both but far from B.
  const [north, south, mid, far] = await Promise.all([
    hub("north", 10.34, 123.96), hub("south", 10.26, 123.98), hub("mid", 10.30, 123.97), hub("far", 10.36, 123.95),
  ])
  const mkUser = (tag: string) => prisma.user.create({ data: { email: `${P}${tag}@test.invalid`, name: `ZZ ${tag}`, isVerified: true } })
  const [a, b] = await Promise.all([mkUser("a"), mkUser("b")])
  const mkItem = (userId: string, tag: string) =>
    prisma.item.create({ data: { title: `${P}${tag}`, description: "x", category: "OTHER", condition: "GOOD" as never, userId, valueLeaves: 200, status: "IN_TRADE" as never } })
  const [ia, ib] = await Promise.all([mkItem(a.id, "ia"), mkItem(b.id, "ib")])
  await prisma.itemSafeZone.createMany({
    data: [
      { itemId: ia.id, hubId: north.id }, { itemId: ia.id, hubId: mid.id }, { itemId: ia.id, hubId: far.id },
      { itemId: ib.id, hubId: south.id }, { itemId: ib.id, hubId: mid.id }, { itemId: ib.id, hubId: far.id },
    ],
  })
  const trade = await prisma.trade.create({
    data: { tradeCreatedAt: new Date(), status: "ACCEPTED", senderId: a.id, receiverId: b.id, offeredItemId: ia.id, requestedItemId: ib.id },
  })
  const [ta, tb] = await Promise.all([signAccessToken(a.id), signAccessToken(b.id)])
  const path = `/api/v1/trades/${trade.id}/meetup`
  const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()

  console.log("\n1. fairMeetupHub()")
  const hubsAll = await prisma.safeZoneHub.findMany({ where: { id: { startsWith: P } } })
  const f = fairMeetupHub(hubsAll as never, { yours: [north.id, mid.id, far.id], theirs: [south.id, mid.id, far.id], shared: [mid.id, far.id] })
  check("picks the shared hub in the middle", f?.hub.id === mid.id, f?.hub.id)

  console.log("\n2. GET")
  const g = await call(ta, "GET", path)
  check("3 counters left each side", g.json.data?.counters?.yoursLeft === 3 && g.json.data?.counters?.theirsLeft === 3, g.json.data?.counters)
  check("fair hub is served", g.json.data?.fairHub?.hub?.id === mid.id, g.json.data?.fairHub)

  console.log("\n3. Fresh pick and own change are not counters")
  let r = await call(ta, "POST", path, { hubId: north.id, at: at(24) })
  check("A's fresh pick lands", r.status === 200, r.json.error)
  r = await call(ta, "POST", path, { hubId: far.id, at: at(25) })
  check("A changes own suggestion", r.status === 200, r.json.error)
  const t0 = await prisma.trade.findUnique({ where: { id: trade.id }, select: { meetupCountersBySender: true, meetupCountersByReceiver: true } })
  check("no counter used", t0?.meetupCountersBySender === 0 && t0?.meetupCountersByReceiver === 0, t0)

  console.log("\n4. Counters up to the limit")
  let standing = { hubId: far.id, at: at(25), proposedBy: "sender" }
  standing.at = (await prisma.trade.findUnique({ where: { id: trade.id }, select: { meetupAt: true } }))!.meetupAt!.toISOString()
  for (let i = 1; i <= MAX_MEETUP_COUNTERS; i++) {
    // B counters, then A counters back (A's counters are counted too).
    const bAt = at(30 + i)
    r = await call(tb, "POST", path, { hubId: south.id, at: bAt, replaces: standing })
    check(`B counter ${i} lands`, r.status === 200, r.json.error)
    standing = { hubId: south.id, at: r.json.data?.plan?.at ?? bAt, proposedBy: "receiver" }
    if (i < MAX_MEETUP_COUNTERS) {
      const aAt = at(40 + i)
      r = await call(ta, "POST", path, { hubId: north.id, at: aAt, replaces: standing })
      check(`A counter ${i} lands`, r.status === 200, r.json.error)
      standing = { hubId: north.id, at: r.json.data?.plan?.at ?? aAt, proposedBy: "sender" }
    }
  }
  // Let A counter once more so B has something to counter.
  r = await call(ta, "POST", path, { hubId: north.id, at: at(50), replaces: standing })
  check("A's third counter lands", r.status === 200, r.json.error)
  standing = { hubId: north.id, at: r.json.data?.plan?.at, proposedBy: "sender" }

  r = await call(tb, "POST", path, { hubId: south.id, at: at(55), replaces: standing })
  check("B's 4th counter is refused", r.status === 409 && r.json.meta?.rule === "MEETUP_COUNTER_LIMIT", { status: r.status, meta: r.json.meta?.rule })
  check("the refusal names the fair hub", r.json.meta?.fairHub?.hub?.id === mid.id, r.json.meta?.fairHub)
  const g2 = await call(tb, "GET", path)
  check("GET: B has 0 left, A has 0 left", g2.json.data?.counters?.yoursLeft === 0 && g2.json.data?.counters?.theirsLeft === 0, g2.json.data?.counters)

  console.log("\n5. The fair hub is still allowed")
  r = await call(tb, "POST", path, { hubId: mid.id, at: at(56), replaces: standing })
  check("B proposes the fair hub past the limit", r.status === 200, r.json.error)

  await cleanup()
  console.log(`\n  ${pass} passed, ${fail} failed\n`)
  if (fail) process.exitCode = 1
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
