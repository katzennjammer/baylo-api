// Acceptance harness: BOTH parties see the SAME meetup plan, over HTTP.
//
// RUNS AGAINST A SCRATCH SCHEMA and a dev server bound to it:
//
//   .\scripts\scratch.ps1 -Push -Name scratch_http
//   .\scripts\scratch.ps1 -Dev  -Name scratch_http -Port 3001
//   # another window, same scratch URL in DATABASE_URL:
//   $env:ACCEPT_BASE="http://127.0.0.1:3001"
//   npx tsx --env-file=.env scripts/verify-meetup-both-sides.ts
//   .\scripts\scratch.ps1 -Drop -Name scratch_http
//
// ══ WHY THIS EXISTS BESIDE verify-meetup-plan.ts ═══════════════════════════
//
// verify-meetup-plan writes the four plan columns through Prisma and reads
// them back through the lib functions. It never calls a route and it never
// looks at the trade AS THE OTHER PERSON, so it passes 27/27 while saying
// nothing about the two questions a "the other trader can't see it" report
// actually asks:
//
//   - does every route that carries a trade to a phone carry the plan to BOTH
//     phones, with `proposedBy` reading correctly from each side?
//   - is the row the two phones would draw the same row?
//
// So this harness is the second user's phone. Every read below is made twice,
// once with each token, and the assertions compare the two responses to each
// other rather than to the database.
//
// What it pins down, in order:
//   1  before any proposal both sides read `meetup: null` on the list
//   2  the RECEIVER proposes; the list then carries the plan to BOTH sides,
//      byte-identical, with the proposer's own `direction` opposite the other's
//   3  GET …/meetup — the picker — carries the same plan to both, and `you`
//      is the side each caller is on
//   4  the SENDER counters; both sides read the counter, agreement cleared
//   5  the receiver agrees; both sides read `agreedAt` set, same instant
//   6  the plan is on the wire for a viewer who hid the trade? — NO: a hidden
//      trade is not listed at all, on purpose, and that is the ONE legitimate
//      way one side "cannot see" a plan the other can. Pinned so nobody
//      mistakes it for the bug above.
//   7  a proposal bumps `updatedAt` — the list is sorted on it, and a client
//      that keys freshness on it must see the row move
//   8  THE PARTNER'S PHONE HEARS ABOUT IT. A real pusher-js subscription to
//      the sender's private channel, authorised through the scratch server,
//      receives `meetup-changed` for the receiver's proposal and for the
//      receiver's agreement — and NOT for the sender's own counter, which is
//      the proposer's phone and invalidates itself.
//   9  NOBODY ELSE CAN LISTEN. A third user asking /api/pusher/auth for the
//      sender's channel is refused; the sender asking for their own is not.
//
// 8 needs the Pusher keys in .env and a route to Pusher's cluster; without
// them it fails rather than skips, because "the event was sent" is the claim
// the fix rests on and an unverifiable claim is a failure here.

import Pusher from "pusher-js"
import prisma from "../src/lib/prisma"
import { requireScratchSchema } from "./lib/live-guard"
import { signAccessToken } from "../src/lib/auth-tokens"
import { MEETUP_CHANGED_EVENT, type MeetupChangedPayload } from "../src/lib/meetup-events"

const BASE = process.env.ACCEPT_BASE ?? "http://127.0.0.1:3001"
const P = "ZZMEETUP2_"
let pass = 0
let fail = 0

