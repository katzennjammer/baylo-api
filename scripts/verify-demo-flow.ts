// Acceptance harness: the phone checklist, end to end, over HTTP.
//
// TWO USERS PLAY THE DEMO the way baylo-mobile does it: the same routes, the
// same bodies, the same order, each with its own Bearer token from the real
// mobile sign-in (POST /api/auth/token). Every step checks three things: the
// HTTP status, the response body, and the rows the step must leave behind.
//
// It is a STORY, not a rule-by-rule harness. Each rule here is pinned in depth
// elsewhere, and this file deliberately does not repeat that depth:
//
//   login, sessions, replay       verify-active-sessions.ts
//   one standing hub plan, races  verify-hub-suggestion.ts, verify-meetup-both-sides.ts
//   bridge fees, every refusal    verify-bracket-trading.ts
//   each side sees its own code   verify-settle-and-code-http.ts
//   a Pusher failure is harmless  verify-pusher-safe.ts
//   one status card per view      verify-offer-accept-realtime-http.ts
//
// What this adds is the ORDER: one pair of accounts walking the whole
// checklist, so a step that only breaks after an earlier one shows up here.
//
// ══ RUN (scratch only) ══════════════════════════════════════════════════════
//
//   # window 1 -- the server. Real Pusher first, then broken (the default):
//   .\scripts\scratch-dev-safe.ps1 -Name scratch_flow -Port 3001 -PusherSecret real
//   .\scripts\scratch-dev-safe.ps1 -Name scratch_flow -Port 3001 -NoPush
//
//   # window 2 -- once per schema, the hubs (categories come with -Push):
//   $env:DATABASE_URL = "${base}?schema=scratch_flow"
//   npx tsx --env-file=.env scripts/seed-safezone-hubs.ts
//
//   # window 2 -- each run; DEMO_FLOW_PUSHER says which server it is talking to:
//   $env:ACCEPT_BASE = "http://127.0.0.1:3001"; $env:DEMO_FLOW_PUSHER = "real"   # or "broken"
//   npx tsx --env-file=.env scripts/verify-demo-flow.ts
//
// With "real", a pusher-js client per user subscribes through /api/pusher/auth
// and section 11 asserts the events reached both. With "broken", the same
// steps must pass with no socket at all. Accounts are new on every run (the
// login limit is per email), so both runs share one schema; drop it after.
//
// ══ THE STEPS ═══════════════════════════════════════════════════════════════
//
//    1  both sign in; each token's sid is a live refresh family
//    2  A posts a listing with wanted categories and hubs; B posts, offers;
//       A accepts
//    3  A suggests a hub, B counters, A agrees: ONE plan, both sides read it
//    4  the code exchange to COMPLETED: rewards, ledger, TRADE_COMPLETED for
//       both, a completion card for both
//    5  a cross-bracket offer (B pays the bridge fee), accepted, then
//       cancelled: no error, items AVAILABLE, the fee back
//    6  a decline, then a withdraw: no error, right statuses
//    7  each side's thread, collapsed as the phone collapses it: exactly one
//       decision card per decided offer
//    8  messages both ways: one row per send, no duplicates in either view
//    9  B on a second device; device 1 signs it out; its token is refused
//   10  the ledger invariant and every balance reconciled to its rows
//   11  (real Pusher only) the events reached both sockets

import bcrypt from "bcryptjs"
import Pusher from "pusher-js"
import prisma from "../src/lib/prisma"
import { requireScratchSchema } from "./lib/live-guard"
import { ledgerInvariant } from "./lib/ledger-invariant"
import { hashRefreshToken, verifyAccessToken } from "../src/lib/auth-tokens"
import { bracketOf } from "../src/lib/brackets"
import { BRIDGE_FEE_PER_BRACKET, TRADE_REWARD_PER_BRACKET, TRADING_POLICY_VERSION } from "../src/lib/trade-rules"
import { TASK_REWARDS } from "../src/lib/task-constants"
import { collapseSystemPairs } from "./lib/mobile-system-pairs"

const schema = requireScratchSchema("scripts/verify-demo-flow.ts")
const MODE = process.env.DEMO_FLOW_PUSHER
if (MODE !== "real" && MODE !== "broken") {
  console.error('\n  REFUSING: set DEMO_FLOW_PUSHER to "real" or "broken" -- the Pusher mode the server was started in.\n')
  process.exit(1)
}
const BASE = (process.env.ACCEPT_BASE ?? "http://127.0.0.1:3001").replace(/\/+$/, "")
const RUN = Date.now().toString(36)
const P = `ZZDEMO_${RUN}_`
const PASSWORD = "demo-flow-pass-1"

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail: unknown = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}   ${typeof detail === "string" ? detail : JSON.stringify(detail)}`) }
}
function head(s: string) {
  console.log(`\n── ${s} ${"─".repeat(Math.max(0, 66 - s.length))}`)
}

// ── HTTP, as the phone sends it ─────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON from the wire
type Json = Record<string, any>
type Res = { status: number; json: Json; text: string }

async function call(method: string, path: string, token: string | null, body?: Json): Promise<Res> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let json: Json = {}
  try { json = JSON.parse(text) as Json } catch { json = { _raw: text.slice(0, 160) } }
  return { status: res.status, json, text }
}
const brief = (r: Res) => `${r.status} ${JSON.stringify(r.json).slice(0, 240)}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** An instant `days` ahead, whole seconds, so it round-trips exactly. */
function inDays(days: number, plusMinutes = 0) {
  const d = new Date(Date.now() + days * 86_400_000 + plusMinutes * 60_000)
  d.setMilliseconds(0)
  return d.toISOString()
}

