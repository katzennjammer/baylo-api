/**
 * hasPremiumAccess() (src/lib/premium.ts): the one yes/no behind the PREMIUM
 * tag. Pure -- it reads Subscription rows and the clock, so no database:
 *
 *   npx tsx scripts/verify-premium-access.ts
 */
import { PREMIUM_LIFETIME_UNTIL, hasPremiumAccess, type SubscriptionRow } from "../src/lib/premium"

let failures = 0
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}`)
  }
}

const now = new Date("2026-11-13T00:00:00Z")
const day = 86_400_000
const future = new Date(now.getTime() + 30 * day)
const past = new Date(now.getTime() - 30 * day)
const row = (tier: SubscriptionRow["tier"], endsAt: Date): SubscriptionRow => ({ tier, endsAt })

check("no rows", !hasPremiumAccess([], now))
check("null and undefined read as no Premium", !hasPremiumAccess(null, now) && !hasPremiumAccess(undefined, now))
check("a live Premium term", hasPremiumAccess([row("PREMIUM", future)], now))
check("a lapsed Premium term", !hasPremiumAccess([row("PREMIUM", past)], now))
check("VIP alone counts (a superset)", hasPremiumAccess([row("VIP", future)], now))
check("a lapsed VIP term", !hasPremiumAccess([row("VIP", past)], now))
check("the beta lifetime grant", hasPremiumAccess([row("PREMIUM", PREMIUM_LIFETIME_UNTIL)], now))
check("an ended term beside a live one: live wins", hasPremiumAccess([row("PREMIUM", past), row("PREMIUM", future)], now))
check("lapsed Premium, live VIP", hasPremiumAccess([row("PREMIUM", past), row("VIP", future)], now))
check("a term ending this instant is over", !hasPremiumAccess([row("PREMIUM", now)], now))

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log("\nall premium access checks passed")
