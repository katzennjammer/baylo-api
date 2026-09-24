// Acceptance harness for the daily Premium/VIP Leaves allowance (23 Sep 2026).
//
// RUNS AGAINST A SCRATCH SCHEMA:
//   .\scripts\scratch.ps1 -Run scripts\verify-tier-grant.ts
//
// What it pins down, in order:
//   1  a non-subscriber is paid nothing
//   2  a live Premium subscriber is paid PREMIUM_DAILY_LEAVES, once
//   3  a second call the same UTC day pays nothing more
//   4  a live VIP subscriber is paid VIP_DAILY_LEAVES, not both amounts
//   5  a new UTC day pays again
//   6  every credit writes exactly one TIER_DAILY_GRANT ledger row that
//      explains it, so leaves == SUM(LeafTransaction.amount) keeps holding

import prisma from "../src/lib/prisma"
import { claimDailyTierGrant, PREMIUM_DAILY_LEAVES, VIP_DAILY_LEAVES } from "../src/lib/tier-grant"
import { requireScratchSchema } from "./lib/live-guard"

const P = "ZZTIERGRANT_"
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
  await prisma.user.deleteMany({ where: { email: { startsWith: P } } })
}

async function grantRowCount(userId: string): Promise<number> {
  return prisma.leafTransaction.count({ where: { userId, type: "TIER_DAILY_GRANT" } })
}

async function main() {
  requireScratchSchema("scripts/verify-tier-grant.ts")
  await cleanup()

  const day1 = new Date("2026-09-23T08:00:00Z")
  const day1Later = new Date("2026-09-23T20:00:00Z")
  const day2 = new Date("2026-09-24T08:00:00Z")

  head("1  no subscription")
  const free = await prisma.user.create({
    data: { name: "Free", email: `${P}free@example.com`, isVerified: true, leaves: 0 },
  })
  check("pays nothing", (await claimDailyTierGrant(free.id, day1)) === 0)
  check("no ledger row", (await grantRowCount(free.id)) === 0)

  head("2  a live Premium subscriber")
  const premium = await prisma.user.create({
    data: {
      name: "Premium", email: `${P}premium@example.com`, isVerified: true, leaves: 0,
      // Comfortably past both fixture days below, not just "now" -- the
      // fixture dates are fixed 2026 timestamps, not relative to wall-clock
      // time, so the subscription must outlive them regardless of when this
      // harness actually runs.
      premiumUntil: new Date("2027-01-01T00:00:00Z"),
    },
  })
  check(`pays PREMIUM_DAILY_LEAVES (${PREMIUM_DAILY_LEAVES})`, (await claimDailyTierGrant(premium.id, day1)) === PREMIUM_DAILY_LEAVES)
  const afterFirst = await prisma.user.findUniqueOrThrow({ where: { id: premium.id }, select: { leaves: true, lifetimeLeaves: true } })
  check("both balances moved", afterFirst.leaves === PREMIUM_DAILY_LEAVES && afterFirst.lifetimeLeaves === PREMIUM_DAILY_LEAVES)
  check("exactly one ledger row", (await grantRowCount(premium.id)) === 1)

  head("3  same UTC day, called again")
  check("pays nothing more", (await claimDailyTierGrant(premium.id, day1Later)) === 0)
  const stillOne = await prisma.user.findUniqueOrThrow({ where: { id: premium.id }, select: { leaves: true } })
  check("balance unchanged", stillOne.leaves === PREMIUM_DAILY_LEAVES)
  check("still exactly one ledger row", (await grantRowCount(premium.id)) === 1)

  head("4  a live VIP subscriber, also Premium")
  const both = await prisma.user.create({
    data: {
      name: "Both", email: `${P}both@example.com`, isVerified: true, leaves: 0,
      premiumUntil: new Date("2027-01-01T00:00:00Z"),
      vipUntil: new Date("2027-01-01T00:00:00Z"),
    },
  })
  check(`pays VIP_DAILY_LEAVES (${VIP_DAILY_LEAVES}), not both amounts`, (await claimDailyTierGrant(both.id, day1)) === VIP_DAILY_LEAVES)
  const bothBalance = await prisma.user.findUniqueOrThrow({ where: { id: both.id }, select: { leaves: true } })
  check("balance is exactly the VIP amount", bothBalance.leaves === VIP_DAILY_LEAVES)

  head("5  the next UTC day")
  check("pays again", (await claimDailyTierGrant(premium.id, day2)) === PREMIUM_DAILY_LEAVES)
  const afterDay2 = await prisma.user.findUniqueOrThrow({ where: { id: premium.id }, select: { leaves: true } })
  check("balance now two days' worth", afterDay2.leaves === PREMIUM_DAILY_LEAVES * 2)
  check("two ledger rows now", (await grantRowCount(premium.id)) === 2)

  head("6  an expired subscription")
  const lapsed = await prisma.user.create({
    data: {
      name: "Lapsed", email: `${P}lapsed@example.com`, isVerified: true, leaves: 0,
      premiumUntil: new Date(Date.now() - 86_400_000),
    },
  })
  check("pays nothing", (await claimDailyTierGrant(lapsed.id, day1)) === 0)

  await cleanup()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error(e)
  await cleanup().catch(() => {})
  process.exit(1)
})