// ── Database reads ──────────────────────────────────────────────────────────

const tradeRow = (id: string) =>
  prisma.trade.findUniqueOrThrow({
    where: { id },
    select: {
      status: true, offerStatus: true, senderId: true, receiverId: true,
      offeredItemId: true, requestedItemId: true, safeZoneHubId: true,
      meetupHubId: true, meetupAt: true, meetupProposedBySender: true, meetupAgreedAt: true,
    },
  })
const itemStatus = async (id: string) =>
  (await prisma.item.findUniqueOrThrow({ where: { id }, select: { status: true } })).status
const balance = async (id: string) =>
  (await prisma.user.findUniqueOrThrow({ where: { id }, select: { leaves: true } })).leaves
const ledgerSum = async (userId: string) =>
  (await prisma.leafTransaction.aggregate({ where: { userId }, _sum: { amount: true } }))._sum.amount ?? 0
const tradeLedger = (tradeId: string) =>
  prisma.leafTransaction.findMany({
    where: { tradeId },
    select: { userId: true, type: true, amount: true, task: true },
    orderBy: { createdAt: "asc" },
  })
/** Async QUEST_REWARD rows (no tradeId) a user got since `since`. */
const questRowsSince = async (userId: string, since: Date) =>
  (await prisma.leafTransaction.aggregate({
    where: { userId, type: "QUEST_REWARD", createdAt: { gte: since } },
    _sum: { amount: true },
  }))._sum.amount ?? 0
const notes = (userId: string, type: string, entityId?: string) =>
  prisma.notification.count({ where: { userId, type: type as never, ...(entityId ? { entityId } : {}) } })
const cardsFor = (tradeId: string, type: "offer_update" | "trade_completed") =>
  prisma.message.count({ where: { tradeId, content: { contains: `"type":"${type}"` } } })

/** Fire-and-forget writes (completion notifications) land a moment after the response. */
async function eventually(read: () => Promise<number>, want: number, ms = 5000) {
  let n = await read()
  const until = Date.now() + ms
  while (n !== want && Date.now() < until) { await sleep(200); n = await read() }
  return n
}

// ── Fixtures: new accounts, signed in the way the phone signs in ────────────

type Device = { accessToken: string; refreshToken: string; userId: string }
type Person = { id: string; email: string; name: string; d1: Device }

async function mkAccount(tag: string) {
  const email = `${P}${tag}@example.com`.toLowerCase()
  const u = await prisma.user.create({
    data: {
      name: `${P}${tag}`, email,
      password: await bcrypt.hash(PASSWORD, 4),
      dateOfBirth: new Date("1995-05-05T00:00:00Z"),
      // A verified account past the ID gate, the shape prisma/seed.ts gives
      // its accounts: verified, grant claimed, grandfathered past the ID check.
      isVerified: true, signupGrantClaimed: true, idVerifiedGrandfatheredAt: new Date(),
      leaves: 0,
    },
  })
  // The signup grant, through the ledger, so the invariant holds from row one.
  // B needs it to pay the bridge fee in step 5.
  const GRANT = 20
  await prisma.$transaction([
    prisma.user.update({ where: { id: u.id }, data: { leaves: { increment: GRANT } } }),
    prisma.leafTransaction.create({
      data: { userId: u.id, type: "SIGNUP_GRANT", amount: GRANT, description: `${P} signup grant`, eventAt: new Date() },
    }),
  ])
  return { id: u.id, email, name: u.name ?? tag }
}

async function login(email: string): Promise<Res> {
  return call("POST", "/api/auth/token", null, { email, password: PASSWORD })
}

const familyOf = async (refreshToken: string) =>
  (await prisma.authToken.findUnique({ where: { tokenHash: hashRefreshToken(refreshToken) } }))?.familyId ?? null

// ── Listings, through POST /api/items as the post wizard sends them ─────────

async function postListing(who: Person, tag: string, valueLeaves: number, hubIds: string[], lookingFor: string[] = []) {
  const r = await call("POST", "/api/items", who.d1.accessToken, {
    title: `${P}${tag}`,
    description: `demo flow listing ${tag}`,
    category: "ELECTRONICS",
    condition: "GOOD",
    valueLeaves,
    images: [],
    hubIds,
    ...(lookingFor.length ? { lookingForCategories: lookingFor } : {}),
  })
  const id = r.json.id as string | undefined
  return { r, id: id ?? "" }
}

