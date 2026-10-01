/**
 * ONE-OFF REPAIR for the 23 Sep 2026 UserAchievement wipe.
 *
 *   npx tsx --env-file=.env --tsconfig tsconfig.json scripts/backfill-null-display-order.ts
 *   npx tsx --env-file=.env --tsconfig tsconfig.json scripts/backfill-null-display-order.ts --apply --live
 *
 * ── WHAT WAS LOST ───────────────────────────────────────────────────────────
 *
 * Driving the UNFIXED `PATCH /api/v1/achievements/display` to reproduce its
 * injection hole ran the blanket reset against `public` with a WHERE that
 * matched every row: `displayOrder` and `homeDisplayOrder` were set to NULL on
 * all 15 live rows, across three users. Grants, `unlockedAt` and every other
 * column survived. The newest backup predates 9 of the 15 rows, and the free
 * tier keeps none of its own, so the old values are gone. See commit 2a47f71.
 *
 * ── WHY THIS IS A RECONSTRUCTION AND NOT A RESTORE ──────────────────────────
 *
 * NULL is not damage here. `displayOrder` IS the user's choice -- the app says
 * "choose up to four badges to display", and a badge nobody picked is NULL by
 * design. So a NULL column cannot say whether it was wiped or whether it was
 * always empty, and the 15 nulled rows are NOT 15 lost values:
 *
 *     15 rows touched.  6 carried a displayOrder (SUM was 13).  1 carried a
 *     homeDisplayOrder.  The other 9 were already NULL and are not damage.
 *
 * Six contiguous 1..k shelves summing to 13 decompose one way only -- one user
 * with four badges shelved, one with two, one with none -- but nothing records
 * WHICH user, let alone which badge sat in which slot. This script therefore
 * does not restore the old shelf. It gives the three affected users a
 * defensible one so their profiles are not blank, and that is a judgement
 * call, not a recovery. Anything it writes, the owner can change in one screen.
 *
 * ── THE RULES IT WRITES UNDER ───────────────────────────────────────────────
 *
 * 1  SCOPE IS AN EXPLICIT ROW ALLOWLIST, not the NULL predicate. "Every row
 *    where displayOrder IS NULL" is every unshelved badge in the database,
 *    including every future user who simply has not picked any -- filling
 *    those in would invent shelves nobody asked for. INCIDENT_ROW_IDS below is
 *    the fifteen rows the bad UPDATE actually touched; REPAIR_ROW_IDS is the
 *    narrower set this script writes. The NULL scan still runs over the whole
 *    table, and every row it finds outside the repair set is REPORTED and left
 *    alone, so a wider blast radius than the incident report claimed surfaces
 *    here instead of being silently rewritten.
 *
 * 2  THE CAP IS FOUR. `MAX_PROFILE_BADGES` bounds the shelf in the route, and
 *    the read paths render every non-null row they find. Numbering Aya's nine
 *    badges 1..9 would put nine badges on a four-badge shelf -- a state the UI
 *    cannot produce and cannot fix. Each user gets at most four; the rest stay
 *    NULL, which is what "not displayed" has always meant.
 *
 * 3  `homeDisplayOrder` IS LEFT ALONE UNLESS --home. The schema allows at most
 *    one non-null per user, and exactly one row in the whole database had one.
 *    Backfilling all three users would invent two featured badges that never
 *    existed and break the one-per-user invariant that
 *    `find(r => r.homeDisplayOrder !== null)` on the mobile screen depends on.
 *
 * 4  A USER WITH ANY SHELF IS SKIPPED ENTIRELY. Not just "don't touch non-null
 *    rows": if a user has even one slot filled, their shelf was not wiped, and
 *    numbering their remaining badges from 1 would collide with the slots they
 *    already hold. Per-row idempotence is not enough -- the unit of repair is
 *    the shelf.
 *
 * 5  ORDER IS `unlockedAt DESC, id ASC`. The DESC half is the tiebreak the read
 *    paths already use (`ORDER BY "displayOrder" ASC, "unlockedAt" DESC` in
 *    profile/me, profile/[id] and home): when the app must choose between
 *    badges it prefers the newest. `--oldest-first` inverts it. The `id ASC`
 *    half is doing most of the work and is not decoration -- these badges were
 *    granted in batches, so twelve of the fifteen rows share a timestamp with a
 *    sibling (all three of Jamaica's are identical, all three of Jun's, six of
 *    Aya's nine). Without it the "ordering rule" would be whatever order
 *    Postgres felt like returning, and a re-run could disagree with itself.
 *
 * 6  WRITES GO THROUGH THE TYPED CLIENT. No raw SQL, deliberately: a bare table
 *    name in `$executeRaw` resolves through `search_path` to `public` whatever
 *    `?schema=` says, which is half of how the incident happened. Prisma
 *    qualifies what it builds. See @/lib/prisma and scripts/lib/live-guard.ts.
 *
 * Read-only by default. `--apply` writes, and because it writes,
 * `requireScratchSchema()` gates it -- live needs `--live`. The guard is called
 * only on the writing path: a report that refused to READ live would defeat the
 * point of a dry run.
 */
