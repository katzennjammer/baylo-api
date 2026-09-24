// Acceptance harness for the PREMIUM_SUBSCRIBER achievement criterion
// (24 Sep 2026).
//
// RUNS AGAINST A SCRATCH SCHEMA:
//   .\scripts\scratch.ps1 -Run scripts\verify-premium-achievement.ts
//
// What it pins down, in order:
//   1  a non-subscriber does not earn it
//   2  a live Premium subscriber does
//   3  VIP is a superset: a VIP-only user also earns it
//   4  PERMANENCE: once earned, letting the subscription lapse does NOT
//      revoke the badge -- the engine's existing "nothing un-grants a
//      UserAchievement" rule, exercised for this criterion specifically

import prisma from "../src/lib/prisma"
import { evaluateAchievements } from "../src/lib/achievements"
import { requireScratchSchema } from "./lib/live-guard"

const P = "ZZPREMACH_"
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

async function hasBadge(userId: string): Promise<boolean> {
  const views = await evaluateAchievements(userId)
  return views.some((v) => v.criterion === "PREMIUM_SUBSCRIBER" && v.unlocked)
}

async function main() {
  requireScratchSchema("scripts/verify-premium-achievement.ts")
  await cleanup()

  // The badge definition itself -- this harness does not depend on
  // seed-premium-achievement.ts having run, so it creates its own copy and
  // cleans it up, the same isolation every other criterion's badge would need
  // to be tested at all.
  const def = await prisma.achievement.upsert({
    where: { key: `${P}premium_member` },
    create: {
      key: `${P}premium_member`, name: "Test Premium Member", description: "x",
      icon: "⭐", criterion: "PREMIUM_SUBSCRIBER", threshold: 1, points: 15, isActive: true,
    },
    update: { isActive: true },
  })

  const future = new Date(Date.now() + 86_400_000)
  const past = new Date(Date.now() - 86_400_000)

  head("1  a non-subscriber")
  const free = await prisma.user.create({
    data: { name: "Free", email: `${P}free@example.com`, isVerified: true, leaves: 0 },
  })
  check("does not earn PREMIUM_SUBSCRIBER", !(await hasBadge(free.id)))

  head("2  a live Premium subscriber")
  const premiumUser = await prisma.user.create({
    data: { name: "Premium", email: `${P}premium@example.com`, isVerified: true, leaves: 0, premiumUntil: future },
  })
  check("earns PREMIUM_SUBSCRIBER", await hasBadge(premiumUser.id))

  head("3  VIP is a superset")
  const vipUser = await prisma.user.create({
    data: { name: "Vip", email: `${P}vip@example.com`, isVerified: true, leaves: 0, vipUntil: future },
  })
  check("a VIP-only user (no premiumUntil) also earns it", await hasBadge(vipUser.id))

  head("4  permanence after lapse")
  await prisma.user.update({ where: { id: premiumUser.id }, data: { premiumUntil: past } })
  check("still shows unlocked after the subscription lapses", await hasBadge(premiumUser.id))
  const row = await prisma.userAchievement.findUnique({
    where: { userId_achievementId: { userId: premiumUser.id, achievementId: def.id } },
  })
  check("the UserAchievement row itself still exists", row !== null)

  await prisma.userAchievement.deleteMany({ where: { achievementId: def.id } })
  await prisma.achievement.delete({ where: { id: def.id } })
  await cleanup()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error(e)
  await cleanup().catch(() => {})
  process.exit(1)
})