function check(name: string, cond: boolean, detail: unknown = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}   ${typeof detail === "string" ? detail : JSON.stringify(detail)}`) }
}
function head(s: string) {
  console.log(`\n── ${s} ${"─".repeat(Math.max(0, 66 - s.length))}`)
}

type Json = Record<string, any>

async function get(path: string, token: string): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } })
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json }
}
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
      title: `${P}${tag}`, description: "fixture", images: "[]", category: "OTHER", condition: "GOOD",
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
    await prisma.tradeRequest.deleteMany({ where: { OR: [{ senderId: { in: ids } }, { receiverId: { in: ids } }] } })
    await prisma.itemSafeZone.deleteMany({ where: { item: { userId: { in: ids } } } })
    await prisma.item.deleteMany({ where: { userId: { in: ids } } })
    await prisma.user.deleteMany({ where: { id: { in: ids } } })
  }
  await prisma.safeZoneHub.deleteMany({ where: { id: { startsWith: P } } })
}

/** The trade row each side reads from the list, or null when it is not listed. */
async function listRow(token: string, tradeId: string) {
  const r = await get("/api/v1/trades?tab=active&limit=50", token)
  if (r.status !== 200) throw new Error(`list ${r.status} ${JSON.stringify(r.json)}`)
  const rows: Json[] = r.json.data?.trades ?? []
  return rows.find((t) => t.id === tradeId) ?? null
}

/**
 * A phone. Subscribes to `private-user-<id>` the way the app does — the node
 * build of pusher-js, authorised by POSTing to the scratch server with the
 * user's Bearer token — and collects every `meetup-changed` it hears.
 */
async function phone(token: string, userId: string) {
  const key = process.env.NEXT_PUBLIC_PUSHER_KEY
  const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER
  if (!key || !cluster) throw new Error("NEXT_PUBLIC_PUSHER_KEY / _CLUSTER missing from the environment")

  // The node bundle is CommonJS and hangs the constructor on `module.Pusher`
  // rather than a default export — the same shape the mobile module unpicks.
  const Ctor = (Pusher as unknown as { Pusher?: typeof Pusher }).Pusher ?? Pusher
  const client = new Ctor(key, {
    cluster,
    channelAuthorization: {
      transport: "ajax",
      endpoint: `${BASE}/api/pusher/auth`,
      headers: { Authorization: `Bearer ${token}` },
    },
  })
  const heard: MeetupChangedPayload[] = []
  const channel = client.subscribe(`private-user-${userId}`)
  channel.bind(MEETUP_CHANGED_EVENT, (data: MeetupChangedPayload) => heard.push(data))

  const subscribed = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 15_000)
    channel.bind("pusher:subscription_succeeded", () => { clearTimeout(t); resolve(true) })
    channel.bind("pusher:subscription_error", () => { clearTimeout(t); resolve(false) })
  })

  /** Waits until `heard` holds at least `n` events, or gives up. */
  const waitFor = async (n: number, ms = 10_000) => {
    const until = Date.now() + ms
    while (heard.length < n && Date.now() < until) await new Promise((r) => setTimeout(r, 100))
    return heard.length >= n
  }
  return { subscribed, heard, waitFor, close: () => client.disconnect() }
}

/** The raw channel-auth handshake, as pusher-js would make it. */
async function authFor(token: string, channelName: string) {
  return post("/api/pusher/auth", token, { socket_id: "1234.5678", channel_name: channelName })
}

async function main() {
  requireScratchSchema("scripts/verify-meetup-both-sides.ts")
  await cleanup()

  const sender = await mkUser("sender")
  const receiver = await mkUser("receiver")
  const offered = await mkItem(sender.id, "offered")
  const requested = await mkItem(receiver.id, "requested")
  const hubA = await mkHub("hubA")
  const hubB = await mkHub("hubB")
  const trade = await prisma.tradeRequest.create({
    data: {
      status: "ACCEPTED",
      senderId: sender.id, receiverId: receiver.id,
      offeredItemId: offered.id, requestedItemId: requested.id,
    },
    select: { id: true, updatedAt: true },
  })

  // The sender's phone, listening from before anything happens. Steps 2, 4
  // and 5 each say what it should — and should not — have heard by then.
  const senderPhone = await phone(sender.token, sender.id)
  check("sender's phone subscribed to its private channel", senderPhone.subscribed)

  // ── 1 ──
  head("1  no plan: both sides read meetup: null")
  const s1 = await listRow(sender.token, trade.id)
  const r1 = await listRow(receiver.token, trade.id)
  check("sender lists the trade", !!s1)
  check("receiver lists the trade", !!r1)
  check("sender reads meetup: null", s1?.meetup === null, s1?.meetup)
  check("receiver reads meetup: null", r1?.meetup === null, r1?.meetup)
  check("directions are opposite", s1?.direction === "sent" && r1?.direction === "received", [s1?.direction, r1?.direction])

  // ── 2 ──
  head("2  the RECEIVER proposes; both lists carry the same plan")
  const at = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
  at.setMilliseconds(0)
  const prop = await post(`/api/v1/trades/${trade.id}/meetup`, receiver.token, {
    hubId: hubA.id, at: at.toISOString(), note: "blue bag",
  })
  check("proposal accepted (200)", prop.status === 200, prop)
  check("route echoes proposedBy: receiver", prop.json.data?.plan?.proposedBy === "receiver", prop.json)

  const s2 = await listRow(sender.token, trade.id)
  const r2 = await listRow(receiver.token, trade.id)
  if (process.env.DUMP) {
    // The two wires side by side, for a report that needs to see them.
    const pick = (row: Json | null) => row && { direction: row.direction, status: row.status, meetup: row.meetup }
    console.log("\n  sender   GET /api/v1/trades row:", JSON.stringify(pick(s2), null, 2))
    console.log("\n  receiver GET /api/v1/trades row:", JSON.stringify(pick(r2), null, 2))
  }
  check("SENDER (the other side) reads the plan on the list", !!s2?.meetup, s2)
  check("receiver (the proposer) reads the plan on the list", !!r2?.meetup, r2)
  check(
    "the two plans are byte-identical",
    JSON.stringify(s2?.meetup) === JSON.stringify(r2?.meetup),
    { sender: s2?.meetup, receiver: r2?.meetup },
  )
  check("hub is the proposed one", s2?.meetup?.hub?.id === hubA.id, s2?.meetup?.hub)
  check("at is the proposed instant", s2?.meetup?.at === at.toISOString(), [s2?.meetup?.at, at.toISOString()])
  check("note travels", s2?.meetup?.note === "blue bag", s2?.meetup?.note)
  check("proposedBy is a SIDE, the same on both wires", s2?.meetup?.proposedBy === "receiver" && r2?.meetup?.proposedBy === "receiver")
  check("agreedAt is null on both", s2?.meetup?.agreedAt === null && r2?.meetup?.agreedAt === null)
  // What each phone's meetupState() would derive: the proposer waits, the
  // other side answers. This is the line the two screens draw.
  const mine = (row: Json) => row.meetup.proposedBy === (row.direction === "sent" ? "sender" : "receiver")
  check("sender's phone derives yours-to-answer", !mine(s2!))
  check("receiver's phone derives waiting-on-them", mine(r2!))

  // ── 8a ── the partner heard it.
  check("sender's phone received meetup-changed for the proposal", await senderPhone.waitFor(1), senderPhone.heard)
  check(
    "…naming this trade, kind 'proposed', actor = receiver",
    senderPhone.heard[0]?.tradeId === trade.id && senderPhone.heard[0]?.kind === "proposed" && senderPhone.heard[0]?.actorId === receiver.id,
    senderPhone.heard[0],
  )

  // ── 3 ──
  head("3  GET …/meetup carries the same plan to both, with `you` per caller")
  const ms = await get(`/api/v1/trades/${trade.id}/meetup`, sender.token)
  const mr = await get(`/api/v1/trades/${trade.id}/meetup`, receiver.token)
  check("sender 200", ms.status === 200, ms)
  check("receiver 200", mr.status === 200, mr)
  check("same plan on both", JSON.stringify(ms.json.data?.plan) === JSON.stringify(mr.json.data?.plan), [ms.json.data?.plan, mr.json.data?.plan])
  check("same plan as the list", JSON.stringify(ms.json.data?.plan) === JSON.stringify(s2?.meetup))
  check("`you` is per caller", ms.json.data?.you === "sender" && mr.json.data?.you === "receiver", [ms.json.data?.you, mr.json.data?.you])

  // ── 4 ──
  head("4  the SENDER counters; both read the counter, agreement cleared")
  const at2 = new Date(at.getTime() + 60 * 60 * 1000)
  const counter = await post(`/api/v1/trades/${trade.id}/meetup`, sender.token, { hubId: hubB.id, at: at2.toISOString() })
  check("counter accepted (200)", counter.status === 200, counter)
  const s4 = await listRow(sender.token, trade.id)
  const r4 = await listRow(receiver.token, trade.id)
  check("both read hubB", s4?.meetup?.hub?.id === hubB.id && r4?.meetup?.hub?.id === hubB.id, [s4?.meetup?.hub?.id, r4?.meetup?.hub?.id])
  check("both read proposedBy: sender", s4?.meetup?.proposedBy === "sender" && r4?.meetup?.proposedBy === "sender")
  check("note cleared on both (a counter is a whole new plan)", s4?.meetup?.note === null && r4?.meetup?.note === null)
  check("identical", JSON.stringify(s4?.meetup) === JSON.stringify(r4?.meetup))

  // ── 8b ── the sender's own counter goes to the RECEIVER, not back to the
  // sender. Waiting for a second event here must time out.
  check("sender's phone did NOT hear its own counter", !(await senderPhone.waitFor(2, 3_000)), senderPhone.heard)

  // ── 5 ──
  head("5  the receiver agrees; both read the same agreedAt")
  const agree = await post(`/api/v1/trades/${trade.id}/meetup/accept`, receiver.token, { confirmHubId: hubB.id, confirmAt: at2.toISOString() })
  check("agree accepted (200)", agree.status === 200, agree)
  const s5 = await listRow(sender.token, trade.id)
  const r5 = await listRow(receiver.token, trade.id)
  check("sender reads agreedAt", typeof s5?.meetup?.agreedAt === "string", s5?.meetup)
  check("receiver reads agreedAt", typeof r5?.meetup?.agreedAt === "string", r5?.meetup)
  check("same instant", s5?.meetup?.agreedAt === r5?.meetup?.agreedAt)
  check("identical", JSON.stringify(s5?.meetup) === JSON.stringify(r5?.meetup))

  // ── 8c ── the agreement reaches the proposer (the sender countered, so the
  // sender is the proposer of the standing plan).
  check("sender's phone received meetup-changed for the agreement", await senderPhone.waitFor(2), senderPhone.heard)
  check(
    "…kind 'agreed', actor = receiver",
    senderPhone.heard[1]?.tradeId === trade.id && senderPhone.heard[1]?.kind === "agreed" && senderPhone.heard[1]?.actorId === receiver.id,
    senderPhone.heard[1],
  )

  // ── 6 ──
  head("6  the ONE legitimate one-sided blindness: a hidden trade is not listed")
  await prisma.tradeRequest.update({ where: { id: trade.id }, data: { hiddenBySender: true } })
  const s6 = await listRow(sender.token, trade.id)
  const r6 = await listRow(receiver.token, trade.id)
  check("sender, who hid it, does not list it", s6 === null, s6)
  check("receiver still lists it, plan intact", !!r6?.meetup?.agreedAt, r6)
  const ms6 = await get(`/api/v1/trades/${trade.id}/meetup`, sender.token)
  check("…but GET …/meetup still answers the sender (hiding is a list filter)", ms6.status === 200 && !!ms6.json.data?.plan, ms6)
  await prisma.tradeRequest.update({ where: { id: trade.id }, data: { hiddenBySender: false } })

  // ── 7 ──
  head("7  a proposal bumps updatedAt (the list's sort key)")
  const now = await prisma.tradeRequest.findUnique({ where: { id: trade.id }, select: { updatedAt: true } })
  check("updatedAt moved past the fixture's", !!now && now.updatedAt.getTime() > trade.updatedAt.getTime(), [trade.updatedAt, now?.updatedAt])

  // ── 9 ──
  head("9  only the owner can subscribe to private-user-<id>")
  const stranger = await mkUser("stranger")
  const asStranger = await authFor(stranger.token, `private-user-${sender.id}`)
  check("a third user is refused the sender's channel (403)", asStranger.status === 403, asStranger)
  const asReceiver = await authFor(receiver.token, `private-user-${sender.id}`)
  check("even the trade partner is refused it (403)", asReceiver.status === 403, asReceiver)
  const asSender = await authFor(sender.token, `private-user-${sender.id}`)
  check("the owner is authorised (200 with an auth signature)", asSender.status === 200 && typeof asSender.json.auth === "string", asSender)
  const anon = await fetch(`${BASE}/api/pusher/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ socket_id: "1234.5678", channel_name: `private-user-${sender.id}` }),
  })
  check("no token at all is refused (401)", anon.status === 401, anon.status)

  senderPhone.close()

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
