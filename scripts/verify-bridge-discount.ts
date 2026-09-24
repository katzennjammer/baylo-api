// Acceptance harness for the Premium bridging-fee discount (24 Sep 2026).
//
// RUNS AGAINST A SCRATCH SCHEMA:
//   .\scripts\scratch.ps1 -Run scripts\verify-bridge-discount.ts
//
// What it pins down, in order:
//   1  bridgingFee() / offerTerms(): the pure math, standard vs premium rate
//   2  assessOffer(), up-bridge: a Premium PROPOSER is charged the discounted
//      rate; a non-subscriber proposer pays the standard rate against the
//      same pair of items
//   3  assessOffer(), down-bridge: a Premium RECEIVER (listing owner) is
//      charged the discounted rate on THEIR side, independent of the
//      proposer's own subscription
//   4  VIP is a superset: a VIP-only payer (no premiumUntil set) also gets
//      the discount
//   5  an expired subscription pays the standard rate, not the discount
//   6  same-bracket offers are unaffected: fee is 0 regardless of subscription

import prisma from "../src/lib/prisma"
import { bridgingFee, offerTerms, BRIDGE_FEE_PER_BRACKET, PREMIUM_BRIDGE_FEE_PER_BRACKET } from "../src/lib/trade-rules"
import { assessOffer } from "../src/lib/offer-check"
import { requireScratchSchema } from "./lib/live-guard"

