/**
 * Staff accept an offer AS A SHOP: one status row per view, and the update
 * arrives over the socket, not after reloads. Over real HTTP and real Pusher.
 *
 * RUNS AGAINST A SCRATCH SCHEMA, with a server on the same schema:
 *   .\scripts\scratch.ps1 -Push -Name scratch_rt
 *   $env:DATABASE_URL="${base}?schema=scratch_rt"; npx next build; npx next start -p 3100
 *   $env:BAYLO_BASE_URL="http://127.0.0.1:3100"
 *   .\scripts\scratch.ps1 -Run scripts\verify-offer-accept-realtime-http.ts -Name scratch_rt -Keep
 *
 * ── WHAT THIS PINS DOWN (27 Sep 2026) ───────────────────────────────────────
 *
 * A real device showed "You accepted Mary's offer" twice after a staff member
 * accepted as the shop, and the accept needed several reloads to show. The
 * causes, both measured on live data first:
 *
 *   DUPLICATE  PATCH /api/offers/[id] writes an offer_update row to EACH side
 *              (since 8ed951c, 20 Sep) -- two rows in one thread, drawn twice.
 *              The fix is baylo-mobile/src/lib/system-pairs.ts, imported here
 *              and run over the thread exactly as the phone receives it, for
 *              the shop's view AND the person's.
 *   REALTIME   the phone had no EXPO_PUBLIC_PUSHER_KEY, and the app-wide trade
 *              listener held only the person's channel. Here a pusher-js
 *              client authorises through /api/pusher/auth with each member's
 *              own token and must receive the accept's events on the SHOP's
 *              channel, owner and staff alike.
 *
 *   1  channel auth: staff (ACTIVE) and owner 200 on the shop channel; a
 *      PENDING member and a stranger 403.
 *   2  staff accept as the shop; offer-updated + new-message reach the shop
 *      channel for BOTH subscribed members, and Mary's own channel, within 5s.
 *      The shop-channel message's sender is Mary (the phone's onNewMessage
 *      only appends rows from the partner).
 *   3  the DB holds exactly two offer_update rows; the decider's copy (to the
 *      shop) is written read, Mary's is unread.
 *   4  the thread as the shop and as Mary: two rows from the server, ONE after
 *      collapseSystemPairs, and it is the copy addressed to that inbox.
 *
 * Fixture ids are scratch-only, so the Pusher channels this publishes to are
 * named after rows no real device holds.
 */
import Pusher from "pusher-js"
import prisma from "../src/lib/prisma"
import { createOrganization } from "../src/lib/organizations"
import { signAccessToken } from "../src/lib/auth-tokens"
import { requireScratchSchema } from "./lib/live-guard"
import { collapseSystemPairs } from "../../baylo-mobile/src/lib/system-pairs"

// pusher-js's node build is CommonJS with the constructor on `.Pusher`, the
// same shape baylo-mobile/src/api/pusher.ts unwraps for Metro.
const PusherCtor = (Pusher as unknown as { Pusher?: typeof Pusher }).Pusher ?? Pusher

