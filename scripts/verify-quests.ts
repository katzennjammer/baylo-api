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
//   4  every assigned quest comes from its own tier's pool (MEDIUM has 3
//      entries for 2 daily slots since SEND_BRIDGE_OFFER joined it)
//   5  completing the real action behind a quest pays it out exactly once
//   6  a second reconcile does not pay twice
//   7  the reward amounts match QUEST_REWARDS and total 15 if all 5 are done
//   8  trade quests key off completedAt, not updatedAt: an old trade edited
//      today does not count, one completed today does (25 Sep 2026)
//   9  reconcileQuests(..., only) checks only the kinds it is given
//  10  settleQuestsAsync(): the event path pays a person, and skips an org
//      account entirely (no assignments, no Leaves)

import prisma from "../src/lib/prisma"
import {
  reconcileQuests, settleQuestsAsync, dayStartUtc, QUEST_POOL, QUEST_REWARDS, QUEST_TIER_COUNT, QUEST_TIERS,
  type QuestKind,
} from "../src/lib/quests"
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
    await prisma.tradeRequest.deleteMany({ where: { OR: [{ senderId: { in: ids } }, { receiverId: { in: ids } }] } })
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

/** A fresh user whose day (at `at`) includes `quest`. Assignment is a hash of
 *  the user's random cuid, so this spins throwaway users until one lands. */
async function userWithQuest(quest: QuestKind, at: Date, tag: string): Promise<{ id: string } | null> {
  for (let i = 0; i < 60; i++) {
    const candidate = await prisma.user.create({
      data: { name: `${tag}${i}`, email: `${P}${tag}${i}@example.com`, isVerified: true, leaves: 0 },
    })
    const qs = await reconcileQuests(candidate.id, at)
    if (qs.some((q) => q.quest === quest)) return candidate
    await prisma.questAssignment.deleteMany({ where: { userId: candidate.id } })
    await prisma.user.delete({ where: { id: candidate.id } })
  }
  return null
}

async function poll<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms
  let v = await read()
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 200))
    v = await read()
  }
  return v
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

  head("4  every quest comes from its own tier's pool")
  for (const tier of QUEST_TIERS) {
    const pool = new Set<string>(QUEST_POOL[tier].map((d) => d.quest))
    check(`${tier}: assigned kinds are all from the ${tier} pool`,
      first.filter((q) => q.tier === tier).every((q) => pool.has(q.quest)))
  }

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

  head("8  trade quests read completedAt, not updatedAt")
  const trader = await userWithQuest("COMPLETE_TRADE", at, "trader")
  if (!trader) {
    check("found a COMPLETE_TRADE fixture within 60 tries", false)
  } else {
    const theirs = await mkItem(owner.id, "theirs", 100)
    // Completed YESTERDAY, then touched today -- the exact shape of the bug.
    const old = await mkItem(trader.id, "old", 100)
    await prisma.tradeRequest.create({
      data: {
        senderId: trader.id, receiverId: owner.id,
        offeredItemId: old.id, requestedItemId: theirs.id,
        status: "COMPLETED",
        completedAt: new Date("2026-09-23T10:00:00Z"),
        updatedAt: new Date(at.getTime() - 60_000),
      },
    })
    const stale = await reconcileQuests(trader.id, at)
    check("an old trade edited today does NOT complete today's quest",
      stale.find((q) => q.quest === "COMPLETE_TRADE")?.completed === false)

    const legacy = await mkItem(trader.id, "legacy", 100)
    await prisma.tradeRequest.create({
      data: {
        senderId: trader.id, receiverId: owner.id,
        offeredItemId: legacy.id, requestedItemId: theirs.id,
        status: "COMPLETED", completedAt: null, updatedAt: new Date(at.getTime() - 30_000),
      },
    })
    const legacyView = await reconcileQuests(trader.id, at)
    check("a pre-column trade (completedAt NULL) does not count either",
      legacyView.find((q) => q.quest === "COMPLETE_TRADE")?.completed === false)

    const fresh2 = await mkItem(trader.id, "today", 100)
    await prisma.tradeRequest.create({
      data: {
        senderId: trader.id, receiverId: owner.id,
        offeredItemId: fresh2.id, requestedItemId: theirs.id,
        status: "COMPLETED", completedAt: new Date(at.getTime() - 10_000),
      },
    })
    const done = await reconcileQuests(trader.id, at)
    check("a trade completed today DOES complete it",
      done.find((q) => q.quest === "COMPLETE_TRADE")?.completed === true)
  }

  head("9  reconcileQuests(..., only) checks only what it is given")
  const narrow = await userWithQuest("SEND_OFFER", at, "narrow")
  if (!narrow) {
    check("found a SEND_OFFER fixture within 60 tries", false)
  } else {
    await prisma.offer.create({
      data: { postId: target.id, senderId: narrow.id, receiverId: owner.id, offeredItems: "[]", createdAt: at },
    })
    const other = await reconcileQuests(narrow.id, at, ["LIST_ITEM"])
    check("an unrelated kind leaves SEND_OFFER unpaid",
      other.find((q) => q.quest === "SEND_OFFER")?.completed === false)
    const bal0 = await prisma.user.findUniqueOrThrow({ where: { id: narrow.id }, select: { leaves: true } })
    check("...and pays nothing", bal0.leaves === 0, String(bal0.leaves))
    const right = await reconcileQuests(narrow.id, at, ["SEND_OFFER", "SEND_BRIDGE_OFFER"])
    check("the matching kind pays it", right.find((q) => q.quest === "SEND_OFFER")?.completed === true)
  }

  head("10  settleQuestsAsync: people yes, org accounts no")
  // Real clock from here: the event path always settles "now".
  const person = await userWithQuest("LIST_ITEM", new Date(), "person")
  if (!person) throw new Error("no LIST_ITEM fixture within 60 tries")
  await mkItem(person.id, "person-listing", 100)
  settleQuestsAsync(person.id, ["LIST_ITEM"])
  const paid = await poll(
    () => prisma.questAssignment.findFirst({ where: { userId: person.id, quest: "LIST_ITEM" } }),
    (a) => a?.completedAt != null,
  )
  check("a person's listing pays LIST_ITEM through the event path", paid?.completedAt != null)
  const personBal = await prisma.user.findUniqueOrThrow({ where: { id: person.id }, select: { leaves: true } })
  check("...crediting QUEST_REWARDS.MEDIUM", personBal.leaves === QUEST_REWARDS.MEDIUM, String(personBal.leaves))

  const orgRow = await prisma.user.create({
    data: { name: "OrgRow", email: `${P}orgrow@example.com`, isVerified: true, leaves: 0, isOrgAccount: true },
  })
  await mkItem(orgRow.id, "org-listing", 100)
  settleQuestsAsync(orgRow.id, ["LIST_ITEM"])
  await new Promise((r) => setTimeout(r, 2500))
  const orgAssignments = await prisma.questAssignment.count({ where: { userId: orgRow.id } })
  check("an org account gets no quest assignments from the event path", orgAssignments === 0, String(orgAssignments))
  const orgBal = await prisma.user.findUniqueOrThrow({ where: { id: orgRow.id }, select: { leaves: true } })
  check("...and no Leaves", orgBal.leaves === 0, String(orgBal.leaves))

  await cleanup()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error(e)
  await cleanup().catch(() => {})
  process.exit(1)
})
