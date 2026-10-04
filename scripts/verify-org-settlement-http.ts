/**
 * A SHOP as a trading party, end to end, over real HTTP: accept, settle, and
 * every Leaf that moves on the way.
 *
 * RUNS AGAINST A SCRATCH SCHEMA, with a dev server on the same schema:
 *   .\scripts\scratch.ps1 -Push -Name scratch_http
 *   .\scripts\scratch.ps1 -Dev  -Name scratch_http -Port 3100      (other terminal)
 *   $env:BAYLO_BASE_URL="http://127.0.0.1:3100"
 *   .\scripts\scratch.ps1 -Run scripts\verify-org-settlement-http.ts -Name scratch_http -Keep
 *
 * ── WHAT THIS PINS DOWN (26 Sep 2026) ───────────────────────────────────────
 *
 * Org trading lets an ACTIVE member act as the shop's side of an offer and a
 * trade (@/lib/trade-participant). That is a NEW path into code that moves
 * Leaves -- holds, fee payments, the completion reward -- and none of it had
 * ever run with a shop's backing row as the actor. So:
 *
 *   1  FULL CYCLE, same bracket. Person offers on the shop's listing; staff,
 *      acting as the shop, accept; the shop's Trades list shows the trade and
 *      the staff member's personal list does not; staff start the codes and
 *      read the SHOP's code; both sides submit; items swap. The person earns
 *      TRADE_REWARD, the shop earns NOTHING (no TRADE_REWARD, no TASK_REWARD).
 *
 *   2  UP-BRIDGE, THE SHOP PAYS (and the verified-shop tier-cap exemption).
 *      The person offers a bracket-4 item for the shop's bracket-3 listing, so
 *      the shop moves up and owes the fee at accept.
 *        2a  an UNVERIFIED shop is a New Trader, capped at bracket 3: refused
 *            TIER_ITEM_VALUE_CAP. The verified shop below is not.
 *        2b  the verified shop, balance 0: INSUFFICIENT_LEAVES, offer PENDING.
 *        2c  funded, no consent: CONSENT_REQUIRED.
 *        2d  with consent: held off the SHOP's balance, not the staff member's.
 *        2e  settle: the fee is paid to the person, once.
 *
 *   3  THE SHOP RECEIVES A FEE. The person offers a bracket-1 item for a
 *      bracket-2 listing and pays at propose; staff accept; at settlement the
 *      fee lands on the shop's balance.
 *
 *   4  RATE AS THE SHOP (27 Sep 2026). On trade 1: staff, acting as the shop,
 *      rate the person; the review's reviewer is the SHOP and the reviewee the
 *      person, whose rating moves. Without the header staff are not a party;
 *      a second member of the same shop gets 409 (one side, one review). The
 *      person rates the shop back and the shop's bell shows NEW_REVIEW and
 *      TRADE_COMPLETED. The shop's review moves NO Leaves anywhere: every
 *      ledger row and every balance in the schema is compared before/after.
 *        4f  hired later: p3 joins the shop as staff AFTER trade 3 completed.
 *            As the shop that would be a self-review; refused
 *            SHOP_MEMBER_SELF_TRADE either way round, nothing written.
 *
 * The three-part ledger invariant (@/scripts/lib/ledger-invariant) is checked
 * before anything and after every section. Each case uses a DIFFERENT person,
 * so the reward's repeat-pair gate never decides an outcome here.
 *
 * Quest payouts are fire-and-forget after an offer and a settlement, so a
 * person's balance is compared with QUEST_REWARD rows subtracted, the same
 * approach verify-org-bridge-release-http.ts takes.
 */
import prisma from "../src/lib/prisma"
import { createOrganization } from "../src/lib/organizations"
import { signAccessToken } from "../src/lib/auth-tokens"
import { TRADING_POLICY_VERSION, feeForOffer, tradeReward } from "../src/lib/trade-rules"
import { bracketOf } from "../src/lib/brackets"
import { ledgerInvariant } from "./lib/ledger-invariant"
import { requireScratchSchema } from "./lib/live-guard"

