// Grants or ends a Premium or VIP Subscription row by hand, so both sides of
// the premium/VIP gates can be demonstrated before Play Billing exists.
//
// Run from the baylo-api/ directory (or via scripts/set-premium.ps1, which
// wraps this with the old flag names):
//   npx tsx --env-file=.env scripts/set-tier.ts jmjumuad2@gmail.com                    # premium, LIFETIME (beta)
//   npx tsx --env-file=.env scripts/set-tier.ts jmjumuad2@gmail.com --tier vip         # vip, 30 days
//   npx tsx --env-file=.env scripts/set-tier.ts jmjumuad2@gmail.com --days 7           # premium, timed (demos/tests)
//   npx tsx --env-file=.env scripts/set-tier.ts jmjumuad2@gmail.com --clear            # back to not subscribed
//   npx tsx --env-file=.env scripts/set-tier.ts                                        # list current subscribers
//
// This is the ONLY writer of the Subscription table. When a real subscription lands,
// the Play Billing verifier replaces it and nothing else has to change: every
// reader goes through isPremium()/isVip() in src/lib/premium.ts.
//
// PROVISIONAL -- BETA PRICING (30 Sep 2026): Premium is a one-time ₱199
// LIFETIME purchase during the beta, so a premium grant with no --days writes
// PREMIUM_LIFETIME_UNTIL (see src/lib/premium.ts), not a dated expiry. When
// real pricing is decided this default changes with it. VIP is not sold yet
// and keeps a dated default.
//
// Writes a row, so it goes through requireScratchSchema() like every other
// script here: refuses `public` (the live database) unless `--live` is typed.

import prisma from "../src/lib/prisma"
import { isLifetimePremium, PREMIUM_LIFETIME_UNTIL } from "../src/lib/premium"
import { requireScratchSchema } from "./lib/live-guard"

type Tier = "premium" | "vip"

function parseArgs(argv: string[]) {
  const positional: string[] = []
  let tier: Tier = "premium"
  let days: number | null = null
  let clear = false

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--live") continue // consumed by requireScratchSchema()
    if (a === "--clear") { clear = true; continue }
    if (a === "--tier") { tier = argv[++i] as Tier; continue }
    if (a === "--days") { days = Number(argv[++i]); continue }
    positional.push(a)
  }

  if (tier !== "premium" && tier !== "vip") {
    throw new Error(`--tier must be "premium" or "vip", got "${tier}"`)
  }
  if (days !== null && (!Number.isFinite(days) || days <= 0)) {
    throw new Error(`--days must be a positive number, got "${days}"`)
  }

  return { email: positional[0], tier, days, clear }
}

async function main() {
  requireScratchSchema("scripts/set-tier.ts")

  const { email, tier, days, clear } = parseArgs(process.argv.slice(2))
  const dbTier = tier === "premium" ? "PREMIUM" : "VIP"

  if (!email) {
    const now = new Date()
    for (const t of ["PREMIUM", "VIP"] as const) {
      console.log(`${t} subscribers (a Subscription row ending in the future):`)
      for (const row of await prisma.subscription.findMany({
        where: { tier: t, endsAt: { gt: now } },
        select: { endsAt: true, user: { select: { email: true } } },
        orderBy: { endsAt: "desc" },
      })) {
        console.log(`  ${row.user.email}  ${isLifetimePremium(row.endsAt) ? "lifetime (beta)" : row.endsAt.toISOString()}`)
      }
      console.log()
    }
    return
  }

  // Premium with no --days is the beta lifetime grant; VIP with no --days is 30.
  const lifetime = !clear && tier === "premium" && days === null
  const grantDays = days ?? 30
  const now = new Date()
  const endsAt = lifetime ? PREMIUM_LIFETIME_UNTIL : new Date(now.getTime() + grantDays * 24 * 60 * 60 * 1000)

  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
  await prisma.$transaction(async (tx) => {
    // End whatever term of this tier is running, so the new grant REPLACES it
    // (a 7-day demo grant must be able to shorten a lifetime one). Ended, not
    // deleted: the rows are the history.
    await tx.subscription.updateMany({
      where: { userId: user.id, tier: dbTier, endsAt: { gt: now } },
      data: { endsAt: now },
    })
    if (!clear) await tx.subscription.create({ data: { userId: user.id, tier: dbTier, startsAt: now, endsAt } })
  })

  console.log(
    clear
      ? `Ended the ${dbTier} subscription for ${email}`
      : lifetime
        ? `Granted ${dbTier} = LIFETIME (beta sentinel ${PREMIUM_LIFETIME_UNTIL.toISOString()}) to ${email}`
        : `Granted ${dbTier} for ${grantDays} days to ${email}`,
  )
  console.log(await prisma.subscription.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } }))
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
