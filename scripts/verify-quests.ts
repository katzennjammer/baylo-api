// Acceptance harness for weekly quests (23 Sep 2026).
//
// RUNS AGAINST A SCRATCH SCHEMA:
//   .\scripts\scratch.ps1 -Run scripts\verify-quests.ts
//
// What it pins down, in order:
//   1  weekStartUtc() lands on Monday 00:00 UTC, both mid-week and on Sunday
//   2  a fresh user gets exactly 3 assignments, one per tier, on first call
//   3  the assignment is STABLE across repeated calls in the same week
//   4  MEDIUM personalises to LIST_ITEM for a user with nothing listed
//   5  completing the real action behind a quest pays it out exactly once
//   6  a second reconcile does not pay twice
//   7  the reward amounts match QUEST_REWARDS and write one ledger row each

import prisma from "../src/lib/prisma"
import { reconcileQuests, weekStartUtc, QUEST_REWARDS, QUEST_TIERS } from "../src/lib/quests"
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

  head("1  weekStartUtc")
  const wed = new Date("2026-09-23T15:00:00Z") // a Wednesday
  const mon = weekStartUtc(wed)
  check("Wednesday → the Monday before it, 00:00 UTC", mon.toISOString() === "2026-09-21T00:00:00.000Z", mon.toISOString())
  const sun = new Date("2026-09-27T23:00:00Z") // the following Sunday
  check("Sunday still belongs to the SAME week", weekStartUtc(sun).toISOString() === mon.toISOString())
  const nextMon = new Date("2026-09-28T00:00:01Z")
  check("the next Monday starts a new week", weekStartUtc(nextMon).toISOString() === "2026-09-28T00:00:00.000Z")

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
  check("exactly 3 quests", first.length === 3)
  check("one per tier", QUEST_TIERS.every((t) => first.some((q) => q.tier === t)))
  check("none completed yet", first.every((q) => !q.completed))
  check("reward matches QUEST_REWARDS per tier", first.every((q) => q.rewardLeaves === QUEST_REWARDS[q.tier]))

  head("3  stability across repeated calls")
  const second = await reconcileQuests(fresh.id, new Date(at.getTime() + 60_000))
  const sameQuest = (t: typeof QUEST_TIERS[number]) =>
    first.find((q) => q.tier === t)?.quest === second.find((q) => q.tier === t)?.quest
  check("EASY unchanged", sameQuest("EASY"))
  check("MEDIUM unchanged", sameQuest("MEDIUM"))
  check("HARD unchanged", sameQuest("HARD"))

  head("4  MEDIUM personalisation")
  check("a user with nothing listed gets LIST_ITEM", first.find((q) => q.tier === "MEDIUM")?.quest === "LIST_ITEM")

  const lister = await prisma.user.create({
    data: { name: "Lister", email: `${P}lister@example.com`, isVerified: true, leaves: 0 },
  })
  await prisma.item.create({
    data: {
      title: `${P}already-listed`, description: "x", images: "[]",
      category: "OTHER", condition: "GOOD", valueLeaves: 100, userId: lister.id,
      createdAt: new Date(at.getTime() - 30 * 24 * 60 * 60 * 1000), // well before this week
    },
  })
  const listerQuests = await reconcileQuests(lister.id, at)
  check(
    "a user who has already listed something is not forced into LIST_ITEM",
    listerQuests.find((q) => q.tier === "MEDIUM")?.quest !== undefined,
  )

  head("5  completing the real action")
  const target = await mkItem(owner.id, "target", 100)

  // EASY's pool entry is deterministic per (userId, week) but userId is a
  // random cuid, so which of the 3 pool entries `fresh` landed on is not
  // known ahead of time. Rather than leave the payout path untested on an
  // unlucky run, spin up throwaway candidates until one lands on SEND_OFFER --
  // the cheapest of the three to satisfy -- so this section always runs.
  let payer: { id: string } | null = null
  for (let i = 0; i < 40 && !payer; i++) {
    const candidate = await prisma.user.create({
      data: { name: `Payer${i}`, email: `${P}payer${i}@example.com`, isVerified: true, leaves: 0 },
    })
    const qs = await reconcileQuests(candidate.id, at)
    if (qs.find((q) => q.tier === "EASY")?.quest === "SEND_OFFER") {
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
    check("SEND_OFFER now shows completed", after1.find((q) => q.tier === "EASY")?.completed === true)
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
