// Acceptance harness for daily quests (23 Sep 2026, moved weekly -> daily
// 24 Sep 2026).
//
// RUNS AGAINST A SCRATCH SCHEMA:
//   .\scripts\scratch.ps1 -Run scripts\verify-quests.ts
//
// What it pins down, in order:
//   1  dayStartUtc() lands on UTC midnight
//   2  a fresh user gets exactly 5 assignments: 2 Easy, 2 Medium, 1 Hard, and
//      the two per tier are never the same QuestKind
//   3  the assignment is STABLE across repeated calls the same day
//   4  MEDIUM always includes both pool entries (pool size == daily count)
//   5  completing the real action behind a quest pays it out exactly once
//   6  a second reconcile does not pay twice
//   7  the reward amounts match QUEST_REWARDS and total 15 if all 5 are done

import prisma from "../src/lib/prisma"
import { reconcileQuests, dayStartUtc, QUEST_REWARDS, QUEST_TIER_COUNT, QUEST_TIERS } from "../src/lib/quests"
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
  const noon = new Date("2026-09-24T15:30:00Z")
  check("lands on UTC midnight the same day", dayStartUtc(noon).toISOString() === "2026-09-24T00:00:00.000Z")
  const justBeforeMidnight = new Date("2026-09-24T23:59:59Z")
  check("23:59:59 is still the same day", dayStartUtc(justBeforeMidnight).toISOString() === "2026-09-24T00:00:00.000Z")
  const justAfterMidnight = new Date("2026-09-25T00:00:01Z")
  check("the next day starts a new period", dayStartUtc(justAfterMidnight).toISOString() === "2026-09-25T00:00:00.000Z")

  // ── fixtures ──
  const owner = await prisma.user.create({
    data: { name: "Owner", email: `${P}owner@example.com`, isVerified: true, leaves: 0 },
  })
  const fresh = await prisma.user.create({
    data: { name: "Fresh", email: `${P}fresh@example.com`, isVerified: true, leaves: 0 },
  })
  const at = new Date("2026-09-24T12:00:00Z")

  head("2  a fresh user's first call")
  const first = await reconcileQuests(fresh.id, at)
  check("exactly 5 quests", first.length === 5, String(first.length))
  check("2 Easy", first.filter((q) => q.tier === "EASY").length === 2)
  check("2 Medium", first.filter((q) => q.tier === "MEDIUM").length === 2)
  check("1 Hard", first.filter((q) => q.tier === "HARD").length === 1)
  for (const tier of QUEST_TIERS) {
    const kinds = first.filter((q) => q.tier === tier).map((q) => q.quest)
    check(`${tier}: no duplicate QuestKind`, new Set(kinds).size === kinds.length, JSON.stringify(kinds))
  }
  check("none completed yet", first.every((q) => !q.completed))
  check("reward matches QUEST_REWARDS per tier", first.every((q) => q.rewardLeaves === QUEST_REWARDS[q.tier]))
  check(
    "QUEST_TIER_COUNT matches what was actually assigned",
    QUEST_TIERS.every((t) => first.filter((q) => q.tier === t).length === QUEST_TIER_COUNT[t]),
  )

  head("3  stability across repeated calls the same day")
  const second = await reconcileQuests(fresh.id, new Date(at.getTime() + 60_000))
  const firstKinds = new Set(first.map((q) => q.quest))
  const secondKinds = new Set(second.map((q) => q.quest))
  check("same 5 QuestKinds on a same-day re-call", firstKinds.size === secondKinds.size && [...firstKinds].every((k) => secondKinds.has(k)))

  head("4  MEDIUM always includes both pool entries")
  const mediumKinds = new Set(first.filter((q) => q.tier === "MEDIUM").map((q) => q.quest))
  check("LIST_ITEM assigned", mediumKinds.has("LIST_ITEM"))
  check("RECEIVE_OFFER assigned", mediumKinds.has("RECEIVE_OFFER"))

  head("5  completing the real action")
  const target = await mkItem(owner.id, "target", 100)

  // Which EASY quest a fresh user lands on is a hash of their (random) cuid,
  // so spin up throwaway candidates until one includes SEND_OFFER -- the
  // cheapest of the pool to satisfy -- so this section always runs.
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
    check("SEND_OFFER now shows completed", after1.find((q) => q.quest === "SEND_OFFER")?.completed === true)
    const afterBalance = await prisma.user.findUniqueOrThrow({ where: { id: payer.id }, select: { leaves: true, lifetimeLeaves: true } })
    check("Leaves credited", afterBalance.leaves === before.leaves + QUEST_REWARDS.EASY)
    check("lifetimeLeaves credited too", afterBalance.lifetimeLeaves === before.leaves + QUEST_REWARDS.EASY)

    head("6  a second reconcile does not pay twice")
    await reconcileQuests(payer.id, new Date(at.getTime() + 2000))
    const stillSame = await prisma.user.findUniqueOrThrow({ where: { id: payer.id }, select: { leaves: true } })
    check("balance unchanged on re-reconcile", stillSame.leaves === afterBalance.leaves)

    head("7  ledger row and the daily total")
    const rows = await prisma.leafTransaction.count({ where: { userId: payer.id, type: "QUEST_REWARD" } })
    check("exactly one QUEST_REWARD row", rows === 1, String(rows))
    const maxDaily = QUEST_TIERS.reduce((sum, t) => sum + QUEST_REWARDS[t] * QUEST_TIER_COUNT[t], 0)
    check("completing all 5 would total 15 Leaves/day", maxDaily === 15, String(maxDaily))
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
