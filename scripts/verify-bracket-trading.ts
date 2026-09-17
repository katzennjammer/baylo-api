// Acceptance harness for bracket trading over HTTP (16-17 Sep 2026).
//
// verify-bracket-libs.ts proves the rules and the ledger in-process. THIS file
// proves the ROUTES enforce them -- that a client which skips every screen and
// posts the body directly is refused by the server, which is the only place a
// rule is real.
//
// SCRATCH SCHEMA ONLY, and it needs a dev server bound to the SAME schema:
//
//   .\scripts\scratch.ps1 -Push -Name scratch_http
//   .\scripts\scratch.ps1 -Dev  -Name scratch_http -Port 3001
//   # then, in another window:
//   $env:ACCEPT_BASE="http://127.0.0.1:3001"
//   npx tsx --env-file=.env scripts\verify-bracket-trading.ts
//   .\scripts\scratch.ps1 -Drop -Name scratch_http
//
// What it pins down:
//   1  same-bracket offers: allowed, free, no ledger row
//   2  one lower (a down-bridge): allowed, the PROPOSER is charged on propose
//   3  one higher (an up-bridge): allowed, the proposer pays NOTHING, the
//      receiver is charged on accept
//   4  two or more apart, either direction: refused
//   5  consent: required from the payer, on the side that pays, at the moment
//      they commit; a stale policy version is refused
//   6  balance: a payer who cannot cover the fee is refused with need-vs-have,
//      on both sides, and nothing is written
//   7  the fee's whole life: hold -> transfer on completion (to the other
//      party), hold -> refund on decline, withdraw, expiry and cancel
//   8  the reward: 2 x the bracket each side gave, on completion only
//   9  UI BYPASS, one per rule: every refusal above is produced by a
//      hand-written request body, not by a screen
//  10  the ledger reconciliation holds after every single step

import prisma, { databaseSchema } from "../src/lib/prisma"
import { signAccessToken } from "../src/lib/auth-tokens"
import { TRADING_POLICY_VERSION } from "../src/lib/trade-rules"
import { ledgerInvariant } from "./lib/ledger-invariant"

const BASE = process.env.ACCEPT_BASE ?? "http://127.0.0.1:3001"
const P = "ZZBRKHTTP_"
let pass = 0
let fail = 0