import prisma from "../src/lib/prisma"
import { requireScratchSchema, targetSchema } from "./lib/live-guard"

/**
 * MIRRORS `MAX_PROFILE_BADGES` in src/app/api/v1/achievements/route.ts. Copied
 * rather than imported: that module is a Next route handler and pulls
 * next-auth, zod and the criteria engine in behind it, which is a lot of
 * machinery for one integer in a CLI script. If the shelf size changes, change
 * it in both places -- the route is the source of truth.
 */
const MAX_PROFILE_BADGES = 4

/**
 * The fifteen rows the bad UPDATE touched, from the incident audit. Ids, not
 * user ids and not a predicate, because the id is the only thing about those
 * rows that the wipe could not have changed.
 */
const INCIDENT_ROW_IDS = [
  // Aya Reyes (seed-u-aya) -- 9 badges
  "cmu5o01710001hcobhdx89ka5", "cmu5o01710002hcobgk0zd54s", "cmu5o01710003hcobpyltnukv",
  "cmuczs8sb00019wobcrqsoyyx", "cmuczs8sb00029wobxuzsa7za", "cmuczs8sb00039wobfk4rugd4",
  "cmuczs8sb00049wobcz3hq2rg", "cmuczs8sb00059wobvms7tykl", "cmuczs8sb00069wobd1nwl1qh",
  // Jamaica Jumuad (cmq7ss3kf00001473is5i7a1l) -- 3 badges
  "cmu6ho65k00004sob5olsiw89", "cmu6ho65t00014sob35gljr3x", "cmu6ho65t00024sobc96kveup",
  // Jun Dela Cruz (seed-u-jun) -- 3 badges
  "cmubdvo1z000eu873xmyj8ifn", "cmubdvo1z000fu873sgkr1idj", "cmubdvo1z000gu873zwa47jen",
]

/**
 * The rows this script actually writes: Jamaica Jumuad's three.
 *
 * The other twelve belong to `seed-u-aya` and `seed-u-jun`, which are SEED
 * accounts. A reconstruction is a guess either way (see above), and a guess is
 * worth making for a real person whose profile went blank; for two demo
 * accounts it is twelve invented rows in the live database that nobody asked
 * for and nobody will correct. They stay NULL, which renders as an empty shelf
 * and an invitation to pick four -- exactly what a user who has picked none
 * sees. Anyone who wants those shelves back sets them in the app, which is one
 * screen and writes the truth rather than a guess.
 *
 * Note that the seed does NOT create UserAchievement rows -- those badges were
 * granted at runtime by the criteria engine -- so re-seeding would not restore
 * them either.
 */
