/**
 * A bridge offer to an ORGANISATION's listing: the held fee comes back.
 *
 * RUNS AGAINST A SCRATCH SCHEMA, with a dev server on the same schema:
 *   .\scripts\scratch.ps1 -Push -Name scratch_http
 *   .\scripts\scratch.ps1 -Dev  -Name scratch_http -Port 3100      (other terminal)
 *   $env:BAYLO_BASE_URL="http://127.0.0.1:3100"
 *   .\scripts\scratch.ps1 -Run scripts\verify-org-bridge-release-http.ts -Name scratch_http -Keep
 *
 * ── WHY THIS CASE EXISTS (25 Sep 2026) ───────────────────────────────────────
 *
 * A person can send an offer to an org's listing, but nobody can accept or
 * decline it: every route after the offer acts as the signed-in human, and no
 * human IS the org's backing row. See verify-org-trading-http.ts. So a
 * proposer-paid bridge offer to an org holds the sender's fee on an offer that
 * only the SENDER, or the clock, can ever close. This pins down that both of
 * those paths give the fee back, exactly once, and that the org is paid
 * nothing:
 *
 *   1  the offer holds the fee: sender -10, one BRIDGE_FEE_HOLD row
 *   2  org staff cannot close it (403), and nothing moves
 *   3  WITHDRAW: sender +10, one BRIDGE_FEE_RELEASE row, offer WITHDRAWN
 *   4  a second withdraw is refused and releases nothing
 *   5  EXPIRY: an offer past OFFER_EXPIRY_DAYS is swept, and refunded once
 *   6  the org's balance never moved; nothing left in escrow; the ledger
 *      invariant holds with the test rows present
 *
 * ── QUEST PAYOUTS ARE SUBTRACTED, NOT IGNORED ────────────────────────────────
 *
 * Sending an offer also settles the sender's daily quests in the background
 * (settleQuestsAsync, 25 Sep 2026), and a bridge offer can complete "Send a
 * trade offer" and "Bridge a value gap". Those are real QUEST_REWARD Leaves,
 * not fee movement, so each balance check is on `feeBalance` (balance minus
 * QUEST_REWARD rows) after the hook has had time to land, and section 6 checks
 * that QUEST_REWARD is the ONLY other thing that moved the sender's Leaves.
 *
 * Driven over HTTP, per the house convention: this guards POST /api/offers and
 * POST /api/v1/offers/[id]/withdraw themselves, with bridge-fee.ts unchanged.
 */
import prisma from "../src/lib/prisma"
import { createOrganization } from "../src/lib/organizations"
import { signAccessToken } from "../src/lib/auth-tokens"
import { TRADING_POLICY_VERSION, feeForOffer } from "../src/lib/trade-rules"
import { bracketOf } from "../src/lib/brackets"
import { heldBridgeFees } from "../src/lib/bridge-fee"
import { OFFER_EXPIRY_DAYS } from "../src/lib/offers"
import { requireScratchSchema } from "./lib/live-guard"

