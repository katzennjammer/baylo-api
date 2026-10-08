// Acceptance harness: ONE standing hub suggestion, never two independent picks.
//
// RUNS AGAINST A SCRATCH SCHEMA and a server bound to it (see the PR / report
// for the exact commands). The server for this run is started with Pusher
// deliberately broken (a wrong PUSHER_SECRET), so every 200 below is also the
// claim "a Pusher failure does not fail the suggestion".
//
//   $env:ACCEPT_BASE="http://127.0.0.1:3100"
//   $env:DATABASE_URL="${base}?schema=scratch_hub"
//   npx tsx --env-file=.env scripts/verify-hub-suggestion.ts
//
// ══ THE BUG THIS PINS ═══════════════════════════════════════════════════════
//
// Two-device test, 7 Oct 2026: A suggested a hub; B's screen still read
// "Choose a hub"; B picked; the server overwrote A's suggestion with B's and
// nobody was told. A fresh pick and a counter were the same request. Now:
//
//   1  a fresh pick on an empty table lands
//   2  a fresh pick while the OTHER side's suggestion stands is a 409
//      (MEETUP_PENDING_FROM_PARTNER) carrying that suggestion, and writes nothing
//   3  changing your OWN unanswered suggestion needs no `replaces`
//   4  a counter naming a plan that is no longer standing is a 409 carrying the
//      plan that is (here the partner's, so MEETUP_PENDING_FROM_PARTNER)
//   5  a counter naming the standing plan lands, and clears nothing it should keep
//   6  agreeing a plan that changed is a 409; agreeing the standing one lands
//   7  an AGREED plan: a fresh pick from either side is a 409
//      (MEETUP_ALREADY_AGREED); a counter naming it reopens it
//   8  RACE: two fresh picks at once on an empty table, repeated — exactly one
//      wins every time, the loser's 409 carries the winner's plan
//   9  RACE: two counters to the same plan at once — exactly one wins
//  10  RACE: an agree and a counter at once — the row is never "agreed" on a
//      plan the agreeing side did not see
//  11  a 409 creates no notification; every 200 creates exactly one
//  12  a trade past ACCEPTED is refused; a malformed `replaces` is a 400

import prisma from "../src/lib/prisma"
import { requireScratchSchema } from "./lib/live-guard"
import { signAccessToken } from "../src/lib/auth-tokens"
import { NO_MEETUP_PLAN } from "../src/lib/meetup"

const BASE = process.env.ACCEPT_BASE ?? "http://127.0.0.1:3100"
const P = "ZZHUBSUG_"
const RACE_ROUNDS = 6
let pass = 0
let fail = 0