const REPAIR_ROW_IDS = [
  "cmu6ho65k00004sob5olsiw89", "cmu6ho65t00014sob35gljr3x", "cmu6ho65t00024sobc96kveup",
]

const APPLY = process.argv.includes("--apply")
const WITH_HOME = process.argv.includes("--home")
const OLDEST_FIRST = process.argv.includes("--oldest-first")

interface Row {
  id: string
  userId: string
  achievementId: string
  unlockedAt: Date
  displayOrder: number | null
  homeDisplayOrder: number | null
}

/** Every column of every row in the table, for the before/after diff. */
async function snapshot(): Promise<Map<string, Row>> {
  const rows = await prisma.userAchievement.findMany({
    select: {
      id: true, userId: true, achievementId: true,
      unlockedAt: true, displayOrder: true, homeDisplayOrder: true,
    },
  })
  return new Map(rows.map((r) => [r.id, r]))
}

function fingerprint(r: Row): string {
  return [
    r.userId, r.achievementId, r.unlockedAt.toISOString(),
    r.displayOrder ?? "NULL", r.homeDisplayOrder ?? "NULL",
  ].join("|")
}

interface Plan {
  id: string
  userId: string
  user: string
  badge: string
  slot: number
  home: boolean
}

async function main() {
  const schema = targetSchema()
  console.log("")
  console.log(`  schema           : ${schema}${schema === "public" ? "  (LIVE)" : "  (scratch)"}`)
  console.log(`  mode             : ${APPLY ? "APPLY (writes rows)" : "report only (read-only)"}`)
  console.log(`  ordering         : unlockedAt ${OLDEST_FIRST ? "ASC (oldest first)" : "DESC (newest first)"}, then id ASC`)
  console.log(`  homeDisplayOrder : ${WITH_HOME ? "backfill the slot-1 badge" : "left NULL (see rule 3)"}`)
  console.log("")

  // ── the NULL scan, across the whole table ────────────────────────────────
  const nulls = await prisma.userAchievement.findMany({
    where: { OR: [{ displayOrder: null }, { homeDisplayOrder: null }] },
    select: {
      id: true, userId: true, unlockedAt: true,
      displayOrder: true, homeDisplayOrder: true,
      user: { select: { name: true } },
      achievement: { select: { name: true } },
    },
  })
  const incident = new Set(INCIDENT_ROW_IDS)
  const repair = new Set(REPAIR_ROW_IDS)
  const inScope = nulls.filter((r) => repair.has(r.id))
  const deferred = nulls.filter((r) => incident.has(r.id) && !repair.has(r.id))
  const strays = nulls.filter((r) => !incident.has(r.id))

  console.log(`  rows with a NULL in either column   : ${nulls.length}`)
  console.log(`    in the repair set                 : ${inScope.length} of ${REPAIR_ROW_IDS.length}`)
  console.log(`    incident rows deliberately left    : ${deferred.length}`)
  console.log(`    outside the incident (NOT touched) : ${strays.length}`)

  if (deferred.length > 0) {
    console.log("")
    console.log("  ── wiped, but left NULL on purpose ─────────────────────────────────")
    console.log("     Seed accounts. A reconstruction is a guess, and a guess is not worth")
    console.log("     writing to live for a demo profile. Empty shelf, pick in the app.")
    for (const r of deferred) {
      console.log(`     ${(r.user.name ?? "?").padEnd(16)} ${r.achievement.name.padEnd(24)} ` +
        `display=${r.displayOrder ?? "NULL"} home=${r.homeDisplayOrder ?? "NULL"}  ${r.id}`)
    }
  }

  if (strays.length > 0) {
    console.log("")
    console.log("  ── outside the incident ────────────────────────────────────────────")
    console.log("     Unshelved badges, which is the NORMAL state. Listed so that a wider")
    console.log("     blast radius than the incident report claimed cannot hide here.")
    for (const r of strays) {
      console.log(`     ${(r.user.name ?? "?").padEnd(16)} ${r.achievement.name.padEnd(24)} ` +
        `display=${r.displayOrder ?? "NULL"} home=${r.homeDisplayOrder ?? "NULL"}  ${r.id}`)
    }
  }

  const missing = REPAIR_ROW_IDS.filter((id) => !nulls.some((r) => r.id === id))
  if (missing.length > 0) {
    console.log("")
    console.log(`  ${missing.length} row(s) in the repair set carry a value in both columns already --`)
    console.log("  repaired by an earlier run, or the owner has since picked a shelf. Skipped.")
    for (const id of missing) console.log(`     ${id}`)
  }

  // ── group by user, decide each shelf ─────────────────────────────────────
  const byUser = new Map<string, typeof inScope>()
  for (const r of inScope) {
    const list = byUser.get(r.userId) ?? []
    list.push(r)
    byUser.set(r.userId, list)
  }

  const plan: Plan[] = []

  console.log("")
  console.log("  ══ PLAN ════════════════════════════════════════════════════════════")

  for (const [userId, rows] of byUser) {
    const name = rows[0].user.name ?? userId

    // Rule 4: the unit of repair is the shelf, not the row.
    const [total, shelved, featured] = await Promise.all([
      prisma.userAchievement.count({ where: { userId } }),
      prisma.userAchievement.count({ where: { userId, displayOrder: { not: null } } }),
      prisma.userAchievement.count({ where: { userId, homeDisplayOrder: { not: null } } }),
    ])

    console.log("")
    console.log(`  ── ${name}   (${total} badges, ${shelved} shelved, ${featured} featured)`)
    console.log(`     ${userId}`)

    if (shelved > 0) {
      console.log(`     SKIPPED -- ${shelved} slot(s) already filled, so this shelf was not wiped.`)
      continue
    }

    const candidates = [...rows].sort((a, b) => {
      const t = a.unlockedAt.getTime() - b.unlockedAt.getTime()
      if (t !== 0) return OLDEST_FIRST ? t : -t
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })

    const picked = candidates.slice(0, MAX_PROFILE_BADGES)
    const spare = candidates.slice(MAX_PROFILE_BADGES)

    picked.forEach((r, i) => {
      const home = WITH_HOME && featured === 0 && i === 0
      plan.push({ id: r.id, userId, user: name, badge: r.achievement.name, slot: i + 1, home })
      console.log(`     slot ${i + 1}   ${r.achievement.name.padEnd(24)} ` +
        `unlocked ${r.unlockedAt.toISOString()}  ${r.id}` +
        (home ? "   + homeDisplayOrder=1" : ""))
    })
    for (const r of spare) {
      console.log(`     ----     ${r.achievement.name.padEnd(24)} ` +
        `unlocked ${r.unlockedAt.toISOString()}  stays NULL (over the cap of ${MAX_PROFILE_BADGES})`)
    }
  }

  console.log("")
  console.log("  ══ TOTALS ══════════════════════════════════════════════════════════")
  console.log(`  rows that would get a displayOrder     : ${plan.length}`)
  console.log(`  rows that would get a homeDisplayOrder : ${plan.filter((p) => p.home).length}`)
  console.log(`  rows correctly left NULL               : ${nulls.length - plan.length}`)

  if (!APPLY) {
    console.log("")
    console.log("  Nothing was written. Re-run with --apply (and --live for `public`).")
    console.log("")
    await prisma.$disconnect()
    return
  }

  // ── writing ──────────────────────────────────────────────────────────────
  requireScratchSchema("scripts/backfill-null-display-order.ts")

  const before = await snapshot()

  await prisma.$transaction(async (tx) => {
    for (const p of plan) {
      // `displayOrder: null` in the WHERE is the idempotence: a second run
      // matches nothing. It is also the last line of defence -- a row that
      // gained a slot between the report and this write is not overwritten.
      await tx.userAchievement.updateMany({
        where: { id: p.id, displayOrder: null },
        data: p.home ? { displayOrder: p.slot, homeDisplayOrder: 1 } : { displayOrder: p.slot },
      })
    }
  })

  const after = await snapshot()

  // ── verification ─────────────────────────────────────────────────────────
  console.log("")
  console.log("  ══ VERIFICATION ════════════════════════════════════════════════════")

  const planned = new Map(plan.map((p) => [p.id, p]))
  const problems: string[] = []

  console.log(`  total rows  before=${before.size}  after=${after.size}  ` +
    `${before.size === after.size ? "unchanged" : "CHANGED"}`)
  if (before.size !== after.size) problems.push(`row count changed: ${before.size} -> ${after.size}`)

  let changed = 0
  for (const [id, b] of before) {
    const a = after.get(id)
    if (!a) {
      problems.push(`row disappeared: ${id}`)
      continue
    }
    if (fingerprint(a) === fingerprint(b)) continue
    changed++

    const p = planned.get(id)
    if (!p) {
      problems.push(`UNPLANNED row changed: ${id}  ${fingerprint(b)} -> ${fingerprint(a)}`)
      continue
    }
    if (b.userId !== a.userId || b.achievementId !== a.achievementId ||
        b.unlockedAt.getTime() !== a.unlockedAt.getTime()) {
      problems.push(`row ${id} changed a column it must not: ${fingerprint(b)} -> ${fingerprint(a)}`)
    }
    if (a.displayOrder !== p.slot) {
      problems.push(`row ${id} displayOrder is ${a.displayOrder}, planned ${p.slot}`)
    }
    if (a.homeDisplayOrder !== (p.home ? 1 : null)) {
      problems.push(`row ${id} homeDisplayOrder is ${a.homeDisplayOrder}, planned ${p.home ? 1 : "NULL"}`)
    }
    console.log(`  wrote  ${p.user.padEnd(16)} ${p.badge.padEnd(24)} ` +
      `displayOrder NULL -> ${a.displayOrder}` +
      (p.home ? `, homeDisplayOrder NULL -> ${a.homeDisplayOrder}` : "") + `   ${id}`)
  }
  for (const id of after.keys()) if (!before.has(id)) problems.push(`row appeared: ${id}`)

  console.log(`  rows changed : ${changed}   planned : ${plan.length}`)
  if (changed !== plan.length) problems.push(`changed ${changed} rows, planned ${plan.length}`)

  // Shelf invariants, re-read from the database rather than assumed.
  for (const userId of byUser.keys()) {
    const shelf = await prisma.userAchievement.findMany({
      where: { userId, displayOrder: { not: null } },
      select: { displayOrder: true },
      orderBy: { displayOrder: "asc" },
    })
    const slots = shelf.map((s) => s.displayOrder!)
    const home = await prisma.userAchievement.count({
      where: { userId, homeDisplayOrder: { not: null } },
    })
    console.log(`  shelf ${userId}  slots=[${slots.join(",")}]  featured=${home}`)
    if (slots.length > MAX_PROFILE_BADGES) {
      problems.push(`user ${userId} has ${slots.length} shelved, cap is ${MAX_PROFILE_BADGES}`)
    }
    if (!slots.every((s, i) => s === i + 1)) {
      problems.push(`user ${userId} slots are not 1..n: [${slots.join(",")}]`)
    }
    if (home > 1) {
      problems.push(`user ${userId} has ${home} featured badges, at most one is allowed`)
    }
  }

  console.log("")
  if (problems.length === 0) {
    console.log("  OK -- every changed row was planned, every other row is byte-identical,")
    console.log("  the row count held, and no shelf exceeds the cap or holds two featured badges.")
  } else {
    console.log("  PROBLEMS:")
    for (const p of problems) console.log(`    ${p}`)
  }
  console.log("")

  await prisma.$disconnect()
  process.exit(problems.length === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