const P = "ZZBRIDGE_"
let pass = 0
let fail = 0

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}   ${detail}`)
  }
}
function head(s: string) {
  console.log(`\n── ${s} ${"─".repeat(Math.max(0, 66 - s.length))}`)
}

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: P } }, select: { id: true } })
  const ids = users.map((u) => u.id)
  if (ids.length) {
    await prisma.item.deleteMany({ where: { userId: { in: ids } } })
    await prisma.user.deleteMany({ where: { id: { in: ids } } })
  }
}

function mkItem(ownerId: string, title: string, valueLeaves: number) {
  return prisma.item.create({
    data: {
      title: `${P}${title}`, description: "x", images: "[]",
      category: "OTHER", condition: "GOOD", valueLeaves, userId: ownerId,
    },
  })
}

async function main() {
  requireScratchSchema("scripts/verify-bridge-discount.ts")
  await cleanup()

  head("1  the pure math")
  check("standard rate is 10/bracket", BRIDGE_FEE_PER_BRACKET === 10)
  check("premium rate is 8/bracket", PREMIUM_BRIDGE_FEE_PER_BRACKET === 8)
  check("bridgingFee(3) standard = 30", bridgingFee(3) === 30)
  check("bridgingFee(3, premium) = 24", bridgingFee(3, true) === 24)
  const std = offerTerms(2, 3) // bridgeUp: proposer's bracket 2 is the fee bracket
  check("offerTerms bridgeUp standard fee = 20", std.fee === 20, String(std.fee))
  const prem = offerTerms(2, 3, true)
  check("offerTerms bridgeUp premium fee = 16", prem.fee === 16, String(prem.fee))
  check("premium does not change legality or payer", prem.legality === std.legality && prem.payer === std.payer)

  // ── fixtures ──
  const future = new Date(Date.now() + 86_400_000)
  const past = new Date(Date.now() - 86_400_000)

  const free = await prisma.user.create({
    data: { name: "Free", email: `${P}free@example.com`, isVerified: true, leaves: 0 },
  })
  const premiumUser = await prisma.user.create({
    data: { name: "Premium", email: `${P}premium@example.com`, isVerified: true, leaves: 0, premiumUntil: future },
  })
  const vipOnly = await prisma.user.create({
    data: { name: "VipOnly", email: `${P}vip@example.com`, isVerified: true, leaves: 0, vipUntil: future },
  })
  const lapsed = await prisma.user.create({
    data: { name: "Lapsed", email: `${P}lapsed@example.com`, isVerified: true, leaves: 0, premiumUntil: past },
  })
  const owner = await prisma.user.create({
    data: { name: "Owner", email: `${P}owner@example.com`, isVerified: true, leaves: 0 },
  })

  // bracket 2 (101-250) and bracket 3 (251-500): one apart, a bridge either way.
  const b2 = await mkItem(owner.id, "b2-owner", 200)
  const b3 = await mkItem(owner.id, "b3-owner", 400)

  head("2  up-bridge: the PROPOSER pays")
  const freeB2 = await mkItem(free.id, "b2-free", 200)
  const premiumB2 = await mkItem(premiumUser.id, "b2-premium", 200)

  const freeUpBridge = await assessOffer(prisma, { proposerId: free.id, offeredItemId: freeB2.id, targetItemId: b3.id })
  check("non-subscriber proposer: standard fee (20)", freeUpBridge.ok && freeUpBridge.fee === 20, JSON.stringify(freeUpBridge))
  check("non-subscriber proposer: they are the payer", freeUpBridge.ok && freeUpBridge.payer === "proposer")

  const premiumUpBridge = await assessOffer(prisma, { proposerId: premiumUser.id, offeredItemId: premiumB2.id, targetItemId: b3.id })
  check("Premium proposer: discounted fee (16)", premiumUpBridge.ok && premiumUpBridge.fee === 16, JSON.stringify(premiumUpBridge))

  head("3  down-bridge: the RECEIVER (listing owner) pays")
  const premiumOwnerB2 = await mkItem(premiumUser.id, "b2-premium-owner", 200)
  const freeDownBridge = await assessOffer(prisma, { proposerId: owner.id, offeredItemId: b3.id, targetItemId: premiumOwnerB2.id })
  check(
    "the RECEIVER's subscription prices it, not the proposer's (owner here has none, but IS the proposer)",
    freeDownBridge.ok && freeDownBridge.payer === "receiver" && freeDownBridge.fee === 16,
    JSON.stringify(freeDownBridge),
  )

  const ownerB2 = await mkItem(owner.id, "b2-owner-2", 200)
  const premiumB3 = await mkItem(premiumUser.id, "b3-premium-proposer", 400)
  const nonPremiumDownBridge = await assessOffer(prisma, { proposerId: premiumUser.id, offeredItemId: premiumB3.id, targetItemId: ownerB2.id })
  check(
    "a non-subscribing RECEIVER pays standard, even though the PROPOSER is Premium",
    nonPremiumDownBridge.ok && nonPremiumDownBridge.payer === "receiver" && nonPremiumDownBridge.fee === 20,
    JSON.stringify(nonPremiumDownBridge),
  )

  head("4  VIP is a superset")
  const vipB2 = await mkItem(vipOnly.id, "b2-vip", 200)
  const vipUpBridge = await assessOffer(prisma, { proposerId: vipOnly.id, offeredItemId: vipB2.id, targetItemId: b3.id })
  check("a VIP-only payer (no premiumUntil) also gets the discount", vipUpBridge.ok && vipUpBridge.fee === 16, JSON.stringify(vipUpBridge))

  head("5  an expired subscription pays standard")
  const lapsedB2 = await mkItem(lapsed.id, "b2-lapsed", 200)
  const lapsedUpBridge = await assessOffer(prisma, { proposerId: lapsed.id, offeredItemId: lapsedB2.id, targetItemId: b3.id })
  check("expired premiumUntil: standard fee (20)", lapsedUpBridge.ok && lapsedUpBridge.fee === 20, JSON.stringify(lapsedUpBridge))

  head("6  same bracket: unaffected")
  const premiumB3ForSame = await mkItem(premiumUser.id, "b3-premium", 400)
  const sameBracket = await assessOffer(prisma, { proposerId: premiumUser.id, offeredItemId: premiumB3ForSame.id, targetItemId: b3.id })
  check("same bracket: fee 0 regardless of subscription", sameBracket.ok && sameBracket.fee === 0 && sameBracket.legality === "same")

  await cleanup()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error(e)
  await cleanup().catch(() => {})
  process.exit(1)
})