// ── Realtime, only when the server's Pusher is real ─────────────────────────

type Heard = { event: string; data: unknown }
async function socket(token: string, userId: string) {
  const key = process.env.NEXT_PUBLIC_PUSHER_KEY
  const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER
  if (!key || !cluster) throw new Error("NEXT_PUBLIC_PUSHER_KEY / _CLUSTER missing from the environment")
  // The node bundle is CommonJS and hangs the constructor on `module.Pusher`.
  const Ctor = (Pusher as unknown as { Pusher?: typeof Pusher }).Pusher ?? Pusher
  const client = new Ctor(key, {
    cluster,
    channelAuthorization: {
      transport: "ajax",
      endpoint: `${BASE}/api/pusher/auth`,
      headers: { Authorization: `Bearer ${token}` },
    },
  })
  const heard: Heard[] = []
  const channel = client.subscribe(`private-user-${userId}`)
  channel.bind_global((event: string, data: unknown) => {
    if (!event.startsWith("pusher:")) heard.push({ event, data })
  })
  const subscribed = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 15_000)
    channel.bind("pusher:subscription_succeeded", () => { clearTimeout(t); resolve(true) })
    channel.bind("pusher:subscription_error", () => { clearTimeout(t); resolve(false) })
  })
  return { subscribed, heard, close: () => client.disconnect() }
}

