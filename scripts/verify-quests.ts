// Acceptance harness for daily quests (23 Sep 2026, "Daily Nest").
//
// RUNS AGAINST A SCRATCH SCHEMA:
//   .\scripts\scratch.ps1 -Run scripts\verify-quests.ts
//
// What it pins down, in order:
//   1  dayStartUtc() lands on that calendar day's 00:00 UTC
//   2  a fresh user gets exactly 5 assignments: 2 Easy, 2 Medium, 1 Hard
//   3  the assignment is STABLE across repeated calls the same day
//   4  MEDIUM always assigns both pool entries (pool size == slot count)
//   5  completing the real action behind a quest pays it out exactly once
//   6  a second reconcile does not pay twice
//   7  the reward amounts match QUEST_REWARDS and write one ledger row each

import prisma from "../src/lib/prisma"
import { reconcileQuests, dayStartUtc, QUEST_REWARDS, QUEST_SLOTS, QUEST_TIERS } from "../src/lib/quests"
import { requireScratchSchema } from "./lib/live-guard"

const P = "ZZQUEST_"
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
    await prisma.offer.deleteMany({ where: { OR: [{ senderId: { in: ids } }, { receiverId: { in: ids } }] } })
    await prisma.follow.deleteMany({ where: { OR: [{ followerId: { in: ids } }, { followeeId: { in: ids } }] } })
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
  requireScratchSchema("scripts/verify-quests.ts")
  await cleanup()

  head("1  dayStartUtc")
  const midday = new Date("2026-09-23T15:00:00Z")
  const dayStart = dayStartUtc(midday)
  check("mid-day → that day's 00:00 UTC", dayStart.toISOString() === "2026-09-23T00:00:00.000Z", dayStart.toISOString())
  const lateSameDay = new Date("2026-09-23T23:59:59Z")
  check("23:59 the same day still belongs to the SAME day", dayStartUtc(lateSameDay).toISOString() === dayStart.toISOString())
  const nextDay = new Date("2026-09-24T00:00:01Z")
  check("the next day starts a new day", dayStartUtc(nextDay).toISOString() === "2026-09-24T00:00:00.000Z")

  // ── fixtures ──
  const owner = await prisma.user.create({
    data: { name: "Owner", email: `${P}owner@example.com`, isVerified: true, leaves: 0 },
  })
  const fresh = await prisma.user.create({
    data: { name: "Fresh", email: `${P}fresh@example.com`, isVerified: true, leaves: 0 },
  })
  const at = new Date("2026-09-23T12:00:00Z")

  head("2  a fresh user's first call")
  const first = await reconcileQuests(fresh.id, at)
  check("exactly 5 quests", first.length === 5, String(first.length))
  for (const tier of QUEST_TIERS) {
    check(`${QUEST_SLOTS[tier]} ${tier} quest(s)`, first.filter((q) => q.tier === tier).length === QUEST_SLOTS[tier])
  }
  check("none completed yet", first.every((q) => !q.completed))
  check("reward matches QUEST_REWARDS per tier", first.every((q) => q.rewardLeaves === QUEST_REWARDS[q.tier]))
  check(
    "no duplicate quest kind within a tier",
    QUEST_TIERS.every((tier) => {
      const kinds = first.filter((q) => q.tier === tier).map((q) => q.quest)
      return new Set(kinds).size === kinds.length
    }),
  )

  head("3  stability across repeated calls")
  const second = await reconcileQuests(fresh.id, new Date(at.getTime() + 60_000))
  const sameSet = (t: typeof QUEST_TIERS[number]) => {
    const a = first.filter((q) => q.tier === t).map((q) => `${q.slot}:${q.quest}`).sort()
    const b = second.filter((q) => q.tier === t).map((q) => `${q.slot}:${q.quest}`).sort()
    return JSON.stringify(a) === JSON.stringify(b)
  }
  check("EASY unchanged", sameSet("EASY"))
  check("MEDIUM unchanged", sameSet("MEDIUM"))
  check("HARD unchanged", sameSet("HARD"))

  head("4  MEDIUM always assigns both pool entries")
  const mediumKinds = first.filter((q) => q.tier === "MEDIUM").map((q) => q.quest).sort()
  check("LIST_ITEM and RECEIVE_OFFER both assigned", JSON.stringify(mediumKinds) === JSON.stringify(["LIST_ITEM", "RECEIVE_OFFER"]))

  const lister = await prisma.user.create({
    data: { name: "Lister", email: `${P}lister@example.com`, isVerified: true, leaves: 0 },
  })
  await prisma.item.create({
    data: {
      title: `${P}already-listed`, description: "x", images: "[]",
      category: "OTHER", condition: "GOOD", valueLeaves: 100, userId: lister.id,
      createdAt: new Date(at.getTime() - 30 * 24 * 60 * 60 * 1000), // well before today
    },
  })
  const listerQuests = await reconcileQuests(lister.id, at)
  const listerMediumKinds = listerQuests.filter((q) => q.tier === "MEDIUM").map((q) => q.quest).sort()
  check(
    "a user who has already listed something still gets both MEDIUM quests",
    JSON.stringify(listerMediumKinds) === JSON.stringify(["LIST_ITEM", "RECEIVE_OFFER"]),
  )

  head("5  completing the real action")
  const target = await mkItem(owner.id, "target", 100)

  // EASY's pool has 3 entries for 2 slots, so which of the 3 `fresh` landed
  // on is not known ahead of time. Rather than leave the payout path
  // untested on an unlucky run, spin up throwaway candidates until one's
  // EASY slots include SEND_OFFER -- the cheapest of the three to satisfy --
  // so this section always runs.
  let payer: { id: string } | null = null
  for (let i = 0; i < 40 && !payer; i++) {
    const candidate = await prisma.user.create({
      data: { name: `Payer${i}`, email: `${P}payer${i}@example.com`, isVerified: true, leaves: 0 },
    })
    const qs = await reconcileQuests(candidate.id, at)
    if (qs.some((q) => q.tier === "EASY" && q.quest === "SEND_OFFER")) {
      payer = candidate
    } else {
      await prisma.user.delete({ where: { id: candidate.id } })
    }
  }
  if (!payer) {
    check("found a SEND_OFFER fixture within 40 tries", false)
  } else {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: payer.id }, select: { leaves: true } })

    await prisma.offer.create({
      data: { postId: target.id, senderId: payer.id, receiverId: owner.id, offeredItems: "[]", createdAt: at },
    })

    const after1 = await reconcileQuests(payer.id, new Date(at.getTime() + 1000))
    check("SEND_OFFER now shows completed", after1.find((q) => q.tier === "EASY" && q.quest === "SEND_OFFER")?.completed === true)
    const afterBalance = await prisma.user.findUniqueOrThrow({ where: { id: payer.id }, select: { leaves: true, lifetimeLeaves: true } })
    check("Leaves credited", afterBalance.leaves === before.leaves + QUEST_REWARDS.EASY)
    check("lifetimeLeaves credited too", afterBalance.lifetimeLeaves === before.leaves + QUEST_REWARDS.EASY)

    head("6  a second reconcile does not pay twice")
    await reconcileQuests(payer.id, new Date(at.getTime() + 2000))
    const stillSame = await prisma.user.findUniqueOrThrow({ where: { id: payer.id }, select: { leaves: true } })
    check("balance unchanged on re-reconcile", stillSame.leaves === afterBalance.leaves)

    head("7  ledger row")
    const rows = await prisma.leafTransaction.count({ where: { userId: payer.id, type: "QUEST_REWARD" } })
    check("exactly one QUEST_REWARD row", rows === 1, String(rows))
  }

  await cleanup()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error(e)
  await cleanup().catch(() => {})
  process.exit(1)
})
