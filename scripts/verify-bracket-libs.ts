// Acceptance harness for the bracket-trading LIBRARIES (16 Sep 2026): the
// rules, the fee ledger, the reward ledger, the offer assessment and the value
// cap. The routes that call them are covered by verify-bracket-trading.ts.
//
// SCRATCH SCHEMA ONLY. It refuses to run against `public`. Every row it writes
// is under a ZZBRKLIB_ prefix and deleted at the end, and it keeps the ledger
// reconciliation true at every step and CHECKS that it does -- but a harness
// that creates users, trades and ledger rows does not belong on the live
// tables, prefix or no prefix. The one run on 16 Sep 2026 that did (before
// this guard existed) left nothing behind; that is not a licence.
//
//   .\scripts\scratch.ps1 -Run scripts\verify-bracket-libs.ts
//
// which pushes the schema to a fresh scratch_* schema, runs this with
// DATABASE_URL pointed there, and drops it. See scripts/scratch.ps1.
//
// What it pins down, in order:
//   1  offerLegality / feeForOffer over every bracket pair; bridgingFee is
//      10 x bracket for 1..9 and null for 10; tradeReward is 2 x bracket
//   2  valueCap / classifyValue: lower always ok, up to one bracket ok,
//      further is review, the top bracket has no ceiling
//   3  assessOffer(): same, bridge (with the fee), too low, higher, unvalued,
//      not yours, your own listing, not available, missing
//   4  the fee: hold debits and writes HOLD; a short balance refuses and
//      writes nothing; release credits and writes RELEASE once; pay credits
//      the receiver and writes PAID once; the three reconciliation checks
//      hold after every step, including with the fee on a live trade
//   5  the reward: 2 x bracket to each side, lifetimeLeaves moves, issuance
//      reconciles; placeholder and unvalued pay nothing; the pair, item and
//      daily-cap gates each deny; already_awarded on a replay; reversal
//      writes the negative rows once and moves lifetimeLeaves back
//   6  decideItemValue(): the four decisions, valueSetByUser, needsReview

import prisma, { databaseSchema } from "../src/lib/prisma"
import type { Prisma } from "../src/generated/prisma/client"
import { BRACKET_COUNT, bracketOf, bracketRange } from "../src/lib/brackets"
import {
  bridgingFee,
  classifyValue,
  feeForOffer,
  offerLegality,
  tradeReward,
  TRADE_REWARD_DAILY_CAP_LEAVES,
  TRADE_REWARD_PER_BRACKET,
  BRIDGE_FEE_PER_BRACKET,
  valueCap,
} from "../src/lib/trade-rules"
import { holdBridgeFee, payBridgeFee, releaseBridgeFee, heldBridgeFees } from "../src/lib/bridge-fee"
import { awardTradeRewards, reverseTradeRewards } from "../src/lib/trade-reward"
import { assessOffer } from "../src/lib/offer-check"
import { decideItemValue } from "../src/lib/valuation-server"
import { ledgerInvariant } from "./lib/ledger-invariant"

const P = "ZZBRKLIB_"
let pass = 0
let fail = 0

