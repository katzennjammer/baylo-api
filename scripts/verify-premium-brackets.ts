// Acceptance harness for value brackets and the premium gate (11 Sep 2026).
//
// RUNS AGAINST A SCRATCH DB. Point DATABASE_URL at one first — it creates and
// deletes rows, and the prefix-scoped cleanup is a safety net, not a licence:
//
//   mysql -u root -e "CREATE DATABASE baylo_premiumcheck"
//   DATABASE_URL="mysql://root@127.0.0.1:3306/baylo_premiumcheck" npx prisma db push
//   DATABASE_URL="mysql://root@127.0.0.1:3306/baylo_premiumcheck" npx tsx scripts/verify-premium-brackets.ts
//
// What it pins down, in order:
//   1  bracketOf() matches the table at every boundary, and the range inverts it
//   2  isPremium() is a DATE: null and past are false, future is true
//   3  enforcePremiumForListing() refuses a non-subscriber on bracket 7 with
//      code PREMIUM_REQUIRED, and passes brackets 6 and below
//   4  a live subscription passes bracket 7; an EXPIRED one does not
//   5  an unvalued listing passes — it has no bracket
//   6  ORDER: a New Trader (cap 600) on a bracket-7 listing gets
//      PREMIUM_REQUIRED, not TIER_ITEM_VALUE_CAP — the lock is a property of
//      the listing and must not change with the viewer's tier
//   7  the accept path is gated too, in the same order: a non-subscriber
//      accepting an offer OF a bracket-7 item gets PREMIUM_REQUIRED (with the
//      accept-side copy), ahead of the tier cap; a subscriber is capped only

import prisma from "../src/lib/prisma"
import {
  BRACKET_CEILINGS,
  BRACKET_COUNT,
  bracketOf,
  bracketRange,
  PREMIUM_MIN_BRACKET,
  valueNeedsPremium,
} from "../src/lib/brackets"
import { isPremium } from "../src/lib/premium"
import {
  enforceAcceptTrade,
  enforceInitiateTrade,
  enforcePremiumForListing,
  loadStanding,
} from "../src/lib/reputation-gate"

const P = "ZZPREMIUM_"
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

async function body(res: Response | null): Promise<{ code?: string; error?: string } | null> {
  if (!res) return null
  return (await res.json()) as { code?: string; error?: string }
}

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: P } }, select: { id: true } })
  const ids = users.map((u) => u.id)
  if (ids.length) {
    await prisma.item.deleteMany({ where: { userId: { in: ids } } })
    await prisma.user.deleteMany({ where: { id: { in: ids } } })
  }
}