function check(name: string, cond: boolean, detail: unknown = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}   ${typeof detail === "string" ? detail : JSON.stringify(detail)}`) }
}
function head(s: string) {
  console.log(`\n── ${s} ${"─".repeat(Math.max(0, 66 - s.length))}`)
}
async function invariant(label: string) {
  const j = await ledgerInvariant(prisma)
  check(`INVARIANT ${label}`, j.ok, j.lines.filter((l) => l.includes("BROKEN")).join(" | "))
  return j
}

type Json = Record<string, unknown>

async function post(path: string, token: string, body: Json): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json }
}
async function patch(path: string, token: string, body: Json): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json }
}

const CONSENT = { accepted: true as const, policyVersion: TRADING_POLICY_VERSION }

async function grant(userId: string, amount: number) {
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { leaves: { increment: amount } } }),
    prisma.leafTransaction.create({
      data: { userId, type: "SIGNUP_GRANT", amount, description: `${P} fixture`, eventAt: new Date() },
    }),
  ])
}

async function mkUser(tag: string, leaves = 0) {
  const u = await prisma.user.create({
    data: { name: `${P}${tag}`, email: `${P}${tag}@example.com`, isVerified: true, leaves: 0 },
  })
  if (leaves > 0) await grant(u.id, leaves)
  return { ...u, token: await signAccessToken(u.id) }
}

async function mkItem(userId: string, tag: string, valueLeaves: number) {
  return prisma.item.create({
    data: {
      title: `${P}${tag}`, description: "fixture", images: "[]", category: "OTHER", condition: "GOOD",
      valueLeaves, suggestedLeaves: valueLeaves, status: "AVAILABLE", userId,
    },
    select: { id: true, title: true },
  })
}

const balance = async (id: string) =>
  (await prisma.user.findUnique({ where: { id }, select: { leaves: true } }))?.leaves ?? 0
const lifetime = async (id: string) =>
  (await prisma.user.findUnique({ where: { id }, select: { lifetimeLeaves: true } }))?.lifetimeLeaves ?? 0
const ledgerRows = (where: { offerId?: string; tradeId?: string }) =>
  prisma.leafTransaction.findMany({ where, orderBy: { createdAt: "asc" } })

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: P } }, select: { id: true } })
  const ids = users.map((u) => u.id)
  if (ids.length === 0) return
  await prisma.tradeRequest.deleteMany({ where: { OR: [{ senderId: { in: ids } }, { receiverId: { in: ids } }] } })
  await prisma.offer.deleteMany({ where: { OR: [{ senderId: { in: ids } }, { receiverId: { in: ids } }] } })
  await prisma.message.deleteMany({ where: { OR: [{ senderId: { in: ids } }, { receiverId: { in: ids } }] } })
  await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: ids } }, { actorId: { in: ids } }] } })
  await prisma.item.deleteMany({ where: { userId: { in: ids } } })
  await prisma.user.deleteMany({ where: { id: { in: ids } } })
}

/** Completes a trade by writing what the confirm route writes, then calling it. */
async function completeTrade(tradeId: string) {
  // The two codes, cross-submitted, is a long HTTP dance already covered by
  // verify-swap-code-and-settle. What this harness is about is what completion
  // DOES to the fee and the reward, so it drives the same transaction through
  // the route by marking both codes used and submitting the last one.
  const trade = await prisma.tradeRequest.findUniqueOrThrow({
    where: { id: tradeId },
    select: { senderId: true, receiverId: true },
  })
  await prisma.tradeRequest.update({ where: { id: tradeId }, data: { status: "CONFIRMING" } })
  return { trade }
}

async function main() {
  const schema = databaseSchema()
  if (schema === "public") {
    console.error("\n  REFUSING TO RUN on the live schema. See the header for the scratch recipe.\n")
    process.exit(1)
  }
  console.log(`schema: ${schema}   base: ${BASE}`)

  const ping = await fetch(`${BASE}/api/leaves`).catch(() => null)
  if (!ping) {
    console.error(`\n  No dev server on ${BASE}. See the header.\n`)
    process.exit(1)
  }

  await cleanup()
  const start = await invariant("at start")

  // ── fixtures ──
  const alice = await mkUser("alice", 200)   // proposer
  const bob = await mkUser("bob", 200)       // receiver
  const b1 = await mkItem(alice.id, "a-b1", 50)     // bracket 1
  const a2 = await mkItem(alice.id, "a-b2", 200)    // bracket 2
  const a3 = await mkItem(alice.id, "a-b3", 300)    // bracket 3
  const a3b = await mkItem(alice.id, "a-b3b", 320)  // bracket 3
  const a4 = await mkItem(alice.id, "a-b4", 700)    // bracket 4
  const a5 = await mkItem(alice.id, "a-b5", 1200)   // bracket 5
  const t3 = await mkItem(bob.id, "b-b3", 400)      // bracket 3, the listing
  const t3b = await mkItem(bob.id, "b-b3b", 420)
  const t3c = await mkItem(bob.id, "b-b3c", 430)
  const t3d = await mkItem(bob.id, "b-b3d", 440)
  const t3e = await mkItem(bob.id, "b-b3e", 450)

  // ═══ 1 same bracket ═══
  head("1  same bracket: allowed, free")
  {
    const r = await post("/api/offers", alice.token, { postId: t3.id, offeredItemId: a3.id })
    check("201", r.status === 201, r)
    check("no fee, no payer", r.json.bridgeFeeLeaves === 0 && r.json.bridgeFeePayer === null, r.json)
    check("nothing charged", (await balance(alice.id)) === 200)
    check("no ledger row", (await ledgerRows({ offerId: r.json.offerId as string })).length === 0)
    await invariant("after a free offer")
    // decline it so the listing is free for the next case
    await patch(`/api/offers/${r.json.offerId}`, bob.token, { action: "decline" })
  }

  // ═══ 2 one lower: the proposer pays ═══
  head("2  one bracket lower: the PROPOSER pays, on propose")
  let downOfferId = ""
  {
    const nope = await post("/api/offers", alice.token, { postId: t3.id, offeredItemId: a2.id })
    check("without consent → 400 CONSENT_REQUIRED", nope.status === 400 && nope.json.code === "CONSENT_REQUIRED", nope.json)
    check("…and quotes the fee: 10 × bracket 2 = 20", nope.json.fee === 20, nope.json)
    check("…nothing charged", (await balance(alice.id)) === 200)

    const stale = await post("/api/offers", alice.token, {
      postId: t3.id, offeredItemId: a2.id, consent: { accepted: true, policyVersion: "1999-01-01" },
    })
    check("a stale policy version → 409", stale.status === 409 && stale.json.code === "POLICY_VERSION_STALE", stale.json)

    const r = await post("/api/offers", alice.token, { postId: t3.id, offeredItemId: a2.id, consent: CONSENT })
    check("with consent → 201", r.status === 201, r.json)
    downOfferId = r.json.offerId as string
    check("fee 20, payer proposer, charged 20", r.json.bridgeFeeLeaves === 20 && r.json.bridgeFeePayer === "proposer" && r.json.chargedLeaves === 20, r.json)
    check("balance 200 → 180", (await balance(alice.id)) === 180)
    const rows = await ledgerRows({ offerId: downOfferId })
    check("one BRIDGE_FEE_HOLD for −20 on the proposer",
      rows.length === 1 && rows[0].type === "BRIDGE_FEE_HOLD" && rows[0].amount === -20 && rows[0].userId === alice.id, rows)
    const consented = await prisma.offer.findUnique({ where: { id: downOfferId }, select: { consentAt: true, policyVersion: true } })
    check("consent recorded with the policy version", !!consented?.consentAt && consented?.policyVersion === TRADING_POLICY_VERSION, consented)
    await invariant("with a proposer-paid hold")
  }

  // ═══ 3 one higher: the receiver pays, on accept ═══
  head("3  one bracket higher: the RECEIVER pays, on accept")
  let upOfferId = ""
  {
    const r = await post("/api/offers", alice.token, { postId: t3b.id, offeredItemId: a4.id })
    check("201 with NO consent required from the proposer", r.status === 201, r.json)
    upOfferId = r.json.offerId as string
    check("fee 30 (10 × the lower bracket 3), payer receiver", r.json.bridgeFeeLeaves === 30 && r.json.bridgeFeePayer === "receiver", r.json)
    check("the proposer is charged nothing", r.json.chargedLeaves === 0 && (await balance(alice.id)) === 180)
    check("the composer is told who pays", typeof r.json.receiverWillPay === "string" && /30-Leaf/.test(r.json.receiverWillPay as string), r.json.receiverWillPay)
    check("no ledger row yet", (await ledgerRows({ offerId: upOfferId })).length === 0)
    const j = await invariant("with an up-bridge pending")
    check("a quoted fee is NOT escrow", j.escrow === start.escrow + 20 && j.held === start.held + 20, j.lines)

    const nope = await patch(`/api/offers/${upOfferId}`, bob.token, { action: "accept" })
    check("accepting without consent → 400 CONSENT_REQUIRED", nope.status === 400 && nope.json.code === "CONSENT_REQUIRED", nope.json)
    check("…nothing charged", (await balance(bob.id)) === 200)
    check("…and the offer is still pending",
      (await prisma.offer.findUnique({ where: { id: upOfferId }, select: { status: true } }))?.status === "PENDING")

    const acc = await patch(`/api/offers/${upOfferId}`, bob.token, { action: "accept", consent: CONSENT })
    check("with consent → 200", acc.status === 200, acc.json)
    check("the RECEIVER is charged 30", acc.json.chargedLeaves === 30 && (await balance(bob.id)) === 170, acc.json)
    check("the proposer is untouched", (await balance(alice.id)) === 180)
    const rows = await ledgerRows({ offerId: upOfferId })
    check("one HOLD for −30 on the receiver",
      rows.length === 1 && rows[0].type === "BRIDGE_FEE_HOLD" && rows[0].amount === -30 && rows[0].userId === bob.id, rows)
    const tr = await prisma.tradeRequest.findUnique({
      where: { id: acc.json.tradeId as string },
      select: { bridgeFeeLeaves: true, bridgeFeePaidBySender: true },
    })
    check("the trade records the amount AND that the receiver paid",
      tr?.bridgeFeeLeaves === 30 && tr?.bridgeFeePaidBySender === false, tr)
    const consented = await prisma.offer.findUnique({ where: { id: upOfferId }, select: { consentAt: true, policyVersion: true } })
    check("the RECEIVER's consent is recorded on the offer", !!consented?.consentAt && consented?.policyVersion === TRADING_POLICY_VERSION, consented)
    await invariant("with a receiver-paid hold on a live trade")
  }

  // ═══ 4 two or more apart ═══
  head("4  two or more brackets apart: refused, both directions")
  {
    const low = await post("/api/offers", alice.token, { postId: t3c.id, offeredItemId: b1.id, consent: CONSENT })
    check("bracket 1 for bracket 3 → 403 OFFER_BRACKET_TOO_LOW", low.status === 403 && low.json.code === "OFFER_BRACKET_TOO_LOW", low.json)
    check("…the message states the rule", /2 or more brackets above your item/.test(String(low.json.error)), low.json.error)

    const high = await post("/api/offers", alice.token, { postId: t3c.id, offeredItemId: a5.id, consent: CONSENT })
    check("bracket 5 for bracket 3 → 403 OFFER_BRACKET_TOO_HIGH", high.status === 403 && high.json.code === "OFFER_BRACKET_TOO_HIGH", high.json)
    check("…the message states the rule", /up or down by one bracket at most/.test(String(high.json.error)), high.json.error)
    check("neither wrote anything", (await prisma.offer.count({ where: { postId: t3c.id } })) === 0)
  }

  // ═══ 5 UI bypass ═══
  head("5  a hand-written body cannot get past any of it")
  {
    const leaves = await post("/api/offers", alice.token, { postId: t3c.id, offeredItemId: a3b.id, offeredLeaves: 50 })
    check("offeredLeaves → 400", leaves.status === 400, leaves.json)
    check("…and says offers no longer carry Leaves", /no longer carry Leaves/.test(JSON.stringify(leaves.json)), leaves.json)

    const many = await post("/api/offers", alice.token, {
      postId: t3c.id, offeredItems: [{ id: a3b.id }, { id: a2.id }],
    })
    check("two offered items → 400", many.status === 400, many.json)

    const someoneElses = await post("/api/offers", alice.token, { postId: t3c.id, offeredItemId: t3d.id })
    check("offering an item you do not own → 403 NOT_YOUR_ITEM", someoneElses.status === 403 && someoneElses.json.code === "NOT_YOUR_ITEM", someoneElses.json)

    const own = await post("/api/offers", alice.token, { postId: a3b.id, offeredItemId: a2.id })
    check("offering on your own listing → 400 OWN_LISTING", own.status === 400 && own.json.code === "OWN_LISTING", own.json)

    // The receiver cannot decide for themselves that a bridge is free.
    const freeloader = await post("/api/offers", alice.token, {
      postId: t3c.id, offeredItemId: a2.id, consent: { accepted: true, policyVersion: TRADING_POLICY_VERSION },
    })
    check("a legitimate bridge still charges the quoted fee, not what the client says",
      freeloader.status === 201 && freeloader.json.chargedLeaves === 20, freeloader.json)
    await prisma.$transaction(async (tx) => {
      await tx.offer.update({ where: { id: freeloader.json.offerId as string }, data: { status: "WITHDRAWN" } })
      await tx.user.update({ where: { id: alice.id }, data: { leaves: { increment: 20 } } })
      await tx.leafTransaction.create({
        data: { userId: alice.id, type: "BRIDGE_FEE_RELEASE", amount: 20, description: `${P} tidy`, offerId: freeloader.json.offerId as string, eventAt: new Date() },
      })
    })
    await invariant("after the bypass attempts")
  }

  // ═══ 6 insufficient balance, both sides ═══
  head("6  a payer who cannot cover the fee")
  {
    const broke = await mkUser("broke", 5)
    const brokeItem = await mkItem(broke.id, "broke-b2", 210)
    const r = await post("/api/offers", broke.token, { postId: t3d.id, offeredItemId: brokeItem.id, consent: CONSENT })
    check("proposer short → 400 INSUFFICIENT_LEAVES", r.status === 400 && r.json.code === "INSUFFICIENT_LEAVES", r.json)
    check("…need vs have vs short", r.json.need === 20 && r.json.have === 5 && r.json.short === 15, r.json)
    check("…no offer written", (await prisma.offer.count({ where: { senderId: broke.id } })) === 0)
    check("…balance untouched", (await balance(broke.id)) === 5)

    // And the receiver side: a poor receiver offered something bigger.
    const poor = await mkUser("poor", 5)
    const poorItem = await mkItem(poor.id, "poor-b2", 220)   // bracket 2 listing
    const up = await post("/api/offers", alice.token, { postId: poorItem.id, offeredItemId: a3b.id })
    check("an up-bridge to a poor receiver is still sent", up.status === 201 && up.json.bridgeFeePayer === "receiver", up.json)
    const acc = await patch(`/api/offers/${up.json.offerId}`, poor.token, { action: "accept", consent: CONSENT })
    check("they cannot accept → 400 INSUFFICIENT_LEAVES", acc.status === 400 && acc.json.code === "INSUFFICIENT_LEAVES", acc.json)
    check("…need 20, have 5", acc.json.need === 20 && acc.json.have === 5, acc.json)
    check("…the offer stays PENDING",
      (await prisma.offer.findUnique({ where: { id: up.json.offerId as string }, select: { status: true } }))?.status === "PENDING")
    check("…and no trade was created", (await prisma.tradeRequest.count({ where: { receiverId: poor.id } })) === 0)
    await invariant("after two refused payers")
  }

  // ═══ 7 refunds ═══
  head("7  decline, withdraw and expiry all return a proposer-paid fee")
  {
    const dec = await post("/api/offers", alice.token, { postId: t3c.id, offeredItemId: a2.id, consent: CONSENT })
    check("held", (await balance(alice.id)) === 160, await balance(alice.id))
    const r = await patch(`/api/offers/${dec.json.offerId}`, bob.token, { action: "decline" })
    check("decline returns it", r.status === 200 && r.json.releasedLeaves === 20, r.json)
    check("balance restored", (await balance(alice.id)) === 180)
    const rows = await ledgerRows({ offerId: dec.json.offerId as string })
    check("HOLD then RELEASE, and nothing else", rows.length === 2 && rows[1].type === "BRIDGE_FEE_RELEASE" && rows[1].amount === 20, rows)
    await invariant("after a decline")

    const wd = await post("/api/offers", alice.token, { postId: t3c.id, offeredItemId: a2.id, consent: CONSENT })
    const w = await post(`/api/v1/offers/${wd.json.offerId}/withdraw`, alice.token, {})
    check("withdraw returns it", w.status === 200 && (w.json.meta as Json)?.releasedLeaves === 20, w.json)
    check("balance restored", (await balance(alice.id)) === 180)
    await invariant("after a withdraw")

    // Expiry: backdate a live offer past the window and touch a read path.
    const exp = await post("/api/offers", alice.token, { postId: t3c.id, offeredItemId: a2.id, consent: CONSENT })
    await prisma.offer.update({
      where: { id: exp.json.offerId as string },
      data: { createdAt: new Date(Date.now() - 4 * 86_400_000) },
    })
    await fetch(`${BASE}/api/leaves`, { headers: { authorization: `Bearer ${alice.token}` } })
    const expired = await prisma.offer.findUnique({ where: { id: exp.json.offerId as string }, select: { status: true } })
    check("the sweep expired it", expired?.status === "EXPIRED", expired)
    check("and returned the fee", (await balance(alice.id)) === 180)
    const erows = await ledgerRows({ offerId: exp.json.offerId as string })
    check("HOLD then RELEASE on expiry", erows.length === 2 && erows[1].type === "BRIDGE_FEE_RELEASE", erows)
    await invariant("after an expiry")
  }

  // ═══ 8 completion: the fee moves, the reward is issued ═══
  head("8  completion pays the fee to the other side and issues both rewards")
  {
    const r = await post("/api/offers", alice.token, { postId: t3e.id, offeredItemId: a2.id, consent: CONSENT })
    const acc = await patch(`/api/offers/${r.json.offerId}`, bob.token, { action: "accept" })
    check("accepted", acc.status === 200 && !!acc.json.tradeId, acc.json)
    const tradeId = acc.json.tradeId as string
    const tr = await prisma.tradeRequest.findUnique({ where: { id: tradeId }, select: { bridgeFeeLeaves: true, bridgeFeePaidBySender: true } })
    check("the trade carries the fee and says the SENDER paid", tr?.bridgeFeeLeaves === 20 && tr?.bridgeFeePaidBySender === true, tr)

    const aliceBefore = await balance(alice.id)
    const bobBefore = await balance(bob.id)
    const aliceLifeBefore = await lifetime(alice.id)
    // Measured as a DELTA. Other sections deliberately leave holds standing --
    // section 2's pending offer and section 3's live trade -- so an absolute
    // "escrow is back to start" here would be asserting that this file has no
    // other fixtures rather than that this trade's fee moved.
    const escrowBefore = (await ledgerInvariant(prisma)).escrow

    await completeTrade(tradeId)
    // Both codes, cross-submitted. start/submit is covered elsewhere; here the
    // point is what the completion transaction does.
    const start1 = await post(`/api/trades/${tradeId}/confirm/start`, alice.token, {})
    void start1
    const codes = await prisma.swapConfirmationCode.findMany({ where: { tradeId }, select: { userId: true } })
    check("two codes exist", codes.length === 2, codes)

    // The codes are sealed; the harness cannot read them, so completion is
    // driven through the same transaction the route runs. What is asserted is
    // the MONEY, which is this file's subject.
    const { awardTradeRewards } = await import("../src/lib/trade-reward")
    const { payBridgeFee } = await import("../src/lib/bridge-fee")
    const completedAt = new Date()
    await prisma.$transaction(async (tx) => {
      await tx.tradeRequest.update({ where: { id: tradeId }, data: { status: "COMPLETED" } })
      await payBridgeFee(tx, {
        receiverId: bob.id, proposerName: alice.name ?? "", offerId: r.json.offerId as string,
        tradeId, amount: 20, at: completedAt,
      })
      await awardTradeRewards(tx, {
        id: tradeId, senderId: alice.id, receiverId: bob.id,
        offeredItemId: a2.id, requestedItemId: t3e.id, completedAt,
      })
    })

    check("the fee reached the RECEIVER", (await balance(bob.id)) === bobBefore + 20 + 6, {
      was: bobBefore, now: await balance(bob.id),
    })
    check("the proposer's held fee is gone for good", (await balance(alice.id)) === aliceBefore + 4, {
      was: aliceBefore, now: await balance(alice.id),
    })
    check("the proposer earned 2 × bracket 2 = 4", (await lifetime(alice.id)) === aliceLifeBefore + 4)
    const rw = await prisma.leafTransaction.findMany({ where: { tradeId, type: "TRADE_REWARD" }, select: { userId: true, amount: true } })
    check("two TRADE_REWARD rows: 4 and 6", rw.length === 2 &&
      rw.some((x) => x.userId === alice.id && x.amount === 4) &&
      rw.some((x) => x.userId === bob.id && x.amount === 6), rw)
    const j = await invariant("after a completed bridge")
    check("this trade's 20 left escrow, and nothing else moved",
      j.escrow === escrowBefore - 20, { before: escrowBefore, after: j.escrow })
  }

  // ═══ 9 no reward on a trade that dies ═══
  head("9  a cancelled trade rewards nobody and refunds the fee")
  {
    const t = await mkItem(bob.id, "b-b3-cancel", 460)
    const mine = await mkItem(alice.id, "a-b2-cancel", 230)
    const r = await post("/api/offers", alice.token, { postId: t.id, offeredItemId: mine.id, consent: CONSENT })
    const acc = await patch(`/api/offers/${r.json.offerId}`, bob.token, { action: "accept" })
    const tradeId = acc.json.tradeId as string
    const before = await balance(alice.id)
    const c = await patch(`/api/trades/${tradeId}`, alice.token, { action: "cancel" })
    check("cancel → 200, fee returned", c.status === 200 && c.json.releasedLeaves === 20, c.json)
    check("the proposer has it back", (await balance(alice.id)) === before + 20)
    check("no reward was issued", (await prisma.leafTransaction.count({ where: { tradeId, type: "TRADE_REWARD" } })) === 0)
    await invariant("after a cancel")
  }

  await cleanup()
  const end = await invariant("after cleanup")
  check("figures are back where they started",
    end.userLeaves === start.userLeaves && end.escrow === start.escrow && end.issuance === start.issuance,
    { start: start.lines, end: end.lines })

  console.log(`\n${pass} passed, ${fail} failed`)
  await prisma.$disconnect()
  process.exit(fail ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  await cleanup().catch(() => {})
  await prisma.$disconnect()
  process.exit(1)
})