const BASE = process.env.BAYLO_BASE_URL ?? "http://127.0.0.1:3100"
const KEY = process.env.NEXT_PUBLIC_PUSHER_KEY!
const CLUSTER = process.env.NEXT_PUBLIC_PUSHER_CLUSTER!

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `   ${detail}` : ""}`) }
}
const head = (s: string) => console.log(`\n── ${s}`)

type Called = { status: number; body: unknown }
async function call(path: string, opts: { token: string; orgId?: string; method?: string; body?: unknown }): Promise<Called> {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
      ...(opts.orgId ? { "X-Baylo-Org": opts.orgId } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}
const brief = (c: Called) => `status ${c.status} ${JSON.stringify(c.body).slice(0, 220)}`

type Heard = { event: string; data: Record<string, unknown>; at: number }

/** A socket authorised the way the phone's is: the member's own bearer token, JSON body. */
function listen(token: string, channelName: string) {
  const client = new PusherCtor(KEY, {
    cluster: CLUSTER,
    channelAuthorization: {
      transport: "ajax",
      endpoint: `${BASE}/api/pusher/auth`,
      headers: { Authorization: `Bearer ${token}` },
    },
  })
  const heard: Heard[] = []
  const channel = client.subscribe(channelName)
  const ready = new Promise<boolean>((resolve) => {
    channel.bind("pusher:subscription_succeeded", () => resolve(true))
    channel.bind("pusher:subscription_error", () => resolve(false))
    setTimeout(() => resolve(false), 15_000)
  })
  channel.bind_global((event: string, data: Record<string, unknown>) => {
    if (!event.startsWith("pusher:")) heard.push({ event, data, at: Date.now() })
  })
  return { client, heard, ready }
}
async function waitFor(heard: Heard[], events: string[], ms: number) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (events.every((e) => heard.some((h) => h.event === e))) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

async function main() {
  requireScratchSchema("scripts/verify-offer-accept-realtime-http.ts")
  if (!KEY || !CLUSTER) throw new Error("NEXT_PUBLIC_PUSHER_KEY / _CLUSTER missing from .env")
  try { await fetch(`${BASE}/api/v1/hubs`) } catch { console.error(`No server at ${BASE}.`); process.exit(2) }

  const tag = `verify-accept-rt-${Date.now()}`
  const person = async (name: string) => {
    const u = await prisma.user.create({
      data: { name: name === "mary" ? "Mary" : `${tag}-${name}`, email: `${tag}-${name}@test.invalid`, isVerified: true, idVerifiedGrandfatheredAt: new Date() },
      select: { id: true },
    })
    return { id: u.id, token: await signAccessToken(u.id) }
  }
  const item = (userId: string, title: string) =>
    prisma.item.create({
      data: { title: `${tag} ${title}`, description: "x", category: "OTHER", condition: "GOOD", valueLeaves: 200, userId },
      select: { id: true },
    })

  const owner = await person("owner")
  // Schema v2: organisation staff were removed. The OWNER is the only person
  // who acts as the shop, so the "staff" actor below IS the owner, and the
  // former PENDING invitee is simply a person who is not the owner.
  const staff = owner
  const pendingMember = await person("pending")
  const stranger = await person("stranger")
  const mary = await person("mary")
  const shop = await createOrganization({ founderUserId: owner.id, name: `${tag} Baylo`, businessCategory: "SARI_SARI" })
  await prisma.organization.update({ where: { id: shop.organizationId }, data: { verificationStatus: "VERIFIED" } })
  const shopChannel = `private-user-${shop.orgUserId}`

  head("1  channel auth for the shop's channel")
  const auth = (token: string) => call("/api/pusher/auth", { token, method: "POST", body: { socket_id: "1234.5678", channel_name: shopChannel } })
  const aStaff = await auth(staff.token)
  const aOwner = await auth(owner.token)
  const aPending = await auth(pendingMember.token)
  const aStranger = await auth(stranger.token)
  check("1: the acting person (the owner) authorised", aStaff.status === 200, brief(aStaff))
  check("1: owner authorised", aOwner.status === 200, brief(aOwner))
  check("1: a person who is not the owner refused", aPending.status === 403, brief(aPending))
  check("1: stranger refused", aStranger.status === 403, brief(aStranger))

  const staffSock = listen(staff.token, shopChannel)
  const ownerSock = listen(owner.token, shopChannel)
  const marySock = listen(mary.token, `private-user-${mary.id}`)
  const [sOk, oOk, mOk] = await Promise.all([staffSock.ready, ownerSock.ready, marySock.ready])
  check("1: staff's socket subscribed to the shop channel (real Pusher)", sOk)
  check("1: owner's socket subscribed to the shop channel", oOk)
  check("1: Mary's socket subscribed to her own channel", mOk)

  try {
    head("2  staff accept as the shop; the socket carries it")
    const maryItem = await item(mary.id, "Test")
    const shopItem = await item(shop.orgUserId, "Pizza")
    const offer = await call("/api/offers", { token: mary.token, method: "POST", body: { postId: shopItem.id, offeredItemId: maryItem.id } })
    check("2: Mary offers on the shop's listing", offer.status === 201, brief(offer))
    const offerId = String((offer.body as { offerId?: string }).offerId)
    await new Promise((r) => setTimeout(r, 1500))
    for (const s of [staffSock, ownerSock, marySock]) s.heard.length = 0

    const t0 = Date.now()
    const accepted = await call(`/api/offers/${offerId}`, { token: staff.token, orgId: shop.organizationId, method: "PATCH", body: { action: "accept" } })
    check("2: staff, acting as the shop, accept", accepted.status === 200, brief(accepted))
    const tradeId = String((accepted.body as { tradeId?: string }).tradeId)

    const want = ["offer-updated", "new-message"]
    const [sGot, oGot, mGot] = await Promise.all([
      waitFor(staffSock.heard, want, 5000), waitFor(ownerSock.heard, want, 5000), waitFor(marySock.heard, want, 5000),
    ])
    const lag = (h: Heard[]) => Math.max(...h.filter((x) => want.includes(x.event)).map((x) => x.at - t0))
    check("2: staff's socket heard offer-updated + new-message", sGot, JSON.stringify(staffSock.heard.map((h) => h.event)))
    check("2: owner's socket heard them too (no staff/owner gap)", oGot, JSON.stringify(ownerSock.heard.map((h) => h.event)))
    check("2: Mary's socket heard them", mGot, JSON.stringify(marySock.heard.map((h) => h.event)))
    console.log(`        latency after the accept response began: staff ${lag(staffSock.heard)}ms, owner ${lag(ownerSock.heard)}ms, Mary ${lag(marySock.heard)}ms`)
    const pushed = staffSock.heard.find((h) => h.event === "new-message")?.data
    check("2: the shop channel's new-message is FROM Mary (the thread appends partner rows)",
      pushed?.senderId === mary.id && pushed?.receiverId === shop.orgUserId, JSON.stringify(pushed))

    head("3  the rows")
    const rows = await prisma.message.findMany({
      where: { content: { contains: offerId }, AND: { content: { contains: "\"offer_update\"" } } },
      select: { id: true, senderId: true, receiverId: true, read: true, tradeId: true },
    })
    check("3: exactly two offer_update rows (one per side, by design)", rows.length === 2, JSON.stringify(rows))
    const toShop = rows.find((r) => r.receiverId === shop.orgUserId)
    const toMary = rows.find((r) => r.receiverId === mary.id)
    check("3: the decider's copy (to the shop) is written read", toShop?.read === true, JSON.stringify(toShop))
    check("3: Mary's copy is unread", toMary?.read === false, JSON.stringify(toMary))
    check("3: both carry the trade", rows.every((r) => r.tradeId === tradeId))

    head("4  the threads, collapsed exactly as the phone does")
    type Row = { id: string; senderId: string; receiverId: string; content: string }
    const isUpdate = (m: Row) => m.content.includes("\"offer_update\"")
    const shopThread = await call(`/api/messages?partnerId=${mary.id}`, { token: staff.token, orgId: shop.organizationId })
    const shopRows = (Array.isArray(shopThread.body) ? shopThread.body : []) as Row[]
    check("4: shop thread: the server returns both rows", shopRows.filter(isUpdate).length === 2, brief(shopThread))
    const shopShown = collapseSystemPairs(shopRows, mary.id).filter(isUpdate)
    check("4: shop thread: ONE status row after collapsing", shopShown.length === 1, JSON.stringify(shopShown))
    check("4: shop thread: it is the copy addressed to the SHOP", shopShown[0]?.receiverId === shop.orgUserId)
    const shopOther = shopRows.filter((m) => !isUpdate(m))
    check("4: shop thread: nothing else was dropped", collapseSystemPairs(shopRows, mary.id).length === shopOther.length + 1)

    const maryThread = await call(`/api/messages?partnerId=${shop.orgUserId}`, { token: mary.token })
    const maryRows = (Array.isArray(maryThread.body) ? maryThread.body : []) as Row[]
    const maryShown = collapseSystemPairs(maryRows, shop.orgUserId).filter(isUpdate)
    check("4: Mary's thread: ONE status row", maryShown.length === 1, JSON.stringify(maryShown))
    check("4: Mary's thread: it is the copy addressed to Mary", maryShown[0]?.receiverId === mary.id)

    const personal = await call(`/api/messages?partnerId=${mary.id}`, { token: staff.token })
    const personalRows = (Array.isArray(personal.body) ? personal.body : []) as Row[]
    check("4: staff WITHOUT the header see none of it (personal inbox)", personalRows.filter(isUpdate).length === 0, brief(personal))
  } finally {
    for (const s of [staffSock, ownerSock, marySock]) s.client.disconnect()
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  await prisma.$disconnect()
  process.exit(fail ? 1 : 0)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