// ═════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log(`  base ${BASE}   schema ${schema}   pusher ${MODE}   run ${RUN}`)
  const ping = await fetch(`${BASE}/api/auth/token`, { method: "POST", body: "{}" }).catch(() => null)
  if (!ping) {
    console.error(`\n  No server at ${BASE}. Start scripts\\scratch-dev-safe.ps1 first (see the header).\n`)
    process.exit(2)
  }

  head("0  preconditions")
  const hubs = await prisma.safeZoneHub.findMany({ where: { isActive: true }, select: { id: true }, orderBy: { id: "asc" }, take: 2 })
  check("two active Safe-Zone hubs (else: seed-safezone-hubs.ts on this schema)", hubs.length === 2, hubs.length)
  const cats = await prisma.category.count({ where: { id: { in: ["BOOKS", "FURNITURE", "ELECTRONICS"] } } })
  check("categories seeded (scratch.ps1 -Push does it)", cats === 3, cats)
  const inv0 = await ledgerInvariant(prisma)
  check("ledger invariant holds before the run", inv0.ok, inv0.lines.filter((l) => l.includes("BROKEN")).join(" | "))
  if (hubs.length < 2 || cats < 3) return
  const [H1, H2] = hubs.map((h) => h.id)

  // ═══ 1 ═══
  head("1  both sign in with the mobile token flow")
  const accA = await mkAccount("a")
  const accB = await mkAccount("b")
  const people: Person[] = []
  for (const acc of [accA, accB]) {
    const r = await login(acc.email)
    const ok = r.status === 200 && typeof r.json.accessToken === "string" && typeof r.json.refreshToken === "string"
    check(`${acc.name.slice(P.length)}: POST /api/auth/token -> 200 with a token pair`, ok, brief(r))
    check("...and the user it names is this account", r.json.user?.id === acc.id, r.json.user)
    if (!ok) return
    const fam = await familyOf(r.json.refreshToken)
    const sid = (await verifyAccessToken(r.json.accessToken))?.sid ?? null
    check("...a REFRESH row was written, and the token's sid is its family", !!fam && sid === fam, { fam, sid })
    people.push({ ...acc, d1: { accessToken: r.json.accessToken, refreshToken: r.json.refreshToken, userId: acc.id } })
  }
  const [A, B] = people

  // Sockets now, so section 11 hears everything from step 2 on.
  const sockA = MODE === "real" ? await socket(A.d1.accessToken, A.id) : null
  const sockB = MODE === "real" ? await socket(B.d1.accessToken, B.id) : null
  if (MODE === "real") check("both sockets subscribed through /api/pusher/auth", !!sockA?.subscribed && !!sockB?.subscribed)

  // ═══ 2 ═══
  head("2  A posts with wanted categories; B offers; A accepts")
  const L1 = await postListing(A, "listing1", 200, [H1, H2], ["BOOKS", "FURNITURE"])
  check("A: POST /api/items -> 201", L1.r.status === 201 && !!L1.id, brief(L1.r))
  if (!L1.id) return
  const l1Row = await prisma.item.findUniqueOrThrow({
    where: { id: L1.id },
    select: { status: true, userId: true, valueLeaves: true, wantedCategories: { select: { category: true } }, safeZones: { select: { hubId: true } } },
  })
  check("...listing AVAILABLE, owned by A, at the value asked", l1Row.status === "AVAILABLE" && l1Row.userId === A.id && l1Row.valueLeaves === 200, l1Row)
  check("...wanted categories BOOKS + FURNITURE written",
    JSON.stringify(l1Row.wantedCategories.map((w) => w.category).sort()) === JSON.stringify(["BOOKS", "FURNITURE"]), l1Row.wantedCategories)
  check("...both hubs written", l1Row.safeZones.length === 2)

  const I1 = await postListing(B, "item1", 220, [H1, H2])
  check("B: POST /api/items -> 201 (the item B offers)", I1.r.status === 201 && !!I1.id, brief(I1.r))
  if (!I1.id) return

  const o1 = await call("POST", "/api/offers", B.d1.accessToken, { postId: L1.id, offeredItemId: I1.id })
  const t1 = o1.json.offerId as string | undefined
  check("B: POST /api/offers -> 201 with an offerId", o1.status === 201 && !!t1, brief(o1))
  check("...same bracket: no fee", o1.json.bridgeFeeLeaves === 0, o1.json)
  if (!t1) return
  const t1Row = await tradeRow(t1)
  check("...trade row PENDING, B sender, A receiver",
    t1Row.offerStatus === "PENDING" && t1Row.senderId === B.id && t1Row.receiverId === A.id, t1Row)
  // The offer card names the offer in its payload, not in Message.tradeId.
  check("...the offer card is in the chat", (await prisma.message.count({ where: { AND: [{ content: { contains: '"type":"offer"' } }, { content: { contains: `"offerId":"${t1}"` } }] } })) === 1)

  const a1 = await call("PATCH", `/api/offers/${t1}`, A.d1.accessToken, { action: "accept" })
  check("A: PATCH /api/offers/[id] accept -> 200 with the tradeId", a1.status === 200 && a1.json.tradeId === t1, brief(a1))
  const t1Acc = await tradeRow(t1)
  check("...trade ACCEPTED", t1Acc.status === "ACCEPTED", t1Acc)
  check("...both items IN_TRADE", (await itemStatus(L1.id)) === "IN_TRADE" && (await itemStatus(I1.id)) === "IN_TRADE")
  check("...TRADE_ACCEPTED notification for B", (await notes(B.id, "TRADE_ACCEPTED")) === 1)
  check("...two offer_update rows (one per side; the phone shows one -- step 7)", (await cardsFor(t1, "offer_update")) === 2)

  // ═══ 3 ═══
  head("3  hub: A suggests, B counters, A agrees -- one plan")
  const mUrl = `/api/v1/trades/${t1}/meetup`
  const at1 = inDays(2)
  const s1 = await call("POST", mUrl, A.d1.accessToken, { hubId: H1, at: at1 })
  check("A suggests H1: 200", s1.status === 200 && s1.json.data?.plan?.hub?.id === H1 && s1.json.data?.plan?.proposedBy === "receiver", brief(s1))
  const afterS1 = await tradeRow(t1)
  check("...row: H1, by the receiver (A), not agreed", afterS1.meetupHubId === H1 && afterS1.meetupProposedBySender === false && afterS1.meetupAgreedAt === null, afterS1)
  check("...MEETUP_PROPOSED notification for B", (await notes(B.id, "MEETUP_PROPOSED", t1)) === 1)

  const seenByB = await call("GET", mUrl, B.d1.accessToken)
  check("B: GET meetup -> 200, sees A's suggestion, is the sender",
    seenByB.status === 200 && seenByB.json.data?.plan?.hub?.id === H1 && seenByB.json.data?.you === "sender", brief(seenByB))
  const standing = seenByB.json.data?.plan ?? {}
  const at2 = inDays(3, 30)
  const c1 = await call("POST", mUrl, B.d1.accessToken, {
    hubId: H2, at: at2, replaces: { hubId: standing.hub?.id, at: standing.at, proposedBy: standing.proposedBy },
  })
  check("B counters with H2, naming the standing plan: 200", c1.status === 200 && c1.json.data?.plan?.hub?.id === H2, brief(c1))
  const afterC1 = await tradeRow(t1)
  check("...row: H2, by the sender (B), not agreed -- one plan, overwritten",
    afterC1.meetupHubId === H2 && afterC1.meetupProposedBySender === true && afterC1.meetupAgreedAt === null, afterC1)

  const ag = await call("POST", `${mUrl}/accept`, A.d1.accessToken, { confirmHubId: H2, confirmAt: at2 })
  check("A agrees to the standing plan: 200, agreedAt set", ag.status === 200 && typeof ag.json.data?.plan?.agreedAt === "string", brief(ag))
  const afterAg = await tradeRow(t1)
  check("...row: H2 agreed; the claim column still empty (a plan never pays)", afterAg.meetupHubId === H2 && !!afterAg.meetupAgreedAt && afterAg.safeZoneHubId === null, afterAg)
  const pa = await call("GET", mUrl, A.d1.accessToken)
  const pb = await call("GET", mUrl, B.d1.accessToken)
  check("both sides read the SAME plan", pa.status === 200 && pb.status === 200 &&
    JSON.stringify(pa.json.data?.plan) === JSON.stringify(pb.json.data?.plan), `${brief(pa)} | ${brief(pb)}`)

  // ═══ 4 ═══
  head("4  code exchange to COMPLETED")
  await sleep(1000) // let the quest rows from steps 2-3 land before the baseline
  const t4Start = new Date()
  const balA0 = await balance(A.id)
  const balB0 = await balance(B.id)
  const st = await call("POST", `/api/trades/${t1}/confirm/start`, A.d1.accessToken, {})
  check("confirm/start -> 200", st.status === 200, brief(st))
  const csA = await call("GET", `/api/trades/${t1}/confirm/status`, A.d1.accessToken)
  const csB = await call("GET", `/api/trades/${t1}/confirm/status`, B.d1.accessToken)
  const codeA = csA.json.code as string | undefined
  const codeB = csB.json.code as string | undefined
  check("each side reads its own code, and they differ", typeof codeA === "string" && typeof codeB === "string" && codeA !== codeB, `${brief(csA)} | ${brief(csB)}`)
  if (!codeA || !codeB) return
  const sub1 = await call("POST", `/api/trades/${t1}/confirm/submit`, A.d1.accessToken, { code: codeB })
  check("A types B's code: 200 correct, not yet complete", sub1.status === 200 && sub1.json.correct === true && sub1.json.completed !== true, brief(sub1))
  const sub2 = await call("POST", `/api/trades/${t1}/confirm/submit`, B.d1.accessToken, { code: codeA })
  check("B types A's code: 200 completed", sub2.status === 200 && sub2.json.completed === true, brief(sub2))
  const done = await tradeRow(t1)
  check("...trade COMPLETED", done.status === "COMPLETED", done)
  check("...the agreed hub became the claim (both listings name it)", done.safeZoneHubId === H2, done.safeZoneHubId)
  {
    // Completion hands each item over: OWNED, on the other person's shelf.
    const items = await prisma.item.findMany({ where: { id: { in: [L1.id, I1.id] } }, select: { id: true, status: true, userId: true } })
    const l1 = items.find((i) => i.id === L1.id)
    const i1 = items.find((i) => i.id === I1.id)
    check("...both items OWNED and swapped (A's listing to B, B's item to A)",
      l1?.status === "OWNED" && l1.userId === B.id && i1?.status === "OWNED" && i1.userId === A.id, items)
  }

  const rows = await tradeLedger(t1)
  const sumOf = (uid: string, pred: (r: (typeof rows)[number]) => boolean) =>
    rows.filter((r) => r.userId === uid && pred(r)).reduce((s, r) => s + r.amount, 0)
  const rewardA = TRADE_REWARD_PER_BRACKET * bracketOf(200)
  const rewardB = TRADE_REWARD_PER_BRACKET * bracketOf(220)
  check(`TRADE_REWARD: A ${rewardA}, B ${rewardB} (2 x the bracket each GAVE)`,
    sumOf(A.id, (r) => r.type === "TRADE_REWARD") === rewardA && sumOf(B.id, (r) => r.type === "TRADE_REWARD") === rewardB, rows)
  check(`FIRST_TRADE: ${TASK_REWARDS.FIRST_TRADE} each`,
    [A.id, B.id].every((u) => sumOf(u, (r) => r.task === "FIRST_TRADE") === TASK_REWARDS.FIRST_TRADE), rows)
  check(`SAFEZONE_MEETUP: ${TASK_REWARDS.SAFEZONE_MEETUP} each (agreed, shared hub)`,
    [A.id, B.id].every((u) => sumOf(u, (r) => r.task === "SAFEZONE_MEETUP") === TASK_REWARDS.SAFEZONE_MEETUP), rows)
  check("no fee rows on a same-bracket trade", rows.every((r) => !r.type.startsWith("BRIDGE_FEE")), rows)
  const fromTrade = (uid: string) => sumOf(uid, () => true)
  // Quest rewards settle asynchronously after the response and carry no
  // tradeId, so they are not in `rows`. Exact: the balance moved by this
  // trade's rows plus the quest rows written since step 4 began, nothing else.
  await sleep(1500)
  for (const [p, before] of [[A, balA0], [B, balB0]] as const) {
    const now = await balance(p.id)
    const quests = await questRowsSince(p.id, t4Start)
    check(`${p.name.slice(P.length)}: balance = before + this trade's rows + ${quests} in quest rows, and = its ledger`,
      now === before + fromTrade(p.id) + quests && now === (await ledgerSum(p.id)),
      { before, now, trade: fromTrade(p.id), quests, ledger: await ledgerSum(p.id) })
  }
  check("TRADE_COMPLETED notification for BOTH", (await eventually(() => prisma.notification.count({ where: { entityId: t1, type: "TRADE_COMPLETED" } }), 2)) === 2)
  check("...one each, not two for one side",
    (await notes(A.id, "TRADE_COMPLETED", t1)) === 1 && (await notes(B.id, "TRADE_COMPLETED", t1)) === 1)
  check("completion card written for both sides", (await cardsFor(t1, "trade_completed")) === 2, String(await cardsFor(t1, "trade_completed")))
  const inv4 = await ledgerInvariant(prisma)
  check("ledger invariant after completion", inv4.ok, inv4.lines.filter((l) => l.includes("BROKEN")).join(" | "))

  // ═══ 5 ═══
  head("5  cross-bracket offer, accepted, then cancelled -- fee refunded")
  const L2 = await postListing(A, "listing2", 200, [H1])  // bracket 2
  const I2 = await postListing(B, "item2", 80, [H1])      // bracket 1: B bridges up, B pays
  check("both listings posted (201, 201)", L2.r.status === 201 && I2.r.status === 201, `${brief(L2.r)} | ${brief(I2.r)}`)
  const fee = BRIDGE_FEE_PER_BRACKET * bracketOf(80)
  const balB5 = await balance(B.id)
  check(`B can cover the ${fee}-Leaf fee`, balB5 >= fee, balB5)
  const o2 = await call("POST", "/api/offers", B.d1.accessToken, {
    postId: L2.id, offeredItemId: I2.id, consent: { accepted: true, policyVersion: TRADING_POLICY_VERSION },
  })
  const t2 = o2.json.offerId as string | undefined
  check(`B offers with consent: 201, fee ${fee}, B pays`, o2.status === 201 && !!t2 && o2.json.bridgeFeeLeaves === fee, brief(o2))
  if (!t2) return
  const hold = (await tradeLedger(t2)).filter((r) => r.type === "BRIDGE_FEE_HOLD")
  check(`...one BRIDGE_FEE_HOLD of -${fee} on B`, hold.length === 1 && hold[0].userId === B.id && hold[0].amount === -fee, hold)
  const a2 = await call("PATCH", `/api/offers/${t2}`, A.d1.accessToken, { action: "accept" })
  check("A accepts: 200", a2.status === 200 && a2.json.tradeId === t2, brief(a2))
  check("...ACCEPTED, items IN_TRADE", (await tradeRow(t2)).status === "ACCEPTED" &&
    (await itemStatus(L2.id)) === "IN_TRADE" && (await itemStatus(I2.id)) === "IN_TRADE")
  await sleep(1000) // the accept's quest rows, before the baseline
  const cancelStart = new Date()
  const cancelBal = await balance(B.id)
  const cx = await call("PATCH", `/api/trades/${t2}`, A.d1.accessToken, { action: "cancel" })
  check("A cancels: 200 { ok: true }, no error", cx.status === 200 && cx.json.ok === true, brief(cx))
  check(`...releasedLeaves = ${fee}`, cx.json.releasedLeaves === fee, cx.json)
  check("...trade CANCELLED", (await tradeRow(t2)).status === "CANCELLED", await tradeRow(t2))
  check("...both items back to AVAILABLE", (await itemStatus(L2.id)) === "AVAILABLE" && (await itemStatus(I2.id)) === "AVAILABLE",
    `${await itemStatus(L2.id)} ${await itemStatus(I2.id)}`)
  const feeRows = (await tradeLedger(t2)).filter((r) => r.type.startsWith("BRIDGE_FEE"))
  check("...HOLD then RELEASE on B, net zero, never PAID",
    feeRows.length === 2 && feeRows[1].type === "BRIDGE_FEE_RELEASE" && feeRows[1].userId === B.id &&
    feeRows.reduce((s, r) => s + r.amount, 0) === 0, feeRows)
  {
    const now = await balance(B.id)
    const quests = await questRowsSince(B.id, cancelStart)
    check(`...B's balance rose by exactly the ${fee} refunded (+ ${quests} in quest rows)`,
      now === cancelBal + fee + quests && now === (await ledgerSum(B.id)), { before: cancelBal, now, quests })
  }
  // The cancel notification carries no entityId; B has had exactly one cancel.
  check("...TRADE_CANCELLED notification for B, none for A", (await notes(B.id, "TRADE_CANCELLED")) === 1 && (await notes(A.id, "TRADE_CANCELLED")) === 0)
  const again = await call("PATCH", `/api/trades/${t2}`, A.d1.accessToken, { action: "cancel" })
  check("a second cancel is refused (400) and refunds nothing", again.status === 400 &&
    (await tradeLedger(t2)).filter((r) => r.type === "BRIDGE_FEE_RELEASE").length === 1, brief(again))

  // ═══ 6 ═══
  head("6  decline, then withdraw")
  const L3 = await postListing(A, "listing3", 150, [H1])
  const I3 = await postListing(B, "item3", 160, [H1])
  const o3 = await call("POST", "/api/offers", B.d1.accessToken, { postId: L3.id, offeredItemId: I3.id })
  const t3 = o3.json.offerId as string | undefined
  check("third offer: 201", o3.status === 201 && !!t3, brief(o3))
  if (!t3) return
  const d3 = await call("PATCH", `/api/offers/${t3}`, A.d1.accessToken, { action: "decline" })
  check("A declines: 200, no error", d3.status === 200, brief(d3))
  check("...offer DECLINED", (await tradeRow(t3)).offerStatus === "DECLINED", await tradeRow(t3))
  check("...both items still AVAILABLE", (await itemStatus(L3.id)) === "AVAILABLE" && (await itemStatus(I3.id)) === "AVAILABLE")
  check("...one TRADE_REJECTED notification for B", (await notes(B.id, "TRADE_REJECTED")) === 1)

  const L4 = await postListing(A, "listing4", 150, [H1])
  const I4 = await postListing(B, "item4", 160, [H1])
  const o4 = await call("POST", "/api/offers", B.d1.accessToken, { postId: L4.id, offeredItemId: I4.id })
  const t4 = o4.json.offerId as string | undefined
  check("fourth offer: 201", o4.status === 201 && !!t4, brief(o4))
  if (!t4) return
  const w4 = await call("POST", `/api/v1/offers/${t4}/withdraw`, B.d1.accessToken, {})
  check("B withdraws: 200, no error", w4.status === 200, brief(w4))
  check("...offer WITHDRAWN", (await tradeRow(t4)).offerStatus === "WITHDRAWN", await tradeRow(t4))
  check("...both items still AVAILABLE", (await itemStatus(L4.id)) === "AVAILABLE" && (await itemStatus(I4.id)) === "AVAILABLE")
  const w4b = await call("POST", `/api/v1/offers/${t4}/withdraw`, B.d1.accessToken, {})
  check("a second withdraw is refused (4xx), not a 500", w4b.status >= 400 && w4b.status < 500, brief(w4b))

  // ═══ 7 ═══
  head("7  one decision card per side, per decided offer")
  type Row = { id: string; senderId: string; receiverId: string; content: string }
  const thread = async (me: Person, partner: Person) => {
    const r = await call("GET", `/api/messages?partnerId=${partner.id}`, me.d1.accessToken)
    return { r, rows: (Array.isArray(r.json) ? r.json : []) as Row[] }
  }
  const thA = await thread(A, B)
  const thB = await thread(B, A)
  check("GET thread -> 200 for both sides", thA.r.status === 200 && thB.r.status === 200, `${thA.r.status} ${thB.r.status}`)
  const decisionsIn = (rows: Row[], offerId: string) =>
    rows.filter((m) => m.content.includes('"offer_update"') && m.content.includes(`"offerId":"${offerId}"`))
  for (const [label, id] of [["accepted #1", t1], ["accepted #2 (later cancelled)", t2], ["declined #3", t3]] as const) {
    const shownA = decisionsIn(collapseSystemPairs(thA.rows, B.id), id)
    const shownB = decisionsIn(collapseSystemPairs(thB.rows, A.id), id)
    check(`${label}: server sends both rows; A's phone shows ONE, B's phone shows ONE`,
      decisionsIn(thA.rows, id).length === 2 && shownA.length === 1 && shownB.length === 1,
      { raw: decisionsIn(thA.rows, id).length, a: shownA.length, b: shownB.length })
  }
  const doneA = collapseSystemPairs(thA.rows, B.id).filter((m) => m.content.includes('"trade_completed"'))
  const doneB = collapseSystemPairs(thB.rows, A.id).filter((m) => m.content.includes('"trade_completed"'))
  check("the completion card: ONE on each phone", doneA.length === 1 && doneB.length === 1, { a: doneA.length, b: doneB.length })

  // ═══ 8 ═══
  head("8  messages back and forth: one row per send")
  const pairWhere = { OR: [{ senderId: A.id, receiverId: B.id }, { senderId: B.id, receiverId: A.id }] }
  const sent: string[] = []
  let perSendOk = true
  for (let i = 0; i < 6; i++) {
    const [from, to] = i % 2 === 0 ? [A, B] : [B, A]
    const content = `${P}msg-${i}-${from === A ? "a" : "b"}`
    const before = await prisma.message.count({ where: pairWhere })
    const r = await call("POST", "/api/messages", from.d1.accessToken, { receiverId: to.id, content })
    const after = await prisma.message.count({ where: pairWhere })
    const one = r.status === 201 && r.json.content === content && after === before + 1
    if (!one) perSendOk = false
    check(`send ${i + 1} (${from === A ? "A->B" : "B->A"}): 201, body echoes it, exactly one row`, one, `${brief(r)} rows ${before}->${after}`)
    sent.push(content)
  }
  const rowsInDb = await prisma.message.findMany({ where: { content: { in: sent } }, select: { content: true } })
  check("each text is in the database exactly once", perSendOk && rowsInDb.length === sent.length &&
    new Set(rowsInDb.map((r) => r.content)).size === sent.length, rowsInDb.length)
  const vA = (await thread(A, B)).rows.filter((m) => sent.includes(m.content))
  const vB = (await thread(B, A)).rows.filter((m) => sent.includes(m.content))
  check("A's thread shows all six, once each", vA.length === 6 && new Set(vA.map((m) => m.id)).size === 6, vA.length)
  check("B's thread shows all six, once each", vB.length === 6 && new Set(vB.map((m) => m.id)).size === 6, vB.length)
  check("one NEW_MESSAGE notification per receiver (unread ones collapse into one)",
    (await prisma.notification.count({ where: { userId: A.id, type: "NEW_MESSAGE", read: false } })) === 1 &&
    (await prisma.notification.count({ where: { userId: B.id, type: "NEW_MESSAGE", read: false } })) === 1)

  // ═══ 9 ═══
  head("9  B on a second device, signed out from the first")
  const l2 = await login(B.email)
  check("B signs in on device 2: 200", l2.status === 200 && typeof l2.json.accessToken === "string", brief(l2))
  if (l2.status !== 200) return
  const d2: Device = { accessToken: l2.json.accessToken, refreshToken: l2.json.refreshToken, userId: B.id }
  const fam1 = await familyOf(B.d1.refreshToken)
  const fam2 = await familyOf(d2.refreshToken)
  check("...a second, separate family", !!fam2 && fam2 !== fam1, { fam1, fam2 })
  const list1 = await call("GET", "/api/v1/sessions", B.d1.accessToken)
  const sess = (list1.json.data?.sessions ?? []) as { id: string; isCurrent: boolean }[]
  check("device 1's list shows both, itself current",
    list1.status === 200 && sess.length === 2 && sess.some((s) => s.id === fam2 && !s.isCurrent) && sess.some((s) => s.id === fam1 && s.isCurrent), brief(list1))
  check("device 2 works before the sign-out", (await call("GET", "/api/v1/sessions", d2.accessToken)).status === 200)
  const del = await call("DELETE", `/api/v1/sessions/${encodeURIComponent(fam2 ?? "")}`, B.d1.accessToken)
  check("device 1 signs device 2 out: 200", del.status === 200, brief(del))
  check("...device 2's family revoked in the database",
    (await prisma.authToken.count({ where: { familyId: fam2 ?? "", revokedAt: null } })) === 0)
  check("...device 2's access token is refused at once (401)", (await call("GET", "/api/v1/sessions", d2.accessToken)).status === 401)
  check("...device 2's refresh token is dead (401)", (await call("POST", "/api/auth/refresh", null, { refreshToken: d2.refreshToken })).status === 401)
  const list2 = await call("GET", "/api/v1/sessions", B.d1.accessToken)
  check("device 1 still signed in, and lists only itself", list2.status === 200 && (list2.json.data?.sessions ?? []).length === 1, brief(list2))

  // ═══ 10 ═══
  head("10  the books")
  await sleep(1000)
  for (const p of [A, B]) {
    check(`${p.name.slice(P.length)}: balance equals the sum of their ledger rows`, (await balance(p.id)) === (await ledgerSum(p.id)),
      { balance: await balance(p.id), ledger: await ledgerSum(p.id) })
  }
  const invEnd = await ledgerInvariant(prisma)
  check("ledger invariant at the end", invEnd.ok, invEnd.lines.filter((l) => l.includes("BROKEN")).join(" | "))

  // ═══ 11 ═══
  if (MODE === "real" && sockA && sockB) {
    head("11  realtime reached both sockets (real Pusher)")
    await sleep(3000)
    const evs = (h: Heard[]) => h.map((e) => e.event)
    const count = (h: Heard[], e: string) => h.filter((x) => x.event === e).length
    check("B heard offer-updated (the accepts and the decline)", count(sockB.heard, "offer-updated") >= 3, evs(sockB.heard))
    check("A heard new-message for each offer card", count(sockA.heard, "new-message") >= 4, evs(sockA.heard))
    check("both heard trade-status-changed on completion", count(sockA.heard, "trade-status-changed") >= 1 && count(sockB.heard, "trade-status-changed") >= 1,
      { a: evs(sockA.heard), b: evs(sockB.heard) })
    check("B heard meetup-changed for A's suggestion and agreement", count(sockB.heard, "meetup-changed") >= 2, evs(sockB.heard))
    check("each side heard the chat messages sent TO it (3 each)",
      sockA.heard.filter((e) => e.event === "new-message" && JSON.stringify(e.data).includes(`${P}msg-`)).length === 3 &&
      sockB.heard.filter((e) => e.event === "new-message" && JSON.stringify(e.data).includes(`${P}msg-`)).length === 3,
      { a: evs(sockA.heard), b: evs(sockB.heard) })
    sockA.close()
    sockB.close()
  }
}

main()
  .catch((e) => { console.error(e); fail++ })
  .finally(async () => {
    await prisma.$disconnect()
    console.log(`\n  ${pass} passed, ${fail} failed   (pusher ${MODE}, run ${RUN})`)
    process.exit(fail === 0 && pass > 0 ? 0 : 1)
  })