const BASE = process.env.BAYLO_BASE_URL ?? "http://127.0.0.1:3100"

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `   ${detail}` : ""}`) }
}
const head = (s: string) => console.log(`\n── ${s}`)
async function invariant(label: string) {
  const j = await ledgerInvariant(prisma)
  check(`INVARIANT ${label}`, j.ok, j.lines.filter((l) => l.includes("BROKEN")).join(" | "))
}

type Called = { status: number; body: Record<string, unknown> }
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
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, body }
}
const brief = (c: Called) => `status ${c.status} ${JSON.stringify(c.body).slice(0, 220)}`

// Values, by bracket: 1 = 1..100, 2 = 101..250, 3 = 251..500, 4 = 501..900.
const B1 = 50
const B2 = 200
const B3 = 400
const B4 = 700

async function main() {
  requireScratchSchema("scripts/verify-org-settlement-http.ts")
  try {
    await fetch(`${BASE}/api/v1/hubs`)
  } catch {
    console.error(`No server at ${BASE}.`)
    process.exit(2)
  }

  const tag = `verify-org-settle-${Date.now()}`
  const users: string[] = []
  const orgs: string[] = []

  const UP_FEE = feeForOffer(bracketOf(B4), bracketOf(B3))
  const DOWN_FEE = feeForOffer(bracketOf(B1), bracketOf(B2))
  if (!UP_FEE || !DOWN_FEE) throw new Error(`fixtures are not bridges (${UP_FEE}, ${DOWN_FEE})`)

  const bal = async (id: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { id }, select: { leaves: true } })).leaves
  const questPaid = async (id: string) =>
    (await prisma.leafTransaction.aggregate({ where: { userId: id, type: "QUEST_REWARD" }, _sum: { amount: true } }))
      ._sum.amount ?? 0
  const netOfQuests = async (id: string) => (await bal(id)) - (await questPaid(id))
  const letQuestsSettle = () => new Promise((r) => setTimeout(r, 2500))
  const ledgerRows = (where: Record<string, unknown>) =>
    prisma.leafTransaction.findMany({ where, select: { userId: true, amount: true, type: true } })

  /** A person, optionally seeded with Leaves AND the matching ledger row. */
  const person = async (name: string, leaves = 0) => {
    const u = await prisma.user.create({
      data: {
        name: `${tag}-${name}`, email: `${tag}-${name}@test.invalid`,
        isVerified: true, idVerifiedGrandfatheredAt: new Date(),
        leaves, lifetimeLeaves: leaves,
      },
      select: { id: true },
    })
    users.push(u.id)
    if (leaves > 0) {
      await prisma.leafTransaction.create({
        data: { userId: u.id, type: "SIGNUP_GRANT", amount: leaves, description: "test seed", eventAt: new Date() },
      })
    }
    return { id: u.id, token: await signAccessToken(u.id) }
  }
  /** Give an existing row Leaves the way an issuance would: balance and ledger together. */
  const fund = async (userId: string, amount: number) => {
    await prisma.$transaction([
      prisma.user.update({ where: { id: userId }, data: { leaves: { increment: amount }, lifetimeLeaves: { increment: amount } } }),
      prisma.leafTransaction.create({
        data: { userId, type: "SIGNUP_GRANT", amount, description: "test seed", eventAt: new Date() },
      }),
    ])
  }
  const item = (userId: string, title: string, valueLeaves: number) =>
    prisma.item.create({
      data: { title: `${tag} ${title}`, description: "x", category: "OTHER", condition: "GOOD", valueLeaves, userId },
      select: { id: true },
    })
  const shop = async (founderId: string, name: string, status: "VERIFIED" | "PENDING") => {
    const org = await createOrganization({ founderUserId: founderId, name: `${tag} ${name}`, businessCategory: "SARI_SARI" })
    orgs.push(org.organizationId)
    users.push(org.orgUserId)
    await prisma.organization.update({ where: { id: org.organizationId }, data: { verificationStatus: status } })
    return org
  }

  /** Run a trade from ACCEPTED to COMPLETED, the shop's side driven by staff acting as the shop. */
  async function settle(tradeId: string, personToken: string, staffToken: string, orgId: string, label: string) {
    const start = await call(`/api/trades/${tradeId}/confirm/start`, { token: staffToken, orgId, method: "POST", body: {} })
    check(`${label}: staff, acting as the shop, start the codes`, start.status === 200, brief(start))
    const shopStatus = await call(`/api/trades/${tradeId}/confirm/status`, { token: staffToken, orgId })
    const personStatus = await call(`/api/trades/${tradeId}/confirm/status`, { token: personToken })
    const shopCode = shopStatus.body.code
    const personCode = personStatus.body.code
    check(`${label}: staff read the SHOP's code`, shopStatus.status === 200 && typeof shopCode === "string", brief(shopStatus))
    check(`${label}: the person reads their own code`, typeof personCode === "string", brief(personStatus))
    check(`${label}: the two codes are different rows`, shopCode !== personCode)
    const staffNoHeader = await call(`/api/trades/${tradeId}/confirm/status`, { token: staffToken })
    check(`${label}: WITHOUT the header, staff are not a participant (403)`, staffNoHeader.status === 403, brief(staffNoHeader))

    const s1 = await call(`/api/trades/${tradeId}/confirm/submit`, {
      token: personToken, method: "POST", body: { code: String(shopCode) },
    })
    check(`${label}: the person submits the shop's code`, s1.status === 200 && s1.body.correct === true, brief(s1))
    const s2 = await call(`/api/trades/${tradeId}/confirm/submit`, {
      token: staffToken, orgId, method: "POST", body: { code: String(personCode) },
    })
    check(`${label}: staff, as the shop, submit the person's code and complete it`,
      s2.status === 200 && s2.body.completed === true, brief(s2))
    check(`${label}: the shop's completed screen reports no reward`, s2.body.reward === 0, String(s2.body.reward))
    const t = await prisma.trade.findUniqueOrThrow({ where: { id: tradeId }, select: { status: true } })
    check(`${label}: trade COMPLETED`, t.status === "COMPLETED", String(t.status))
    return { person: s1, shop: s2 }
  }

  async function shopEarnedNothing(orgUserId: string, tradeId: string, label: string) {
    const issued = await ledgerRows({ userId: orgUserId, type: { in: ["TRADE_REWARD", "TASK_REWARD", "QUEST_REWARD"] } })
    check(`${label}: the shop has no TRADE_REWARD / TASK_REWARD / QUEST_REWARD rows`, issued.length === 0, JSON.stringify(issued))
    const tasks = await prisma.leafTransaction.count({ where: { userId: orgUserId, task: { not: null } } })
    check(`${label}: and no task rows (not even 0-Leaf denials)`, tasks === 0, `${tasks}`)
    void tradeId
  }

  try {
    await invariant("before anything")

    const owner = await person("owner")
    // Schema v2: organisation staff were removed; the OWNER is the only person
    // who acts as a shop. The "staff" actor of every check below is the owner.
    const staff = owner
    const verified = await shop(owner.id, "Store", "VERIFIED")
    const pending = await shop(owner.id, "Pending Store", "PENDING")
    // Whatever the org path granted, the shop starts this run from zero Leaves
    // of its own making: record it and compare against it.
    const shopStart = await bal(verified.orgUserId)
    const staffStart = await bal(staff.id)

    // ── 1 ────────────────────────────────────────────────────────────────────
    head("1  full cycle, same bracket: person -> shop, settled by staff acting as the shop")
    const p1 = await person("p1")
    const p1Item = await item(p1.id, "p1 kettle", B2)
    const shopItem1 = await item(verified.orgUserId, "rice sack", B2)
    const o1 = await call("/api/offers", { token: p1.token, method: "POST", body: { postId: shopItem1.id, offeredItemId: p1Item.id } })
    check("1: offer sent", o1.status === 201, brief(o1))
    if (o1.status !== 201) throw new Error("cannot continue")
    await letQuestsSettle()

    const shopList = await call("/api/v1/trades?tab=active", { token: staff.token, orgId: verified.organizationId })
    const shopOffers = ((shopList.body.data as Record<string, unknown>)?.offers ?? []) as { id: string; direction: string }[]
    check("1: the SHOP's Trades list shows the offer as received",
      shopOffers.some((o) => o.id === o1.body.offerId && o.direction === "received"), brief(shopList))
    const staffList = await call("/api/v1/trades?tab=active", { token: staff.token })
    const staffOffers = ((staffList.body.data as Record<string, unknown>)?.offers ?? []) as { id: string }[]
    check("1: the staff member's PERSONAL list does not", !staffOffers.some((o) => o.id === o1.body.offerId))

    const a1 = await call(`/api/offers/${o1.body.offerId}`, {
      token: staff.token, orgId: verified.organizationId, method: "PATCH", body: { action: "accept" },
    })
    check("1: staff, acting as the shop, accept", a1.status === 200 && typeof a1.body.tradeId === "string", brief(a1))
    const trade1 = String(a1.body.tradeId)
    const t1 = await prisma.trade.findUniqueOrThrow({ where: { id: trade1 }, select: { senderId: true, receiverId: true } })
    check("1: the trade's receiver is the shop's backing row", t1.receiverId === verified.orgUserId && t1.senderId === p1.id)
    const notif = await prisma.notification.findFirst({ where: { userId: p1.id, type: "TRADE_ACCEPTED" }, select: { actorId: true } })
    check("1: the person's notification is from the SHOP, not the staff member", notif?.actorId === verified.orgUserId, String(notif?.actorId))

    const shopTrades = await call("/api/v1/trades?tab=active", { token: staff.token, orgId: verified.organizationId })
    const listed = ((shopTrades.body.data as Record<string, unknown>)?.trades ?? []) as { id: string }[]
    check("1: the accepted trade is on the shop's Trades list", listed.some((t) => t.id === trade1), brief(shopTrades))

    await settle(trade1, p1.token, staff.token, verified.organizationId, "1")
    const items1 = await prisma.item.findMany({ where: { id: { in: [p1Item.id, shopItem1.id] } }, select: { id: true, userId: true } })
    check("1: the person's item now belongs to the shop",
      items1.find((i) => i.id === p1Item.id)?.userId === verified.orgUserId)
    check("1: the shop's item now belongs to the person",
      items1.find((i) => i.id === shopItem1.id)?.userId === p1.id)
    const p1Reward = await ledgerRows({ userId: p1.id, tradeId: trade1, type: "TRADE_REWARD" })
    check(`1: the person earned TRADE_REWARD ${tradeReward(bracketOf(B2))}`,
      p1Reward.length === 1 && p1Reward[0].amount === tradeReward(bracketOf(B2)), JSON.stringify(p1Reward))
    await shopEarnedNothing(verified.orgUserId, trade1, "1")
    check("1: the shop's balance did not move", (await bal(verified.orgUserId)) === shopStart,
      `${shopStart} -> ${await bal(verified.orgUserId)}`)
    await letQuestsSettle()
    await invariant("after 1")

    // ── 2 ────────────────────────────────────────────────────────────────────
    head(`2  up-bridge: the SHOP pays ${UP_FEE} (bracket ${bracketOf(B4)} offered for bracket ${bracketOf(B3)})`)
    const p2 = await person("p2")
    const p2Item = await item(p2.id, "p2 bike", B4)
    const p2ItemControl = await item(p2.id, "p2 drill", B4)

    head("2a  an UNVERIFIED shop keeps the New Trader cap")
    const pendingListing = await item(pending.orgUserId, "pending oil", B3)
    const oc = await call("/api/offers", { token: p2.token, method: "POST", body: { postId: pendingListing.id, offeredItemId: p2ItemControl.id } })
    check("2a: offer to the pending shop sent", oc.status === 201, brief(oc))
    if (oc.status === 201) {
      const ac = await call(`/api/offers/${oc.body.offerId}`, {
        token: staff.token, orgId: pending.organizationId, method: "PATCH",
        body: { action: "accept", consent: { accepted: true, policyVersion: TRADING_POLICY_VERSION } },
      })
      check("2a: refused TIER_ITEM_VALUE_CAP (bracket 4 over the bracket-3 cap)",
        ac.status === 403 && ac.body.code === "TIER_ITEM_VALUE_CAP", brief(ac))
      // Close it so its item is free and nothing is left open.
      await call(`/api/v1/offers/${oc.body.offerId}/withdraw`, { token: p2.token, method: "POST", body: {} })
    }

    const shopItem2 = await item(verified.orgUserId, "cooking oil", B3)
    const o2 = await call("/api/offers", { token: p2.token, method: "POST", body: { postId: shopItem2.id, offeredItemId: p2Item.id } })
    check("2: offer sent, the RECEIVER is the payer", o2.status === 201 && o2.body.bridgeFeePayer === "receiver", brief(o2))
    if (o2.status !== 201) throw new Error("cannot continue")
    await letQuestsSettle()
    const p2Before = await netOfQuests(p2.id)

    head("2b  the verified shop cannot cover it")
    // Drain whatever the shop holds so the short case is certain.
    const held = await bal(verified.orgUserId)
    if (held > 0) {
      await prisma.$transaction([
        prisma.user.update({ where: { id: verified.orgUserId }, data: { leaves: { decrement: held }, lifetimeLeaves: { decrement: held } } }),
        prisma.leafTransaction.create({
          data: { userId: verified.orgUserId, type: "SIGNUP_GRANT", amount: -held, description: "test drain", eventAt: new Date() },
        }),
      ])
    }
    const consent = { accepted: true, policyVersion: TRADING_POLICY_VERSION }
    const short = await call(`/api/offers/${o2.body.offerId}`, {
      token: staff.token, orgId: verified.organizationId, method: "PATCH", body: { action: "accept", consent },
    })
    check("2b: INSUFFICIENT_LEAVES, need vs the SHOP's have (0)",
      short.status === 400 && short.body.code === "INSUFFICIENT_LEAVES" && short.body.have === 0, brief(short))
    const o2Row = await prisma.trade.findUniqueOrThrow({ where: { id: String(o2.body.offerId) }, select: { offerStatus: true } })
    check("2b: the offer is still PENDING", o2Row.offerStatus === "PENDING", String(o2Row.offerStatus))

    head("2c  funded, but no consent")
    await fund(verified.orgUserId, 50)
    const noConsent = await call(`/api/offers/${o2.body.offerId}`, {
      token: staff.token, orgId: verified.organizationId, method: "PATCH", body: { action: "accept" },
    })
    check("2c: CONSENT_REQUIRED", noConsent.status === 400 && noConsent.body.code === "CONSENT_REQUIRED", brief(noConsent))
    check("2c: nothing held", (await bal(verified.orgUserId)) === 50)

    head("2d  with consent: held off the SHOP's balance")
    const a2 = await call(`/api/offers/${o2.body.offerId}`, {
      token: staff.token, orgId: verified.organizationId, method: "PATCH", body: { action: "accept", consent },
    })
    check("2d: accepted, verified shop exempt from the tier cap", a2.status === 200, brief(a2))
    check(`2d: charged ${UP_FEE}`, a2.body.chargedLeaves === UP_FEE, String(a2.body.chargedLeaves))
    check(`2d: shop 50 -> ${50 - UP_FEE}`, (await bal(verified.orgUserId)) === 50 - UP_FEE, String(await bal(verified.orgUserId)))
    check("2d: the staff member's own balance did not move", (await bal(staff.id)) === staffStart)
    // The fee's rows key on the deal's one id (schema v2: no ledger offerId).
    const hold2 = await ledgerRows({ tradeId: String(o2.body.offerId), type: "BRIDGE_FEE_HOLD" })
    check("2d: one BRIDGE_FEE_HOLD, -fee, on the SHOP",
      hold2.length === 1 && hold2[0].userId === verified.orgUserId && hold2[0].amount === -UP_FEE, JSON.stringify(hold2))
    const o2After = await prisma.trade.findUniqueOrThrow({ where: { id: String(o2.body.offerId) }, select: { consentAt: true } })
    check("2d: consent recorded on the offer", o2After.consentAt !== null)
    await invariant("with the shop's fee in escrow")

    head("2e  settle: the fee reaches the person")
    const trade2 = String(a2.body.tradeId)
    await settle(trade2, p2.token, staff.token, verified.organizationId, "2e")
    const paid2 = await ledgerRows({ tradeId: trade2, type: "BRIDGE_FEE_PAID" })
    check("2e: one BRIDGE_FEE_PAID, +fee, to the person",
      paid2.length === 1 && paid2[0].userId === p2.id && paid2[0].amount === UP_FEE, JSON.stringify(paid2))
    await letQuestsSettle()
    const p2Reward = (await ledgerRows({ userId: p2.id, tradeId: trade2, type: "TRADE_REWARD" }))[0]?.amount ?? 0
    const p2Tasks = (await ledgerRows({ userId: p2.id, tradeId: trade2, type: "TASK_REWARD" })).reduce((s, r) => s + r.amount, 0)
    check("2e: person = before + fee + their own reward and tasks",
      (await netOfQuests(p2.id)) === p2Before + UP_FEE + p2Reward + p2Tasks,
      `${p2Before} + ${UP_FEE} + ${p2Reward} + ${p2Tasks} vs ${await netOfQuests(p2.id)}`)
    check(`2e: the shop ends at ${50 - UP_FEE}`, (await bal(verified.orgUserId)) === 50 - UP_FEE)
    await shopEarnedNothing(verified.orgUserId, trade2, "2e")
    await invariant("after 2")

    // ── 3 ────────────────────────────────────────────────────────────────────
    head(`3  the SHOP receives a fee (${DOWN_FEE}): bracket ${bracketOf(B1)} offered for bracket ${bracketOf(B2)}`)
    const p3 = await person("p3", 50)
    const p3Item = await item(p3.id, "p3 mug", B1)
    const shopItem3 = await item(verified.orgUserId, "sugar", B2)
    const o3 = await call("/api/offers", {
      token: p3.token, method: "POST", body: { postId: shopItem3.id, offeredItemId: p3Item.id, consent },
    })
    check("3: offer sent, proposer pays at propose",
      o3.status === 201 && o3.body.bridgeFeePayer === "proposer" && o3.body.chargedLeaves === DOWN_FEE, brief(o3))
    if (o3.status !== 201) throw new Error("cannot continue")
    const shopBefore3 = await bal(verified.orgUserId)
    const a3 = await call(`/api/offers/${o3.body.offerId}`, {
      token: staff.token, orgId: verified.organizationId, method: "PATCH", body: { action: "accept" },
    })
    check("3: staff accept without consent (the shop is not paying)", a3.status === 200 && a3.body.chargedLeaves === 0, brief(a3))
    check("3: nothing moved on the shop at accept", (await bal(verified.orgUserId)) === shopBefore3)
    const trade3 = String(a3.body.tradeId)
    await settle(trade3, p3.token, staff.token, verified.organizationId, "3")
    const paid3 = await ledgerRows({ tradeId: trade3, type: "BRIDGE_FEE_PAID" })
    check("3: one BRIDGE_FEE_PAID, +fee, to the SHOP",
      paid3.length === 1 && paid3[0].userId === verified.orgUserId && paid3[0].amount === DOWN_FEE, JSON.stringify(paid3))
    check(`3: shop ${shopBefore3} -> ${shopBefore3 + DOWN_FEE}`,
      (await bal(verified.orgUserId)) === shopBefore3 + DOWN_FEE, String(await bal(verified.orgUserId)))
    await shopEarnedNothing(verified.orgUserId, trade3, "3")
    check("3: a replayed submit completes nothing twice",
      (await call(`/api/trades/${trade3}/confirm/submit`, { token: p3.token, method: "POST", body: { code: "000000" } })).status === 200
        && (await ledgerRows({ tradeId: trade3, type: "BRIDGE_FEE_PAID" })).length === 1)
    await letQuestsSettle()
    await invariant("after 3")

    // ── 4 ────────────────────────────────────────────────────────────────────
    head("4  settle-then-rate: staff rate trade 1 AS THE SHOP")
    const ledgerSnapshot = async () => ({
      rows: await prisma.leafTransaction.count(),
      sum: (await prisma.leafTransaction.aggregate({ _sum: { amount: true } }))._sum.amount ?? 0,
      balances: (await prisma.user.aggregate({ _sum: { leaves: true } }))._sum.leaves ?? 0,
    })
    const before4 = await ledgerSnapshot()
    const p1RatingBefore = (await prisma.user.findUniqueOrThrow({ where: { id: p1.id }, select: { rating: true } })).rating

    const noHeader = await call("/api/reviews", { token: staff.token, method: "POST", body: { tradeId: trade1, stars: 4 } })
    check("4: WITHOUT the header, staff are not a party to the trade (403)", noHeader.status === 403, brief(noHeader))

    const r1 = await call("/api/reviews", {
      token: staff.token, orgId: verified.organizationId, method: "POST", body: { tradeId: trade1, stars: 4, comment: "smooth" },
    })
    check("4: staff, acting as the shop, rate the trade", r1.status === 200 && typeof r1.body.reviewId === "string", brief(r1))
    const rev1 = await prisma.review.findUnique({ where: { id: String(r1.body.reviewId) }, select: { reviewerId: true, revieweeId: true, rating: true } })
    check("4: reviewer is the SHOP's backing row, not the staff member", rev1?.reviewerId === verified.orgUserId, JSON.stringify(rev1))
    check("4: reviewee is the person", rev1?.revieweeId === p1.id && rev1?.rating === 4, JSON.stringify(rev1))
    const p1RatingAfter = (await prisma.user.findUniqueOrThrow({ where: { id: p1.id }, select: { rating: true } })).rating
    check("4: the person's rating moved to 4", p1RatingAfter === 4, `${p1RatingBefore} -> ${p1RatingAfter}`)
    const staffGave = await prisma.review.count({ where: { reviewerId: { in: [staff.id, owner.id] } } })
    check("4: no review is attributed to any human member", staffGave === 0, String(staffGave))
    const n1 = await prisma.notification.findFirst({ where: { userId: p1.id, type: "NEW_REVIEW" }, select: { actorId: true } })
    check("4: the person's NEW_REVIEW is from the shop", n1?.actorId === verified.orgUserId, String(n1?.actorId))

    const dup = await call("/api/reviews", {
      token: owner.token, orgId: verified.organizationId, method: "POST", body: { tradeId: trade1, stars: 1 },
    })
    check("4: the OWNER, as the same shop, is refused 409 (one side, one review)", dup.status === 409, brief(dup))

    const shopHistory = await call("/api/v1/trades?tab=history&limit=50", { token: staff.token, orgId: verified.organizationId })
    const hist = ((shopHistory.body.data as Record<string, unknown>)?.trades ?? []) as { id: string; myReview?: { rating: number } | null }[]
    check("4: the shop's history shows myReview = 4 (rate screen reads 'already rated')",
      hist.find((t) => t.id === trade1)?.myReview?.rating === 4, brief(shopHistory))

    await letQuestsSettle()
    const after4 = await ledgerSnapshot()
    check("4: the shop's review wrote NO ledger rows anywhere in the schema", after4.rows === before4.rows, `${before4.rows} -> ${after4.rows}`)
    check("4: ledger sum and SUM(User.leaves) unchanged",
      after4.sum === before4.sum && after4.balances === before4.balances, JSON.stringify({ before4, after4 }))
    await shopEarnedNothing(verified.orgUserId, trade1, "4")
    check("4: the staff member's balance did not move", (await bal(staff.id)) === staffStart)

    head("4d  the person rates the shop back")
    const p1BalBefore = await bal(p1.id)
    const r2 = await call("/api/reviews", { token: p1.token, method: "POST", body: { tradeId: trade1, stars: 5 } })
    check("4d: the person rates the shop", r2.status === 200, brief(r2))
    const shopRating = (await prisma.user.findUniqueOrThrow({ where: { id: verified.orgUserId }, select: { rating: true } })).rating
    check("4d: the SHOP's rating is 5", shopRating === 5, String(shopRating))
    const bell = await call("/api/v1/notifications?limit=50", { token: staff.token, orgId: verified.organizationId })
    const bellTypes = (((bell.body.data as Record<string, unknown>)?.notifications ?? []) as { type: string }[]).map((n) => n.type)
    check("4d: the shop's bell lists NEW_REVIEW", bellTypes.includes("NEW_REVIEW"), brief(bell))
    check("4d: the shop's bell lists TRADE_COMPLETED", bellTypes.includes("TRADE_COMPLETED"), JSON.stringify(bellTypes))
    await letQuestsSettle()
    const p1Rows = await ledgerRows({ userId: p1.id, createdAt: { gt: new Date(Date.now() - 60_000) }, type: { not: "TRADE_REWARD" } })
    console.log(`  info  the PERSON's own review: balance ${p1BalBefore} -> ${await bal(p1.id)}, recent non-reward rows ${JSON.stringify(p1Rows)}`)
    check("4d: anything the person's review moved is a QUEST_REWARD to the person (pre-existing quest)",
      p1Rows.every((r) => r.type === "QUEST_REWARD")
        && (await bal(p1.id)) - p1BalBefore === p1Rows.reduce((a, r) => a + r.amount, 0), JSON.stringify(p1Rows))
    await invariant("after 4")

    // v2: "joins the shop" is taking it over -- ownership is the only membership.
    head("4f  taken over later: p3 becomes the shop's owner AFTER trade 3 completed")
    await prisma.organization.update({ where: { id: verified.organizationId }, data: { ownerId: p3.id } })
    const self = await call("/api/reviews", {
      token: p3.token, orgId: verified.organizationId, method: "POST", body: { tradeId: trade3, stars: 5 },
    })
    check("4f: as the shop, rating their own trade is refused SHOP_MEMBER_SELF_TRADE",
      self.status === 403 && self.body.code === "SHOP_MEMBER_SELF_TRADE", brief(self))
    const selfPerson = await call("/api/reviews", { token: p3.token, method: "POST", body: { tradeId: trade3, stars: 5 } })
    check("4f: as the person, rating their new employer is refused too",
      selfPerson.status === 403 && selfPerson.body.code === "SHOP_MEMBER_SELF_TRADE", brief(selfPerson))
    const t3Reviews = await prisma.review.count({ where: { tradeId: trade3 } })
    check("4f: no review written on trade 3", t3Reviews === 0, String(t3Reviews))
    await invariant("after 4f")
  } finally {
    await prisma.review.deleteMany({ where: { OR: [{ reviewerId: { in: users } }, { revieweeId: { in: users } }] } })
    await prisma.leafTransaction.deleteMany({ where: { userId: { in: users } } })
      await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: users } }, { actorId: { in: users } }] } })
    await prisma.message.deleteMany({ where: { OR: [{ senderId: { in: users } }, { receiverId: { in: users } }] } })
    await prisma.trade.deleteMany({ where: { OR: [{ senderId: { in: users } }, { receiverId: { in: users } }] } })
    await prisma.item.deleteMany({ where: { userId: { in: users } } })
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } })
    await prisma.user.deleteMany({ where: { id: { in: users } } })
    await invariant("after cleanup").catch(() => {})
    await prisma.$disconnect()
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