async function main() {
  await cleanup()

  head("1  the table")
  check("1 → bracket 1", bracketOf(1) === 1)
  check("100 → bracket 1", bracketOf(100) === 1)
  check("101 → bracket 2", bracketOf(101) === 2)
  check("425 → bracket 3", bracketOf(425) === 3)
  check("2500 → bracket 6", bracketOf(2500) === 6)
  check("2501 → bracket 7 (the first premium bracket)", bracketOf(2501) === 7 && PREMIUM_MIN_BRACKET === 7)
  check("12000 → bracket 9", bracketOf(12000) === 9)
  check("12001 → bracket 10", bracketOf(12001) === 10 && BRACKET_COUNT === 10)
  check("0 and negatives land in bracket 1", bracketOf(0) === 1 && bracketOf(-5) === 1)
  let inverts = true
  for (let b = 1; b <= BRACKET_COUNT; b++) {
    const { min, max } = bracketRange(b)
    if (bracketOf(min) !== b) inverts = false
    if (max !== null && bracketOf(max) !== b) inverts = false
    if (max !== null && bracketOf(max + 1) !== b + 1) inverts = false
  }
  check("bracketRange() inverts bracketOf() at every boundary", inverts)
  check("ceilings are strictly increasing", BRACKET_CEILINGS.every((c, i) => i === 0 || c > BRACKET_CEILINGS[i - 1]))
  check("valueNeedsPremium(null) is false", valueNeedsPremium(null) === false)

  head("2  isPremium is a date")
  const now = new Date("2026-09-11T12:00:00Z")
  check("null → false", isPremium(null, now) === false)
  check("undefined → false", isPremium(undefined, now) === false)
  check("past → false", isPremium(new Date("2026-09-11T11:59:59Z"), now) === false)
  check("future → true", isPremium(new Date("2026-09-11T12:00:01Z"), now) === true)

  // ── fixtures ──
  const owner = await prisma.user.create({
    data: { name: "Owner", email: `${P}owner@example.com`, isVerified: true, leaves: 0 },
  })
  const free = await prisma.user.create({
    data: { name: "Free", email: `${P}free@example.com`, isVerified: true, leaves: 0 },
  })
  const paid = await prisma.user.create({
    data: {
      name: "Paid",
      email: `${P}paid@example.com`,
      isVerified: true,
      leaves: 0,
      premiumUntil: new Date(Date.now() + 86_400_000),
    },
  })
  const lapsed = await prisma.user.create({
    data: {
      name: "Lapsed",
      email: `${P}lapsed@example.com`,
      isVerified: true,
      leaves: 0,
      premiumUntil: new Date(Date.now() - 86_400_000),
    },
  })
  const mk = (title: string, valueLeaves: number | null) =>
    prisma.item.create({
      data: {
        title,
        description: "x",
        images: "[]",
        category: "OTHER",
        condition: "GOOD",
        valueLeaves,
        userId: owner.id,
      },
    })
  const b3 = await mk(`${P}b3`, 425)
  const b6 = await mk(`${P}b6`, 2500)
  const b7 = await mk(`${P}b7`, 2501)
  const b8 = await mk(`${P}b8`, 5000)
  const unvalued = await mk(`${P}unvalued`, null)

  head("3  the gate, non-subscriber")
  const freeStanding = await loadStanding(free.id)
  check("standing.premium is false", freeStanding.premium === false)
  const r3 = await enforcePremiumForListing(freeStanding, [b3.id])
  check("bracket 3 passes", r3 === null)
  const r6 = await enforcePremiumForListing(freeStanding, [b6.id])
  check("bracket 6 passes", r6 === null)
  const r7 = await enforcePremiumForListing(freeStanding, [b7.id])
  const r7b = await body(r7)
  check("bracket 7 → 403", r7?.status === 403, String(r7?.status))
  check("…with code PREMIUM_REQUIRED", r7b?.code === "PREMIUM_REQUIRED", JSON.stringify(r7b))
  check("…and the message says coming soon, not buy", !!r7b?.error && /coming soon/i.test(r7b.error) && !/buy|upgrade|price/i.test(r7b.error), r7b?.error)
  const r8 = await enforcePremiumForListing(freeStanding, [b8.id])
  check("bracket 8 → 403", r8?.status === 403)

  head("4  a subscription")
  const paidStanding = await loadStanding(paid.id)
  check("live subscription: standing.premium true", paidStanding.premium === true)
  check("live subscription passes bracket 7", (await enforcePremiumForListing(paidStanding, [b7.id])) === null)
  check("live subscription passes bracket 8", (await enforcePremiumForListing(paidStanding, [b8.id])) === null)
  const lapsedStanding = await loadStanding(lapsed.id)
  check("expired subscription: standing.premium false", lapsedStanding.premium === false)
  check("expired subscription is refused bracket 7", (await enforcePremiumForListing(lapsedStanding, [b7.id]))?.status === 403)

  head("5  unvalued")
  check("an unvalued listing passes", (await enforcePremiumForListing(freeStanding, [unvalued.id])) === null)

  head("6  order against the tier cap")
  // `free` has zero completed trades → New Trader → maxItemValueLeaves 600.
  // A bracket-7 listing is over that cap too; the premium refusal must win.
  check("New Trader's cap is below bracket 7", (freeStanding.limits.maxItemValueLeaves ?? Infinity) < 2501)
  const initiate = await enforceInitiateTrade(free.id, [b7.id])
  const ib = await body(initiate.response)
  check("enforceInitiateTrade → PREMIUM_REQUIRED, not TIER_ITEM_VALUE_CAP", ib?.code === "PREMIUM_REQUIRED", JSON.stringify(ib))
  const initiate6 = await enforceInitiateTrade(free.id, [b6.id])
  const ib6 = await body(initiate6.response)
  check("…and bracket 6 still hits the tier cap as before", ib6?.code === "TIER_ITEM_VALUE_CAP", JSON.stringify(ib6))
  const initiatePaid = await enforceInitiateTrade(paid.id, [b7.id])
  const ipb = await body(initiatePaid.response)
  check("a premium New Trader on bracket 7 falls through to the tier cap", ipb?.code === "TIER_ITEM_VALUE_CAP", JSON.stringify(ipb))

  head("7  accept path: premium above the cap")
  // The acceptor is acquiring the offered item, so the same two gates run in
  // the same order as on propose, minus the default block. `free` and `paid`
  // are both New Traders (cap 600), so the bracket-7 item is over the cap for
  // either -- what differs is WHICH gate answers first.
  check("accepting bracket 3 passes for a non-subscriber", (await enforceAcceptTrade(free.id, [b3.id])).response === null)
  const acc7 = await body((await enforceAcceptTrade(free.id, [b7.id])).response)
  check("non-subscriber accepting bracket 7 gets PREMIUM_REQUIRED, not the tier cap", acc7?.code === "PREMIUM_REQUIRED", JSON.stringify(acc7))
  check("accept-side copy names accepting, not proposing", !!acc7?.error && /accepting it is locked/.test(acc7.error) && !/proposing/.test(acc7.error), acc7?.error)
  const acc7paid = await body((await enforceAcceptTrade(paid.id, [b7.id])).response)
  check("subscriber accepting bracket 7 is refused only by the TIER CAP", acc7paid?.code === "TIER_ITEM_VALUE_CAP", JSON.stringify(acc7paid))
  check("accepting an unvalued item passes for a non-subscriber", (await enforceAcceptTrade(free.id, [unvalued.id])).response === null)

  await cleanup()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error(e)
  await cleanup().catch(() => {})
  process.exit(1)
})