function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}   ${detail}`) }
}
function head(s: string) {
  console.log(`\n── ${s} ${"─".repeat(Math.max(0, 66 - s.length))}`)
}
async function invariant(label: string) {
  const j = await ledgerInvariant(prisma)
  check(`INVARIANT ${label}`, j.ok, j.lines.filter((l) => l.includes("BROKEN")).join(" | "))
  return j
}

/** Leaves into a fixture account the honest way: an issuance row. */
async function grant(userId: string, amount: number) {
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { leaves: { increment: amount } } }),
    prisma.leafTransaction.create({
      data: { userId, type: "SIGNUP_GRANT", amount, description: `${P} fixture grant`, eventAt: new Date() },
    }),
  ])
}

async function user(tag: string, leaves = 0) {
  const u = await prisma.user.create({
    data: { name: `${P}${tag}`, email: `${P}${tag}@example.com`, isVerified: true, leaves: 0 },
  })
  if (leaves > 0) await grant(u.id, leaves)
  return u
}

async function item(userId: string, title: string, valueLeaves: number | null, status: "AVAILABLE" | "IN_TRADE" = "AVAILABLE") {
  return prisma.item.create({
    data: {
      title: `${P}${title}`, description: "fixture", images: "[]", category: "OTHER", condition: "GOOD",
      valueLeaves, suggestedLeaves: valueLeaves, status, userId,
    },
    select: { id: true, title: true, valueLeaves: true },
  })
}

async function balance(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { leaves: true, lifetimeLeaves: true } })
  return { leaves: u?.leaves ?? 0, lifetime: u?.lifetimeLeaves ?? 0 }
}

async function rows(where: Prisma.LeafTransactionWhereInput) {
  return prisma.leafTransaction.findMany({ where, orderBy: { createdAt: "asc" } })
}

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: P } }, select: { id: true } })
  const ids = users.map((u) => u.id)
  if (ids.length === 0) return
  await prisma.tradeRequest.deleteMany({ where: { OR: [{ senderId: { in: ids } }, { receiverId: { in: ids } }] } })
  await prisma.offer.deleteMany({ where: { OR: [{ senderId: { in: ids } }, { receiverId: { in: ids } }] } })
  await prisma.item.deleteMany({ where: { userId: { in: ids } } })
  // LeafTransaction cascades from User. The fixture accounts' rows net to
  // exactly their balances, so removing both sides together keeps the global
  // invariant where it was.
  await prisma.user.deleteMany({ where: { id: { in: ids } } })
}

async function main() {
  const schema = databaseSchema()
  if (schema === "public") {
    console.error(
      "\n  REFUSING TO RUN on the live schema. Use: .\\scripts\\scratch.ps1 -Run scripts\\verify-bracket-libs.ts\n",
    )
    process.exit(1)
  }
  console.log(`schema: ${schema}`)
  await cleanup()
  const start = await invariant("at start")
  if (!start.ok) { console.log("\nthe live ledger does not reconcile; fix that first"); process.exit(1) }

  // ═══ 1  the rules ═══
  head("1  offerLegality / bridgingFee / tradeReward")
  check("same bracket → same", offerLegality(3, 3) === "same")
  check("one below → bridge", offerLegality(2, 3) === "bridge")
  check("two below → tooLow", offerLegality(1, 3) === "tooLow")
  check("nine below → tooLow", offerLegality(1, 10) === "tooLow")
  check("one above → higher", offerLegality(4, 3) === "higher")
  check("far above → higher", offerLegality(10, 1) === "higher")
  let feeTable = true
  for (let b = 1; b < BRACKET_COUNT; b++) {
    if (bridgingFee(b) !== BRIDGE_FEE_PER_BRACKET * b) feeTable = false
    if (feeForOffer(b, b + 1) !== BRIDGE_FEE_PER_BRACKET * b) feeTable = false
  }
  check("bridgingFee(b) = 10·b for b in 1..9, via the formula", feeTable && BRIDGE_FEE_PER_BRACKET === 10)
  check("1→2 is 10, 2→3 is 20, 6→7 is 60", bridgingFee(1) === 10 && bridgingFee(2) === 20 && bridgingFee(6) === 60)
  check("bracket 10 cannot bridge", bridgingFee(10) === null && feeForOffer(10, 10) === 0)
  check("same bracket costs 0", feeForOffer(5, 5) === 0)
  check("illegal pairs have no fee", feeForOffer(1, 3) === null && feeForOffer(4, 3) === null)
  let rewardTable = true
  for (let b = 1; b <= BRACKET_COUNT; b++) if (tradeReward(b) !== TRADE_REWARD_PER_BRACKET * b) rewardTable = false
  check("tradeReward(b) = 2·b for b in 1..10", rewardTable && TRADE_REWARD_PER_BRACKET === 2)
  check("tradeReward clamps to the table", tradeReward(0) === 2 && tradeReward(99) === 20)

  // ═══ 2  the value cap ═══
  head("2  valueCap / classifyValue")
  {
    const cap = valueCap(300) // bracket 3
    check("suggested 300 is bracket 3, cap is bracket 4 (≤900)", cap.suggestedBracket === 3 && cap.maxBracketWithoutReview === 4 && cap.maxValueWithoutReview === 900)
    check("no value → suggested", classifyValue(null, 300) === "suggested" && classifyValue(0, 300) === "suggested")
    check("the suggestion typed back → suggested", classifyValue(300, 300) === "suggested")
    check("1 Leaf → lowered", classifyValue(1, 300) === "lowered")
    check("299 → lowered", classifyValue(299, 300) === "lowered")
    check("900 (top of bracket 4) → raisedWithinCap", classifyValue(900, 300) === "raisedWithinCap")
    check("901 (bracket 5) → needsReview", classifyValue(901, 300) === "needsReview")
    check("50,000 → needsReview", classifyValue(50_000, 300) === "needsReview")
    const top = valueCap(20_000) // bracket 10
    check("a bracket-10 suggestion has no ceiling", top.maxBracketWithoutReview === 10 && top.maxValueWithoutReview === null)
    check("raising a bracket-10 suggestion never needs review", classifyValue(1_000_000, 20_000) === "raisedWithinCap")
    const nine = valueCap(10_000) // bracket 9
    check("a bracket-9 suggestion may go to bracket 10 unreviewed", nine.maxBracketWithoutReview === 10 && classifyValue(99_999, 10_000) === "raisedWithinCap")
    check("bracketRange(4).max is the cap value", bracketRange(4).max === 900)
  }

  // ═══ fixtures ═══
  const a = await user("a", 100)
  const b = await user("b", 0)
  const c = await user("c", 5)
  const a1 = await item(a.id, "a-b1", 50)
  const a2 = await item(a.id, "a-b2", 200)
  const a3 = await item(a.id, "a-b3", 300)
  const a4 = await item(a.id, "a-b4", 700)
  const aNull = await item(a.id, "a-unvalued", null)
  const aBusy = await item(a.id, "a-busy", 300, "IN_TRADE")
  const b3 = await item(b.id, "b-b3", 400)
  const b2 = await item(b.id, "b-b2", 150)
  const bNull = await item(b.id, "b-unvalued", null)
  const bBusy = await item(b.id, "b-busy", 400, "IN_TRADE")
  await invariant("after fixtures")

  // ═══ 3  assessOffer ═══
  head("3  assessOffer()")
  {
    const same = await assessOffer(prisma, { proposerId: a.id, offeredItemId: a3.id, targetItemId: b3.id })
    check("bracket 3 for bracket 3 → same, fee 0", same.ok && same.legality === "same" && same.fee === 0)
    const bridge = await assessOffer(prisma, { proposerId: a.id, offeredItemId: a2.id, targetItemId: b3.id })
    check("bracket 2 for bracket 3 → bridge, fee 20", bridge.ok && bridge.legality === "bridge" && bridge.fee === 20 && bridge.offeredBracket === 2 && bridge.targetBracket === 3)
    const low = await assessOffer(prisma, { proposerId: a.id, offeredItemId: a1.id, targetItemId: b3.id })
    check("bracket 1 for bracket 3 → OFFER_BRACKET_TOO_LOW", !low.ok && low.code === "OFFER_BRACKET_TOO_LOW")
    check("…and the refusal says the rule, not 'levels'", !low.ok && /2 or more brackets above your item/.test(low.message) && /one bracket at most/.test(low.message))
    const high = await assessOffer(prisma, { proposerId: a.id, offeredItemId: a4.id, targetItemId: b3.id })
    check("bracket 4 for bracket 3 → OFFER_BRACKET_HIGHER", !high.ok && high.code === "OFFER_BRACKET_HIGHER")
    const un1 = await assessOffer(prisma, { proposerId: a.id, offeredItemId: aNull.id, targetItemId: b3.id })
    const un2 = await assessOffer(prisma, { proposerId: a.id, offeredItemId: a3.id, targetItemId: bNull.id })
    check("an unvalued item on either side → ITEM_UNVALUED", !un1.ok && un1.code === "ITEM_UNVALUED" && !un2.ok && un2.code === "ITEM_UNVALUED")
    const notMine = await assessOffer(prisma, { proposerId: a.id, offeredItemId: b2.id, targetItemId: b3.id })
    check("offering somebody else's item → NOT_YOUR_ITEM", !notMine.ok && notMine.code === "NOT_YOUR_ITEM")
    const own = await assessOffer(prisma, { proposerId: a.id, offeredItemId: a2.id, targetItemId: a3.id })
    check("offering on your own listing → OWN_LISTING", !own.ok && own.code === "OWN_LISTING")
    const self = await assessOffer(prisma, { proposerId: a.id, offeredItemId: a3.id, targetItemId: a3.id })
    check("a listing for itself → OWN_LISTING", !self.ok && self.code === "OWN_LISTING")
    const busy1 = await assessOffer(prisma, { proposerId: a.id, offeredItemId: aBusy.id, targetItemId: b3.id })
    const busy2 = await assessOffer(prisma, { proposerId: a.id, offeredItemId: a3.id, targetItemId: bBusy.id })
    check("an IN_TRADE item on either side → ITEM_NOT_AVAILABLE", !busy1.ok && busy1.code === "ITEM_NOT_AVAILABLE" && !busy2.ok && busy2.code === "ITEM_NOT_AVAILABLE")
    const ghost = await assessOffer(prisma, { proposerId: a.id, offeredItemId: a3.id, targetItemId: "nope" })
    check("a missing listing → ITEM_NOT_FOUND", !ghost.ok && ghost.code === "ITEM_NOT_FOUND")
  }

  // ═══ 4  the fee ═══
  head("4  hold → release, hold → pay, short balance")
  const offer1 = await prisma.offer.create({
    data: {
      postId: b3.id, senderId: a.id, receiverId: b.id, status: "PENDING",
      offeredItems: JSON.stringify([{ id: a2.id, title: a2.title }]),
      bridgeFeeLeaves: 20, offeredBracket: 2, targetBracket: 3, consentAt: new Date(), policyVersion: "test",
    },
  })
  const hold1 = await prisma.$transaction((tx) => holdBridgeFee(tx, { userId: a.id, offerId: offer1.id, amount: 20 }))
  check("hold takes 20 off the proposer", hold1.ok && (await balance(a.id)).leaves === 80)
  {
    const r = await rows({ offerId: offer1.id })
    check("…and writes one BRIDGE_FEE_HOLD row for -20", r.length === 1 && r[0].type === "BRIDGE_FEE_HOLD" && r[0].amount === -20)
  }
  {
    const j = await invariant("with a hold open")
    check("escrow is 20 and the rows agree", j.escrow === start.escrow + 20 && j.held === start.held + 20)
    check("heldBridgeFees(a) is 20", (await heldBridgeFees(prisma, a.id)) === 20)
  }

  // short balance
  const offerShort = await prisma.offer.create({
    data: {
      postId: b3.id, senderId: c.id, receiverId: b.id, status: "PENDING",
      offeredItems: "[]", bridgeFeeLeaves: 20, offeredBracket: 2, targetBracket: 3,
    },
  })
  const short = await prisma.$transaction((tx) => holdBridgeFee(tx, { userId: c.id, offerId: offerShort.id, amount: 20 }))
  check("a short balance refuses and says how much they have", !short.ok && short.have === 5)
  check("…balance untouched, no ledger row", (await balance(c.id)).leaves === 5 && (await rows({ offerId: offerShort.id })).length === 0)
  await prisma.offer.delete({ where: { id: offerShort.id } })

  // release
  const released = await prisma.$transaction(async (tx) => {
    await tx.offer.update({ where: { id: offer1.id }, data: { status: "DECLINED" } })
    return releaseBridgeFee(tx, { userId: a.id, offerId: offer1.id, amount: 20, reason: "declined" })
  })
  check("release gives the 20 back", released && (await balance(a.id)).leaves === 100)
  {
    const r = await rows({ offerId: offer1.id })
    check("…and writes one BRIDGE_FEE_RELEASE row for +20", r.length === 2 && r[1].type === "BRIDGE_FEE_RELEASE" && r[1].amount === 20)
  }
  const again = await prisma.$transaction((tx) => releaseBridgeFee(tx, { userId: a.id, offerId: offer1.id, amount: 20, reason: "declined" }))
  check("a second release is refused, nothing written", again === false && (await rows({ offerId: offer1.id })).length === 2 && (await balance(a.id)).leaves === 100)
  {
    const j = await invariant("after release")
    check("escrow back to where it started", j.escrow === start.escrow && j.held === start.held)
  }

  // pay
  const offer2 = await prisma.offer.create({
    data: {
      postId: b3.id, senderId: a.id, receiverId: b.id, status: "PENDING",
      offeredItems: JSON.stringify([{ id: a2.id, title: a2.title }]),
      bridgeFeeLeaves: 20, offeredBracket: 2, targetBracket: 3, consentAt: new Date(), policyVersion: "test",
    },
  })
  await prisma.$transaction((tx) => holdBridgeFee(tx, { userId: a.id, offerId: offer2.id, amount: 20 }))
  // accept: the fee moves to the trade row, the offer is ACCEPTED
  const trade = await prisma.$transaction(async (tx) => {
    await tx.offer.update({ where: { id: offer2.id }, data: { status: "ACCEPTED" } })
    return tx.tradeRequest.create({
      data: {
        senderId: a.id, receiverId: b.id, offeredItemId: a2.id, requestedItemId: b3.id,
        status: "ACCEPTED", bridgeFeeLeaves: 20,
      },
    })
  })
  {
    const j = await invariant("with the fee on a live trade")
    check("escrow still 20, counted once (on the trade, not the ACCEPTED offer)", j.escrow === start.escrow + 20 && j.held === start.held + 20)
    check("heldBridgeFees(a) still 20", (await heldBridgeFees(prisma, a.id)) === 20)
  }
  const completedAt = new Date()
  const paid = await prisma.$transaction(async (tx) => {
    await tx.tradeRequest.update({ where: { id: trade.id }, data: { status: "COMPLETED", updatedAt: completedAt } })
    return payBridgeFee(tx, { receiverId: b.id, proposerName: "A", offerId: offer2.id, tradeId: trade.id, amount: 20, at: completedAt })
  })
  check("pay credits the receiver 20", paid && (await balance(b.id)).leaves === 20)
  check("…the proposer stays at 80", (await balance(a.id)).leaves === 80)
  {
    const r = await rows({ offerId: offer2.id })
    check("…and writes one BRIDGE_FEE_PAID row on the receiver, pointing at both", r.length === 2 && r[1].type === "BRIDGE_FEE_PAID" && r[1].amount === 20 && r[1].userId === b.id && r[1].tradeId === trade.id)
    check("…lifetimeLeaves untouched by a fee", (await balance(b.id)).lifetime === 0)
  }
  const payAgain = await prisma.$transaction((tx) => payBridgeFee(tx, { receiverId: b.id, proposerName: "A", offerId: offer2.id, tradeId: trade.id, amount: 20 }))
  check("a second pay is refused", payAgain === false && (await balance(b.id)).leaves === 20)
  const releaseAfterPay = await prisma.$transaction((tx) => releaseBridgeFee(tx, { userId: a.id, offerId: offer2.id, amount: 20, reason: "cancelled" }))
  check("a release after a pay is refused", releaseAfterPay === false && (await balance(a.id)).leaves === 80)
  {
    const j = await invariant("after pay")
    check("escrow closed", j.escrow === start.escrow && j.held === start.held)
  }

  // ═══ 5  the reward ═══
  head("5  awardTradeRewards / reverseTradeRewards")
  const before = { a: await balance(a.id), b: await balance(b.id) }
  const issuanceBefore = (await ledgerInvariant(prisma)).issuance
  const outcome = await prisma.$transaction((tx) =>
    awardTradeRewards(tx, {
      id: trade.id, senderId: a.id, receiverId: b.id, offeredItemId: a2.id, requestedItemId: b3.id, completedAt,
    }),
  )
  check("sender gave bracket 2 → +4", outcome.sender.reason === "awarded" && outcome.sender.amount === 4 && outcome.sender.givenBracket === 2)
  check("receiver gave bracket 3 → +6", outcome.receiver.reason === "awarded" && outcome.receiver.amount === 6 && outcome.receiver.givenBracket === 3)
  {
    const A = await balance(a.id), B = await balance(b.id)
    check("balances moved by exactly the reward", A.leaves === before.a.leaves + 4 && B.leaves === before.b.leaves + 6)
    check("lifetimeLeaves moved too", A.lifetime === before.a.lifetime + 4 && B.lifetime === before.b.lifetime + 6)
    const r = await rows({ tradeId: trade.id, type: "TRADE_REWARD" })
    check("two TRADE_REWARD rows, eventAt = completion", r.length === 2 && r.every((x) => x.eventAt.getTime() === completedAt.getTime()))
    const j = await invariant("after reward")
    check("issuance grew by 10 and reconciles", j.issuance === issuanceBefore + 10)
  }
  const replay = await prisma.$transaction((tx) =>
    awardTradeRewards(tx, { id: trade.id, senderId: a.id, receiverId: b.id, offeredItemId: a2.id, requestedItemId: b3.id, completedAt }),
  )
  check("a replay pays nothing (already_awarded)", replay.sender.reason === "already_awarded" && replay.receiver.reason === "already_awarded" && (await balance(a.id)).leaves === before.a.leaves + 4)

  // placeholder + unvalued
  const ph = await prisma.tradeRequest.create({ data: { senderId: a.id, receiverId: b.id, offeredItemId: b3.id, requestedItemId: b3.id, status: "COMPLETED" } })
  const phOut = await prisma.$transaction((tx) => awardTradeRewards(tx, { ...ph, completedAt: new Date() }))
  check("a placeholder trade (same item both sides) pays nothing", phOut.sender.reason === "placeholder" && phOut.receiver.reason === "placeholder")
  const unv = await prisma.tradeRequest.create({ data: { senderId: a.id, receiverId: b.id, offeredItemId: aNull.id, requestedItemId: bNull.id, status: "COMPLETED" } })
  const unvOut = await prisma.$transaction((tx) => awardTradeRewards(tx, { ...unv, completedAt: new Date(Date.now() + 60_000) }))
  check("an unvalued given item pays nothing", unvOut.sender.reason === "unvalued" && unvOut.receiver.reason === "unvalued")
  await prisma.tradeRequest.deleteMany({ where: { id: { in: [ph.id, unv.id] } } })

  // repeat pair: a second A↔B trade a day later, with fresh items
  const a3b = await item(a.id, "a-b3-second", 320)
  const b3b = await item(b.id, "b-b3-second", 420)
  const dayLater = new Date(completedAt.getTime() + 86_400_000)
  const pair = await prisma.tradeRequest.create({ data: { senderId: b.id, receiverId: a.id, offeredItemId: b3b.id, requestedItemId: a3b.id, status: "COMPLETED", updatedAt: dayLater } })
  const pairOut = await prisma.$transaction((tx) => awardTradeRewards(tx, { ...pair, completedAt: dayLater }))
  check("the same pair a day later → repeat_pair, both sides", pairOut.sender.reason === "repeat_pair" && pairOut.receiver.reason === "repeat_pair")
  const eightDays = new Date(completedAt.getTime() + 8 * 86_400_000)
  await prisma.tradeRequest.update({ where: { id: pair.id }, data: { updatedAt: eightDays } })
  // The first trade's row sits at completedAt; eight days on, it is outside the 7-day window.
  const pairLater = await prisma.$transaction((tx) => awardTradeRewards(tx, { ...pair, completedAt: eightDays }))
  check("…but eight days later the pair is fresh again", pairLater.sender.reason === "awarded" && pairLater.receiver.reason === "awarded")

  // same item: A gives a2 (already traded at completedAt) to C, 10 days on. Pair A–C is fresh.
  const c1 = await item(c.id, "c-b2", 180)
  const tenDays = new Date(completedAt.getTime() + 10 * 86_400_000)
  const ring = await prisma.tradeRequest.create({ data: { senderId: a.id, receiverId: c.id, offeredItemId: a2.id, requestedItemId: c1.id, status: "COMPLETED", updatedAt: tenDays } })
  const ringOut = await prisma.$transaction((tx) => awardTradeRewards(tx, { ...ring, completedAt: tenDays }))
  check("the same item ten days on → same_item for the giver only", ringOut.sender.reason === "same_item" && ringOut.receiver.reason === "awarded" && ringOut.receiver.amount === 4)
  const fortyDays = new Date(completedAt.getTime() + 40 * 86_400_000)
  const ring2 = await prisma.tradeRequest.create({ data: { senderId: a.id, receiverId: c.id, offeredItemId: a3.id, requestedItemId: c1.id, status: "COMPLETED", updatedAt: fortyDays } })
  // c1 was in `ring` at tenDays, 30 days before fortyDays: exactly at the edge, inside.
  const ring2Out = await prisma.$transaction((tx) => awardTradeRewards(tx, { ...ring2, completedAt: fortyDays }))
  check("the receiver's item from 30 days ago is still inside the item window", ring2Out.receiver.reason === "same_item")

  // daily cap: D already collected 40 today
  const d = await user("d", 0)
  const e = await user("e", 0)
  const d1 = await item(d.id, "d-b1", 60)
  const e1 = await item(e.id, "e-b1", 70)
  const now = new Date()
  await prisma.$transaction([
    prisma.leafTransaction.create({ data: { userId: d.id, type: "TRADE_REWARD", amount: 20, description: `${P} cap fixture`, tradeId: "zzfixture1", eventAt: new Date(now.getTime() - 3600_000) } }),
    prisma.leafTransaction.create({ data: { userId: d.id, type: "TRADE_REWARD", amount: 20, description: `${P} cap fixture`, tradeId: "zzfixture2", eventAt: new Date(now.getTime() - 7200_000) } }),
    prisma.user.update({ where: { id: d.id }, data: { leaves: { increment: 40 }, lifetimeLeaves: { increment: 40 } } }),
  ])
  const capTrade = await prisma.tradeRequest.create({ data: { senderId: d.id, receiverId: e.id, offeredItemId: d1.id, requestedItemId: e1.id, status: "COMPLETED", updatedAt: now } })
  const capOut = await prisma.$transaction((tx) => awardTradeRewards(tx, { ...capTrade, completedAt: now }))
  check(`D at the ${TRADE_REWARD_DAILY_CAP_LEAVES}-Leaf daily cap → daily_cap; E still paid`, capOut.sender.reason === "daily_cap" && capOut.receiver.reason === "awarded")
  const tomorrow = new Date(now.getTime() + 25 * 3600_000)
  const capTrade2 = await prisma.tradeRequest.create({ data: { senderId: e.id, receiverId: d.id, offeredItemId: e1.id, requestedItemId: d1.id, status: "COMPLETED", updatedAt: tomorrow } })
  void capTrade2
  await invariant("after the gates")

  // reversal
  const lifetimeBefore = { a: (await balance(a.id)).lifetime, b: (await balance(b.id)).lifetime }
  const reversed = await prisma.$transaction((tx) => reverseTradeRewards(tx, trade.id))
  check("reversal takes 4 and 6 back", reversed.length === 2 && reversed.some((r) => r.userId === a.id && r.amount === 4) && reversed.some((r) => r.userId === b.id && r.amount === 6))
  check("…lifetimeLeaves moves back", (await balance(a.id)).lifetime === lifetimeBefore.a - 4 && (await balance(b.id)).lifetime === lifetimeBefore.b - 6)
  {
    const r = await rows({ tradeId: trade.id, type: "TRADE_REWARD_REVERSAL" })
    check("…two TRADE_REWARD_REVERSAL rows, negative", r.length === 2 && r.every((x) => x.amount < 0))
    const j = await invariant("after reversal")
    check("issuance is back to before the reward (+ the other awards)", j.minted)
  }
  const reversedAgain = await prisma.$transaction((tx) => reverseTradeRewards(tx, trade.id))
  check("a second reversal writes nothing", reversedAgain.length === 0 && (await rows({ tradeId: trade.id, type: "TRADE_REWARD_REVERSAL" })).length === 2)
  // a reversal can take a balance negative; the ledger stays exact
  const f = await user("f", 0)
  const g = await user("g", 0)
  const f1 = await item(f.id, "f-b1", 40)
  const g1 = await item(g.id, "g-b1", 45)
  const fgAt = new Date(now.getTime() + 48 * 3600_000)
  const fg = await prisma.tradeRequest.create({ data: { senderId: f.id, receiverId: g.id, offeredItemId: f1.id, requestedItemId: g1.id, status: "COMPLETED", updatedAt: fgAt } })
  await prisma.$transaction((tx) => awardTradeRewards(tx, { ...fg, completedAt: fgAt }))
  // F spends the 2 Leaves on a (legacy-shaped) settlement pair to G.
  await prisma.$transaction([
    prisma.user.update({ where: { id: f.id }, data: { leaves: { decrement: 2 } } }),
    prisma.user.update({ where: { id: g.id }, data: { leaves: { increment: 2 } } }),
    prisma.leafTransaction.create({ data: { userId: f.id, type: "TRADE_SPEND", amount: -2, description: `${P} spend`, eventAt: fgAt } }),
    prisma.leafTransaction.create({ data: { userId: g.id, type: "TRADE_RECEIVE", amount: 2, description: `${P} receive`, eventAt: fgAt } }),
  ])
  check("F holds 0 after spending the reward", (await balance(f.id)).leaves === 0)
  await prisma.$transaction((tx) => reverseTradeRewards(tx, fg.id))
  check("reversing a spent reward goes negative, and the ledger still balances", (await balance(f.id)).leaves === -2 && (await balance(f.id)).lifetime === 0 && (await invariant("with a negative balance")).ok)

  // ═══ 6  decideItemValue ═══
  head("6  decideItemValue()")
  {
    const base = await decideItemValue("OTHER", "GOOD", null)
    const s = base.data.suggestedLeaves
    check("no value → the suggestion, not user-set, live", base.decision === "suggested" && base.data.valueLeaves === s && !base.data.valueSetByUser && !base.needsReview)
    const same = await decideItemValue("OTHER", "GOOD", s)
    check("the suggestion typed back → not user-set", same.decision === "suggested" && !same.data.valueSetByUser)
    const lower = await decideItemValue("OTHER", "GOOD", Math.max(1, Math.floor(s / 4)))
    check("a quarter of the suggestion → lowered, user-set, live", lower.decision === "lowered" && lower.data.valueSetByUser && !lower.needsReview && lower.data.valueLeaves === Math.max(1, Math.floor(s / 4)))
    const cap = valueCap(s)
    const atCap = cap.maxValueWithoutReview ?? s * 10
    const within = await decideItemValue("OTHER", "GOOD", atCap)
    check(`the top of bracket ${cap.maxBracketWithoutReview} (${atCap}) → raisedWithinCap, live`, within.decision === "raisedWithinCap" && within.data.valueSetByUser && !within.needsReview)
    const over = await decideItemValue("OTHER", "GOOD", atCap + 1)
    check(`${atCap + 1} → needsReview, value stored as requested`, over.decision === "needsReview" && over.needsReview && over.data.valueSetByUser && over.data.valueLeaves === atCap + 1)
    check("the suggestion itself never changed", over.data.suggestedLeaves === s && within.data.suggestedLeaves === s && bracketOf(s) === cap.suggestedBracket)
  }

  await cleanup()
  const end = await invariant("after cleanup")
  check("figures are back where they started", end.userLeaves === start.userLeaves && end.escrow === start.escrow && end.issuance === start.issuance)

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