const BASE = process.env.BAYLO_BASE_URL ?? "http://127.0.0.1:3100"

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `   ${detail}` : ""}`) }
}
const head = (s: string) => console.log(`\n── ${s}`)

async function call(path: string, opts: { token: string; orgId?: string; method?: string; body?: unknown }) {
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

const LOW = 50 // bracket 1
const HIGH = 200 // bracket 2
const START = 50

async function main() {
  requireScratchSchema("scripts/verify-org-bridge-release-http.ts")
  try {
    await fetch(`${BASE}/api/v1/hubs`)
  } catch {
    console.error(`No server at ${BASE}.`)
    process.exit(2)
  }

  const tag = `verify-org-bridge-${Date.now()}`
  const users: string[] = []
  const orgs: string[] = []

  const FEE = feeForOffer(bracketOf(LOW), bracketOf(HIGH))
  if (!FEE || FEE <= 0) throw new Error(`fixture is not a proposer-paid bridge (fee ${FEE})`)

  const bal = async (id: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { id }, select: { leaves: true } })).leaves
  const questPaid = async (id: string) =>
    (await prisma.leafTransaction.aggregate({ where: { userId: id, type: "QUEST_REWARD" }, _sum: { amount: true } }))
      ._sum.amount ?? 0
  /** The balance with quest payouts taken out: what the fee alone did. */
  const feeBalance = async (id: string) => (await bal(id)) - (await questPaid(id))
  /** Let the fire-and-forget quest hook from an offer POST land. */
  const letQuestsSettle = () => new Promise((r) => setTimeout(r, 2500))
  const rows = (offerId: string, type: "BRIDGE_FEE_HOLD" | "BRIDGE_FEE_RELEASE" | "BRIDGE_FEE_PAID") =>
    prisma.leafTransaction.findMany({ where: { offerId, type }, select: { userId: true, amount: true } })

  try {
    // ── fixtures ──
    const sender = await prisma.user.create({
      data: {
        name: `${tag}-sender`, email: `${tag}-sender@test.invalid`,
        isVerified: true, idVerifiedGrandfatheredAt: new Date(),
        leaves: START, lifetimeLeaves: START,
      },
      select: { id: true },
    })
    users.push(sender.id)
    // The balance's matching ledger row, so the invariant holds DURING the run.
    await prisma.leafTransaction.create({
      data: { userId: sender.id, type: "SIGNUP_GRANT", amount: START, description: "test seed", eventAt: new Date() },
    })
    const owner = await prisma.user.create({
      data: { name: `${tag}-owner`, email: `${tag}-owner@test.invalid`, isVerified: true, idVerifiedGrandfatheredAt: new Date() },
      select: { id: true },
    })
    users.push(owner.id)

    const org = await createOrganization({ founderUserId: owner.id, name: `${tag} Store`, businessCategory: "SARI_SARI" })
    orgs.push(org.organizationId)
    users.push(org.orgUserId)
    await prisma.organization.update({ where: { id: org.organizationId }, data: { verificationStatus: "VERIFIED" } })
    const orgStart = await bal(org.orgUserId)

    const item = (userId: string, title: string, valueLeaves: number) =>
      prisma.item.create({
        data: { title: `${tag} ${title}`, description: "x", images: "[]", category: "OTHER", condition: "GOOD", valueLeaves, userId },
        select: { id: true },
      })
    const mine1 = await item(sender.id, "mug", LOW)
    const mine2 = await item(sender.id, "lamp", LOW)
    const orgListing1 = await item(org.orgUserId, "rice", HIGH)
    const orgListing2 = await item(org.orgUserId, "sugar", HIGH)

    const senderToken = await signAccessToken(sender.id)
    const ownerToken = await signAccessToken(owner.id)
    const consent = { accepted: true, policyVersion: TRADING_POLICY_VERSION }

    // ── 1 ──
    head(`1  a bridge offer to the org's listing holds the fee (${FEE} Leaves)`)
    const sent = await call("/api/offers", {
      token: senderToken, method: "POST",
      body: { postId: orgListing1.id, offeredItemId: mine1.id, consent },
    })
    check("offer created", sent.status === 201, `status ${sent.status} ${JSON.stringify(sent.body).slice(0, 200)}`)
    if (sent.status !== 201) throw new Error("cannot continue without the offer")
    await letQuestsSettle()
    const offerId = String(sent.body.offerId)
    check("the proposer is the payer", sent.body.bridgeFeePayer === "proposer", String(sent.body.bridgeFeePayer))
    check(`charged ${FEE}`, sent.body.chargedLeaves === FEE, String(sent.body.chargedLeaves))
    const row = await prisma.offer.findUniqueOrThrow({ where: { id: offerId }, select: { receiverId: true } })
    check("the receiver is the org's backing row", row.receiverId === org.orgUserId)
    check(`sender balance ${START} -> ${START - FEE}`, (await feeBalance(sender.id)) === START - FEE, String(await feeBalance(sender.id)))
    const holds = await rows(offerId, "BRIDGE_FEE_HOLD")
    check("exactly one BRIDGE_FEE_HOLD row, -FEE, on the sender",
      holds.length === 1 && holds[0].amount === -FEE && holds[0].userId === sender.id, JSON.stringify(holds))
    check("heldBridgeFees(sender) reports it", (await heldBridgeFees(prisma, sender.id)) === FEE)

    // ── 2 ──
    head("2  org staff cannot close it, and nothing moves")
    const decline = await call(`/api/offers/${offerId}`, {
      token: ownerToken, orgId: org.organizationId, method: "PATCH", body: { action: "decline" },
    })
    check("the org's owner, acting as the org, is refused", decline.status === 403, `status ${decline.status}`)
    check("sender still held", (await feeBalance(sender.id)) === START - FEE)
    check("no release row", (await rows(offerId, "BRIDGE_FEE_RELEASE")).length === 0)

    // ── 3 ──
    head("3  the sender withdraws: the fee comes back")
    const w1 = await call(`/api/v1/offers/${offerId}/withdraw`, { token: senderToken, method: "POST", body: {} })
    check("withdraw 200", w1.status === 200, `status ${w1.status} ${JSON.stringify(w1.body).slice(0, 200)}`)
    const after = await prisma.offer.findUniqueOrThrow({ where: { id: offerId }, select: { status: true } })
    check("offer WITHDRAWN", after.status === "WITHDRAWN", after.status)
    check(`sender balance back to ${START}`, (await feeBalance(sender.id)) === START, String(await feeBalance(sender.id)))
    const rel = await rows(offerId, "BRIDGE_FEE_RELEASE")
    check("exactly one BRIDGE_FEE_RELEASE row, +FEE, on the sender",
      rel.length === 1 && rel[0].amount === FEE && rel[0].userId === sender.id, JSON.stringify(rel))
    check("no BRIDGE_FEE_PAID row (nobody was paid)", (await rows(offerId, "BRIDGE_FEE_PAID")).length === 0)

    // ── 4 ──
    head("4  a second withdraw releases nothing")
    const w2 = await call(`/api/v1/offers/${offerId}/withdraw`, { token: senderToken, method: "POST", body: {} })
    check("refused with 409", w2.status === 409, `status ${w2.status}`)
    check("balance unchanged", (await feeBalance(sender.id)) === START)
    check("still exactly one release row", (await rows(offerId, "BRIDGE_FEE_RELEASE")).length === 1)

    // ── 5 ──
    head(`5  an offer nobody answers expires after ${OFFER_EXPIRY_DAYS} days and is refunded once`)
    const sent2 = await call("/api/offers", {
      token: senderToken, method: "POST",
      body: { postId: orgListing2.id, offeredItemId: mine2.id, consent },
    })
    check("second offer created", sent2.status === 201, `status ${sent2.status} ${JSON.stringify(sent2.body).slice(0, 200)}`)
    if (sent2.status === 201) {
      const offer2 = String(sent2.body.offerId)
      await letQuestsSettle()
      check("held again", (await feeBalance(sender.id)) === START - FEE)
      // Age it past the cutoff. createdAt is what expireStaleOffers() reads.
      await prisma.offer.update({
        where: { id: offer2 },
        data: { createdAt: new Date(Date.now() - (OFFER_EXPIRY_DAYS + 1) * 86_400_000) },
      })
      // The withdraw route sweeps stale offers FIRST, so the sweep wins and the
      // withdraw finds it already expired: one refund, from the expiry.
      const w3 = await call(`/api/v1/offers/${offer2}/withdraw`, { token: senderToken, method: "POST", body: {} })
      const o2 = await prisma.offer.findUniqueOrThrow({ where: { id: offer2 }, select: { status: true } })
      check("swept to EXPIRED", o2.status === "EXPIRED", o2.status)
      check("the withdraw then refuses (409)", w3.status === 409, `status ${w3.status}`)
      check(`sender balance back to ${START}`, (await feeBalance(sender.id)) === START, String(await feeBalance(sender.id)))
      const rel2 = await rows(offer2, "BRIDGE_FEE_RELEASE")
      check("exactly one release row, +FEE, on the sender",
        rel2.length === 1 && rel2[0].amount === FEE && rel2[0].userId === sender.id, JSON.stringify(rel2))
    }

    // ── 6 ──
    head("6  the org, escrow, and the ledger")
    check("the org's balance never moved", (await bal(org.orgUserId)) === orgStart, `${orgStart} -> ${await bal(org.orgUserId)}`)
    check("the org has no ledger rows from either offer",
      (await prisma.leafTransaction.count({ where: { userId: org.orgUserId, offerId: { not: null } } })) === 0)
    check("nothing left in escrow for the sender", (await heldBridgeFees(prisma, sender.id)) === 0)
    const other = await prisma.leafTransaction.findMany({
      where: { userId: sender.id, type: { notIn: ["SIGNUP_GRANT", "BRIDGE_FEE_HOLD", "BRIDGE_FEE_RELEASE"] } },
      select: { type: true, amount: true },
    })
    check("the only other movement on the sender is QUEST_REWARD",
      other.every((r) => r.type === "QUEST_REWARD"), JSON.stringify(other))
    console.log(`     (quest rewards paid to the sender: ${await questPaid(sender.id)} Leaves; raw balance ${await bal(sender.id)})`)
    const [u, l] = await Promise.all([
      prisma.user.aggregate({ _sum: { leaves: true } }),
      prisma.leafTransaction.aggregate({ _sum: { amount: true } }),
    ])
    check("SUM(User.leaves) == SUM(LeafTransaction.amount)", (u._sum.leaves ?? 0) === (l._sum.amount ?? 0),
      `${u._sum.leaves} vs ${l._sum.amount}`)
  } finally {
    await prisma.leafTransaction.deleteMany({ where: { userId: { in: users } } })
    await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: users } }, { actorId: { in: users } }] } })
    await prisma.message.deleteMany({ where: { OR: [{ senderId: { in: users } }, { receiverId: { in: users } }] } })
    await prisma.offer.deleteMany({ where: { OR: [{ senderId: { in: users } }, { receiverId: { in: users } }] } })
    await prisma.item.deleteMany({ where: { userId: { in: users } } })
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } })
    await prisma.user.deleteMany({ where: { id: { in: users } } })
    await prisma.$disconnect()
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