function check(name: string, cond: boolean, detail: unknown = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}   ${typeof detail === "string" ? detail : JSON.stringify(detail)}`) }
}
function head(s: string) {
  console.log(`\n── ${s} ${"─".repeat(Math.max(0, 66 - s.length))}`)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON from the wire
type Json = Record<string, any>
type Side = "sender" | "receiver"

async function post(path: string, token: string, body: Json): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json }
}

async function mkUser(tag: string) {
  const u = await prisma.user.create({
    data: { name: `${P}${tag}`, email: `${P}${tag}@example.com`, isVerified: true, leaves: 0 },
  })
  return { ...u, token: await signAccessToken(u.id) }
}
async function mkItem(userId: string, tag: string) {
  return prisma.item.create({
    data: {
      title: `${P}${tag}`, description: "fixture", category: "OTHER", condition: "GOOD",
      valueLeaves: 100, suggestedLeaves: 100, status: "AVAILABLE", userId,
    },
    select: { id: true },
  })
}
async function mkHub(tag: string) {
  return prisma.safeZoneHub.create({
    data: {
      id: `${P}${tag}`, name: `${P}${tag}`, type: "MALL", address: "somewhere",
      latitude: 10.3, longitude: 123.9, city: "Testville", landmark: "by the door", isActive: true,
    },
  })
}

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: P } }, select: { id: true } })
  const ids = users.map((u) => u.id)
  if (ids.length) {
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } })
    await prisma.trade.deleteMany({ where: { OR: [{ senderId: { in: ids } }, { receiverId: { in: ids } }] } })
    await prisma.itemSafeZone.deleteMany({ where: { item: { userId: { in: ids } } } })
    await prisma.item.deleteMany({ where: { userId: { in: ids } } })
    await prisma.user.deleteMany({ where: { id: { in: ids } } })
  }
  await prisma.safeZoneHub.deleteMany({ where: { id: { startsWith: P } } })
}

/** An instant `days` ahead, whole seconds, so it round-trips exactly. */
function inDays(days: number, plusMinutes = 0) {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000 + plusMinutes * 60 * 1000)
  d.setMilliseconds(0)
  return d.toISOString()
}

async function row(tradeId: string) {
  return prisma.trade.findUniqueOrThrow({
    where: { id: tradeId },
    select: { meetupHubId: true, meetupAt: true, meetupProposedBySender: true, meetupAgreedAt: true, status: true },
  })
}
const proposals = (tradeId: string) =>
  prisma.notification.count({ where: { entityId: tradeId, type: "MEETUP_PROPOSED" } })

async function main() {
  requireScratchSchema("scripts/verify-hub-suggestion.ts")
  await cleanup()

  const sender = await mkUser("sender")
  const receiver = await mkUser("receiver")
  const offered = await mkItem(sender.id, "offered")
  const requested = await mkItem(receiver.id, "requested")
  const hubA = await mkHub("hubA")
  const hubB = await mkHub("hubB")
  const hubC = await mkHub("hubC")
  const trade = await prisma.trade.create({
    data: {
      tradeCreatedAt: new Date(),
      status: "ACCEPTED",
      senderId: sender.id, receiverId: receiver.id,
      offeredItemId: offered.id, requestedItemId: requested.id,
    },
    select: { id: true },
  })
  const url = `/api/v1/trades/${trade.id}/meetup`
  const tok: Record<Side, string> = { sender: sender.token, receiver: receiver.token }
  let expectedProposals = 0

  // ── 1 ──
  head("1  fresh pick on an empty table")
  const at1 = inDays(2)
  const r1 = await post(url, tok.receiver, { hubId: hubA.id, at: at1 })
  check("receiver's fresh pick: 200", r1.status === 200, r1)
  if (r1.status === 200) expectedProposals++
  check("plan is hubA, by receiver", r1.json.data?.plan?.hub?.id === hubA.id && r1.json.data?.plan?.proposedBy === "receiver", r1.json)

  // ── 2 ──
  head("2  the OTHER side's fresh pick while that one stands")
  const r2 = await post(url, tok.sender, { hubId: hubB.id, at: inDays(3) })
  check("sender's fresh pick: 409", r2.status === 409, r2)
  check("meta.rule = MEETUP_PENDING_FROM_PARTNER", r2.json.meta?.rule === "MEETUP_PENDING_FROM_PARTNER", r2.json)
  check("meta.plan is the receiver's suggestion", r2.json.meta?.plan?.hub?.id === hubA.id && r2.json.meta?.plan?.at === at1, r2.json.meta)
  const d2 = await row(trade.id)
  check("row unchanged: still hubA by receiver", d2.meetupHubId === hubA.id && d2.meetupProposedBySender === false, d2)

  // ── 3 ──
  head("3  changing your OWN unanswered suggestion")
  const at3 = inDays(2, 30)
  const r3 = await post(url, tok.receiver, { hubId: hubC.id, at: at3 })
  check("receiver re-picks without replaces: 200", r3.status === 200, r3)
  if (r3.status === 200) expectedProposals++

  // ── 4 ──
  head("4  a counter naming a plan that is gone")
  const r4 = await post(url, tok.sender, {
    hubId: hubB.id, at: inDays(3),
    replaces: { hubId: hubA.id, at: at1, proposedBy: "receiver" },
  })
  check("stale counter: 409", r4.status === 409, r4)
  // What stands is the receiver's own unanswered pick, so the server names the
  // more useful reason: there is a suggestion to answer, not just "changed".
  check("meta.rule = MEETUP_PENDING_FROM_PARTNER", r4.json.meta?.rule === "MEETUP_PENDING_FROM_PARTNER", r4.json)
  check("meta.plan is the standing one (hubC)", r4.json.meta?.plan?.hub?.id === hubC.id, r4.json.meta)
  const r4b = await post(url, tok.sender, {
    hubId: hubB.id, at: inDays(3),
    replaces: { hubId: hubC.id, at: at3, proposedBy: "sender" },
  })
  check("right hub + time but WRONG side: 409", r4b.status === 409, r4b)

  // ── 5 ──
  head("5  a counter naming the standing plan")
  const at5 = inDays(3)
  const r5 = await post(url, tok.sender, {
    hubId: hubB.id, at: at5,
    replaces: { hubId: hubC.id, at: at3, proposedBy: "receiver" },
  })
  check("counter: 200", r5.status === 200, r5)
  if (r5.status === 200) expectedProposals++
  const d5 = await row(trade.id)
  check("row is hubB by sender, unagreed", d5.meetupHubId === hubB.id && d5.meetupProposedBySender === true && d5.meetupAgreedAt === null, d5)

  // ── 6 ──
  head("6  agreeing")
  const r6a = await post(`${url}/accept`, tok.receiver, { confirmHubId: hubC.id, confirmAt: at3 })
  check("agreeing a plan that changed: 409", r6a.status === 409, r6a)
  const r6 = await post(`${url}/accept`, tok.receiver, { confirmHubId: hubB.id, confirmAt: at5 })
  check("agreeing the standing plan: 200", r6.status === 200, r6)
  check("agreedAt set", typeof r6.json.data?.plan?.agreedAt === "string", r6.json)

  // ── 7 ──
  head("7  an AGREED plan")
  const r7a = await post(url, tok.sender, { hubId: hubA.id, at: inDays(4) })
  check("proposer's fresh pick over it: 409 MEETUP_ALREADY_AGREED", r7a.status === 409 && r7a.json.meta?.rule === "MEETUP_ALREADY_AGREED", r7a)
  const r7b = await post(url, tok.receiver, { hubId: hubA.id, at: inDays(4) })
  check("agreer's fresh pick over it: 409 MEETUP_ALREADY_AGREED", r7b.status === 409 && r7b.json.meta?.rule === "MEETUP_ALREADY_AGREED", r7b)
  check("…carrying the agreed plan", typeof r7b.json.meta?.plan?.agreedAt === "string", r7b.json.meta)
  check("still agreed in the row", (await row(trade.id)).meetupAgreedAt !== null)
  const at7 = inDays(4)
  const r7c = await post(url, tok.receiver, {
    hubId: hubA.id, at: at7,
    replaces: { hubId: hubB.id, at: at5, proposedBy: "sender" },
  })
  check("a counter naming the agreed plan reopens it: 200", r7c.status === 200, r7c)
  if (r7c.status === 200) expectedProposals++
  const d7 = await row(trade.id)
  check("row is hubA by receiver, agreement cleared", d7.meetupHubId === hubA.id && d7.meetupProposedBySender === false && d7.meetupAgreedAt === null, d7)

  // ── 8 ──
  head(`8  RACE: two fresh picks at once on an empty table (x${RACE_ROUNDS})`)
  let race8ok = 0
  for (let i = 0; i < RACE_ROUNDS; i++) {
    await prisma.trade.update({ where: { id: trade.id }, data: NO_MEETUP_PLAN })
    const atS = inDays(5, i)
    const atR = inDays(6, i)
    const [s, r] = await Promise.all([
      post(url, tok.sender, { hubId: hubB.id, at: atS }),
      post(url, tok.receiver, { hubId: hubC.id, at: atR }),
    ])
    const wins = [s, r].filter((x) => x.status === 200).length
    expectedProposals += wins
    const loser = s.status === 200 ? r : s
    const winnerHub = s.status === 200 ? hubB.id : hubC.id
    const d = await row(trade.id)
    const good =
      wins === 1 &&
      loser.status === 409 &&
      loser.json.meta?.rule === "MEETUP_PENDING_FROM_PARTNER" &&
      loser.json.meta?.plan?.hub?.id === winnerHub &&
      d.meetupHubId === winnerHub
    if (good) race8ok++
    else console.log("        round", i, { sender: [s.status, s.json.meta?.rule], receiver: [r.status, r.json.meta?.rule], row: d.meetupHubId })
  }
  check(`exactly one winner, loser told the winner's plan, in ${RACE_ROUNDS}/${RACE_ROUNDS} rounds`, race8ok === RACE_ROUNDS, `${race8ok}/${RACE_ROUNDS}`)

  // ── 9 ──
  head(`9  RACE: two counters to the same plan at once (x${RACE_ROUNDS})`)
  let race9ok = 0
  for (let i = 0; i < RACE_ROUNDS; i++) {
    const at = new Date(inDays(7, i))
    await prisma.trade.update({
      where: { id: trade.id },
      data: { meetupHubId: hubA.id, meetupAt: at, meetupNote: null, meetupProposedBySender: false, meetupAgreedAt: null },
    })
    const replaces = { hubId: hubA.id, at: at.toISOString(), proposedBy: "receiver" }
    const [x, y] = await Promise.all([
      post(url, tok.sender, { hubId: hubB.id, at: inDays(8, i), replaces }),
      post(url, tok.sender, { hubId: hubC.id, at: inDays(9, i), replaces }),
    ])
    const wins = [x, y].filter((z) => z.status === 200).length
    expectedProposals += wins
    const loser = x.status === 200 ? y : x
    if (wins === 1 && loser.status === 409 && loser.json.meta?.rule === "MEETUP_CHANGED") race9ok++
    else console.log("        round", i, { x: [x.status, x.json.meta?.rule], y: [y.status, y.json.meta?.rule] })
  }
  check(`exactly one counter wins in ${RACE_ROUNDS}/${RACE_ROUNDS} rounds`, race9ok === RACE_ROUNDS, `${race9ok}/${RACE_ROUNDS}`)

  // ── 10 ──
  head(`10 RACE: an agree and a counter at once (x${RACE_ROUNDS})`)
  let race10ok = 0
  for (let i = 0; i < RACE_ROUNDS; i++) {
    const at = new Date(inDays(10, i))
    await prisma.trade.update({
      where: { id: trade.id },
      data: { meetupHubId: hubA.id, meetupAt: at, meetupNote: null, meetupProposedBySender: false, meetupAgreedAt: null },
    })
    // The sender agrees the receiver's hubA while the receiver changes it to hubC.
    const [agree, change] = await Promise.all([
      post(`${url}/accept`, tok.sender, { confirmHubId: hubA.id, confirmAt: at.toISOString() }),
      post(url, tok.receiver, { hubId: hubC.id, at: inDays(11, i) }),
    ])
    if (change.status === 200) expectedProposals++
    const d = await row(trade.id)
    // The one forbidden end state: agreed, on hubC, which the sender never saw.
    const forbidden = d.meetupAgreedAt !== null && d.meetupHubId === hubC.id
    const consistent =
      (agree.status === 200 && change.status === 409 && d.meetupHubId === hubA.id && d.meetupAgreedAt !== null) ||
      (change.status === 200 && agree.status === 409 && d.meetupHubId === hubC.id && d.meetupAgreedAt === null)
    if (!forbidden && consistent) race10ok++
    else console.log("        round", i, { agree: agree.status, change: [change.status, change.json.meta?.rule], row: d })
  }
  check(`never agreed on an unseen plan, one clear winner, in ${RACE_ROUNDS}/${RACE_ROUNDS} rounds`, race10ok === RACE_ROUNDS, `${race10ok}/${RACE_ROUNDS}`)

  // ── 11 ──
  head("11 notifications: one per 200, none per 409")
  const n = await proposals(trade.id)
  check(`MEETUP_PROPOSED rows = successful proposals (${expectedProposals})`, n === expectedProposals, { rows: n, expected: expectedProposals })

  // ── 12 ──
  head("12 refusals that are not about the plan")
  const bad = await post(url, tok.sender, {
    hubId: hubB.id, at: inDays(3),
    replaces: { hubId: hubA.id, at: inDays(2), proposedBy: "nobody" },
  })
  check("malformed replaces: 400", bad.status === 400, bad)
  await prisma.trade.update({ where: { id: trade.id }, data: { ...NO_MEETUP_PLAN, status: "CONFIRMING" } })
  const late = await post(url, tok.sender, { hubId: hubB.id, at: inDays(3) })
  check("trade in CONFIRMING: 409 with no plan rule", late.status === 409 && !late.json.meta?.rule, late)

  console.log(`\n${pass} passed, ${fail} failed`)
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
