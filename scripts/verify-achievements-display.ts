/**
 * PATCH /api/v1/achievements/display, schema v2.
 *
 * Run against a dev server on the SAME schema_v2 copy:
 *   npm run dev:v2 -- -p 3100                    (one window)
 *   $env:BAYLO_BASE_URL="http://localhost:3100"
 *   npm run v2:tsx -- scripts/verify-achievements-display.ts
 *
 * ── WHAT CHANGED, AND WHY THIS HARNESS IS SHORTER ───────────────────────────
 *
 * Until schema v2 this harness proved two fixes to five RAW SQL statements in
 * the route (a spliced session id, and a table name that resolved to live), and
 * to do it safely it snapshotted and restored "public"."UserAchievement" --
 * live -- around every run. The route has no raw SQL any more: earned badges
 * are ACHIEVEMENT rows of UserProgress, written with typed Prisma calls scoped
 * by `type`. A spliced id has nowhere to go, and the client cannot reach
 * another schema. So the live snapshot is gone (this harness never reads or
 * writes `public`; the v2 client refuses to connect there at all), and what is
 * checked is the behaviour, plus the two properties the merge introduced:
 *
 *   - the shelf: picks numbered 1..n, a removed badge leaves, `[]` clears;
 *   - the home slot: one featured badge, cleared when unset;
 *   - a hostile id (in the session or the body) moves nobody else's rows;
 *   - QUEST rows of the same user are never touched by a shelf write.
 */
import prisma, { databaseSchema } from "@/lib/prisma"
import { signAccessToken } from "@/lib/auth-tokens"

const BASE = process.env.BAYLO_BASE_URL ?? "http://localhost:3100"
const TAG = `ach-display-${Date.now()}`
const INJECTION_ID = `${TAG}-atk' OR '1'='1`

let failures = 0
function check(name: string, condition: boolean, detail = "") {
  if (condition) console.log(`  ok    ${name}`)
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`) }
}

async function patch(token: string, body: unknown) {
  const res = await fetch(`${BASE}/api/v1/achievements/display`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const envelope = (await res.json().catch(() => null)) as { data?: { ok?: boolean } } | null
  return { status: res.status, ok: envelope?.data?.ok === true }
}

async function shelfOf(userId: string) {
  return prisma.userProgress.findMany({
    where: { userId, type: "ACHIEVEMENT" },
    select: { achievementId: true, displayOrder: true, homeDisplayOrder: true },
    orderBy: { achievementId: "asc" },
  })
}

async function main() {
  console.log(`\n  schema: ${databaseSchema()}\n  base:   ${BASE}\n`)
  const probe = await fetch(`${BASE}/api/v1/achievements/display`, { method: "PATCH" }).catch(() => null)
  if (!probe) { console.error(`  No server at ${BASE}. Start one with: npm run dev:v2 -- -p 3100`); process.exit(2) }

  const badgeIds: string[] = []
  const userIds: string[] = []
  try {
    for (const [i, k] of ["alpha", "beta", "gamma"].entries()) {
      const b = await prisma.achievement.create({
        data: { key: `${TAG}-${k}`, name: `${TAG} ${k}`, description: "fixture", criterion: "COMPLETED_TRADES", threshold: 1, sortOrder: i },
        select: { id: true },
      })
      badgeIds.push(b.id)
    }
    const [a, b, c] = badgeIds
    const mkUser = (id: string, label: string) =>
      prisma.user.create({ data: { id, name: `${TAG} ${label}`, email: `${TAG}-${label}@example.invalid`, isVerified: true }, select: { id: true } })
    const victim = await mkUser(`${TAG}-victim`, "victim")
    const attacker = await mkUser(INJECTION_ID, "attacker")
    userIds.push(victim.id, attacker.id)

    const unlockedAt = new Date()
    for (const u of [victim.id, attacker.id]) {
      await prisma.userProgress.createMany({
        data: badgeIds.map((id, i) => ({
          type: "ACHIEVEMENT" as const, userId: u, achievementId: id, unlockedAt,
          displayOrder: u === victim.id ? i + 1 : null,
          homeDisplayOrder: u === victim.id && i === 0 ? 1 : null,
        })),
      })
    }
    // A QUEST row on the victim: a shelf write must never touch it.
    const quest = await prisma.userProgress.create({
      data: { type: "QUEST", userId: victim.id, periodStart: new Date("2026-10-03T00:00:00Z"), tier: "EASY", quest: "SEND_OFFER", rewardLeaves: 2 },
      select: { id: true },
    })

    const victimToken = await signAccessToken(victim.id)
    const attackerToken = await signAccessToken(attacker.id)

    // ── the shelf ──
    let r = await patch(victimToken, { achievementIds: [c, a], featuredAchievementId: c })
    let shelf = await shelfOf(victim.id)
    const at = (id: string) => shelf.find((s) => s.achievementId === id)
    check("PATCH returns ok", r.status === 200 && r.ok, `status ${r.status}`)
    check("picks numbered in order (gamma 1, alpha 2)", at(c)?.displayOrder === 1 && at(a)?.displayOrder === 2)
    check("the badge not picked leaves the shelf (beta NULL)", at(b)?.displayOrder === null)
    check("home slot moves to the featured badge only", at(c)?.homeDisplayOrder === 1 && at(a)?.homeDisplayOrder === null && at(b)?.homeDisplayOrder === null)

    r = await patch(victimToken, { achievementIds: [a, a, b] })
    shelf = await shelfOf(victim.id)
    check("a repeated id keeps its FIRST position (alpha 1, beta 2)", at(a)?.displayOrder === 1 && at(b)?.displayOrder === 2 && at(c)?.displayOrder === null)
    check("no featured id clears the home slot", shelf.every((s) => s.homeDisplayOrder === null))

    // ── hostile ids ──
    await patch(victimToken, { achievementIds: [a, b, c], featuredAchievementId: a })
    const before = await shelfOf(victim.id)
    r = await patch(attackerToken, { achievementIds: [] })
    check("PATCH with a hostile session id returns 200", r.status === 200, `status ${r.status}`)
    check("...and the victim's shelf is untouched", JSON.stringify(await shelfOf(victim.id)) === JSON.stringify(before))
    check("...while the attacker's own shelf did clear", (await shelfOf(attacker.id)).every((s) => s.displayOrder === null))
    r = await patch(attackerToken, { achievementIds: [`x' OR '1'='1`, a], featuredAchievementId: `x'; DROP TABLE "UserProgress"; --` })
    check("PATCH with hostile body ids returns 200", r.status === 200, `status ${r.status}`)
    check("...victim still untouched", JSON.stringify(await shelfOf(victim.id)) === JSON.stringify(before))
    check("...UserProgress still there", (await prisma.userProgress.count({ where: { userId: victim.id } })) === 4)

    // ── QUEST rows ──
    const q = await prisma.userProgress.findUniqueOrThrow({ where: { id: quest.id } })
    check("the victim's QUEST row is untouched by every shelf write", q.type === "QUEST" && q.displayOrder === null && q.homeDisplayOrder === null && q.quest === "SEND_OFFER")
  } finally {
    await prisma.userProgress.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.achievement.deleteMany({ where: { id: { in: badgeIds } } })
  }

  console.log(failures === 0 ? "\n  all checks passed\n" : `\n  ${failures} check(s) failed\n`)
  await prisma.$disconnect()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
