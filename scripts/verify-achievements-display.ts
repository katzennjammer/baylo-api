/**
 * PATCH /api/v1/achievements/display: schema qualification and SQL injection.
 *
 * Run (needs a dev server bound to the SAME scratch schema):
 *   .\scripts\scratch.ps1 -Push -Name scratch_ach
 *   .\scripts\scratch.ps1 -Dev  -Name scratch_ach -Port 3001
 *   # ...in another window:
 *   $env:DATABASE_URL="<base>?schema=scratch_ach"
 *   $env:BAYLO_BASE_URL="http://localhost:3001"
 *   npx tsx --env-file=.env scripts\verify-achievements-display.ts
 *
 * ── TWO BUGS, ONE ROUTE, FIVE STATEMENTS ────────────────────────────────────
 *
 * Until 23 Sep 2026 the five UPDATEs in this route were `$executeRawUnsafe`
 * with the ids spliced into the SQL text, and unqualified table names.
 *
 *   INJECTION.  `session.user.id` was interpolated with NO escaping into two of
 *   them (the other ids got `.replace(/'/g, "''")`, it did not). The id reaches
 *   the route from the User row behind the bearer token, so an id containing
 *   one apostrophe rewrites the WHERE clause. `x' OR '1'='1` turns the blanket
 *   reset into "clear EVERY user's shelf" -- a cross-tenant write from an
 *   ordinary signed-in request.
 *
 *   SCHEMA.  Raw SQL ignores the adapter's `?schema=`, so `UPDATE
 *   "UserAchievement"` resolved through `search_path` to `public` -- live.
 *   Live carries real shelf rows (15 rows / 6 shelved at the time of the fix),
 *   so unlike the perishable sweep this one had something to destroy.
 *
 * ── HOW EACH IS PROVED RATHER THAN ASSERTED ─────────────────────────────────
 *
 * Both halves carry a CONTROL that must come out WRONG, so neither can pass
 * for the wrong reason:
 *
 *   schema     an unqualified UPDATE, issued by this harness on the same
 *              connection, must still move 0 rows -- if it ever moves 1, the
 *              connection is not actually split across two schemas and the
 *              positive check below proves nothing.
 *
 *   injection  the payload is first fired at a DELIBERATELY VULNERABLE copy of
 *              statement 1, built here by string concatenation exactly as the
 *              route used to build it. That must wipe the victim's shelf. Only
 *              then is the same payload sent through the real route, which must
 *              leave the victim alone. A test that only ever sees the fixed
 *              route cannot tell a closed vector from a payload that never
 *              worked.
 *
 * ── NEVER POINT THIS AT A SERVER RUNNING THE PRE-FIX ROUTE ──────────────────
 *
 * Read that twice. The bug under test is "this route's writes land in public",
 * and the injection payload makes the blanket reset match EVERY row. Driving
 * the unfixed route over HTTP therefore does not demonstrate the bug, it
 * performs it: on 23 Sep 2026 exactly that nulled `displayOrder` and
 * `homeDisplayOrder` on all fifteen live rows, and the previous values were
 * not recoverable from the 18 Sep backup, which predates nine of them.
 *
 * The "before" evidence is obtained WITHOUT the unfixed route, and that is the
 * whole design: the unqualified control is scoped to a userId that exists only
 * in scratch, and the exploitability control builds the vulnerable string here,
 * schema-qualified to scratch. Both show the mechanism; neither can reach live.
 *
 * `snapshotLiveShelf()` is the seatbelt that was missing. Live `public` is
 * copied row by row before anything runs, counted before and after, and written
 * back in the `finally` regardless of outcome.
 */
import prisma, { databaseSchema } from "../src/lib/prisma"
import { signAccessToken } from "../src/lib/auth-tokens"

const BASE = process.env.BAYLO_BASE_URL ?? "http://localhost:3001"
const TAG = `ach-display-${Date.now()}`

/** One apostrophe is the whole exploit: it closes the literal the id sits in. */
const INJECTION_ID = `${TAG}-atk' OR '1'='1`

let failures = 0
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

/**
 * ── THE SEATBELT, AND WHY IT IS HERE ────────────────────────────────────────
 *
 * On 23 Sep 2026 an earlier version of this harness was pointed at a dev server
 * running the UNFIXED route. That is not a hypothetical: the bug under test is
 * "writes land in public", the injection payload makes the WHERE match every
 * row, and the two together nulled `displayOrder` and `homeDisplayOrder` on all
 * fifteen live rows. The aggregate check at the end NOTICED -- and noticing
 * afterwards is worth nothing, because the previous values were gone.
 *
 * So the counters are no longer the only protection. Every live row's two
 * nullable columns are copied out before anything runs and written back in the
 * `finally`, whatever happened in between. Restoring is unconditional and
 * idempotent: if nothing strayed it rewrites the same values.
 *
 * This does NOT make it safe to run this harness against the unfixed route --
 * nothing does, and the header says so. It makes the accident survivable.
 */
interface ShelfSnapshot {
  id: string
  displayOrder: number | null
  homeDisplayOrder: number | null
}

async function snapshotLiveShelf(): Promise<ShelfSnapshot[]> {
  return prisma.$queryRaw<ShelfSnapshot[]>`
    SELECT "id", "displayOrder", "homeDisplayOrder"
    FROM "public"."UserAchievement"
    ORDER BY "id"`
}

/** Puts every snapshotted value back. Returns how many rows actually differed. */
async function restoreLiveShelf(snapshot: ShelfSnapshot[]): Promise<number> {
  let changed = 0
  for (const row of snapshot) {
    const moved = await prisma.$executeRaw`
      UPDATE "public"."UserAchievement"
         SET "displayOrder"     = ${row.displayOrder},
             "homeDisplayOrder" = ${row.homeDisplayOrder}
       WHERE "id" = ${row.id}
         AND ("displayOrder"     IS DISTINCT FROM ${row.displayOrder}
          OR  "homeDisplayOrder" IS DISTINCT FROM ${row.homeDisplayOrder})`
    changed += moved
  }
  return changed
}

async function liveShelf(): Promise<{ rows: number; shelved: number; featured: number; sum: number }> {
  const [r] = await prisma.$queryRaw<Array<{ rows: bigint; shelved: bigint; featured: bigint; sum: bigint }>>`
    SELECT COUNT(*)                                               AS rows,
           COUNT(*) FILTER (WHERE "displayOrder" IS NOT NULL)     AS shelved,
           COUNT(*) FILTER (WHERE "homeDisplayOrder" IS NOT NULL) AS featured,
           COALESCE(SUM("displayOrder"), 0)                       AS sum
    FROM "public"."UserAchievement"`
  return {
    rows: Number(r.rows),
    shelved: Number(r.shelved),
    featured: Number(r.featured),
    sum: Number(r.sum),
  }
}

/**
 * The envelope is unwrapped here, and `ok` is read out of `data` rather than off
 * the top level, because the lazy version of this ( `body?.ok !== false` ) passes
 * on a 404 HTML page — `undefined !== false` — which is exactly how a first run
 * of this harness reported "PATCH reports ok" against a route that was not
 * being reached at all.
 */
async function patch(token: string, body: unknown) {
  const res = await fetch(`${BASE}/api/v1/achievements/display`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const envelope = (await res.json().catch(() => null)) as {
    data?: { ok?: boolean; error?: string }
  } | null
  return { status: res.status, ok: envelope?.data?.ok === true, envelope }
}

/** A user with an id we choose, so the session can carry a hostile one. */
async function makeUser(id: string, label: string) {
  return prisma.user.create({
    data: { id, name: `${TAG} ${label}`, email: `${TAG}-${label}@example.invalid`, isVerified: true },
    select: { id: true },
  })
}

async function shelfOf(userId: string) {
  return prisma.userAchievement.findMany({
    where: { userId },
    select: { achievementId: true, displayOrder: true, homeDisplayOrder: true },
    orderBy: { achievementId: "asc" },
  })
}

async function main() {
  const schema = databaseSchema()
  console.log(`\n  schema: ${schema}`)
  console.log(`  base:   ${BASE}`)

  if (schema === "public") {
    console.error("\n  REFUSING TO RUN on `public`: this harness fires a working SQL-injection")
    console.error("  payload at a deliberately vulnerable statement. Run it on a scratch schema.\n")
    process.exit(2)
  }

  // The server must be on THIS schema, or every check below is meaningless.
  const probe = await fetch(`${BASE}/api/v1/achievements/display`, { method: "PATCH" }).catch(() => null)
  if (!probe) {
    console.error(`\n  No server at ${BASE}. Start one bound to ${schema}:`)
    console.error(`      .\\scripts\\scratch.ps1 -Dev -Name ${schema} -Port 3001\n`)
    process.exit(2)
  }

  const liveSnapshot = await snapshotLiveShelf()
  const liveBefore = await liveShelf()
  console.log(
    `  live (public) before: rows=${liveBefore.rows} shelved=${liveBefore.shelved} ` +
      `featured=${liveBefore.featured} sum=${liveBefore.sum}  (snapshotted ${liveSnapshot.length} rows)\n`,
  )

  const createdUserIds: string[] = []
  try {
    // ── fixtures ────────────────────────────────────────────────────────────
    const badges = await Promise.all(
      ["alpha", "beta", "gamma"].map((k, i) =>
        prisma.achievement.create({
          data: {
            key: `${TAG}-${k}`,
            name: `${TAG} ${k}`,
            description: "fixture",
            criterion: "COMPLETED_TRADES",
            threshold: 1,
            sortOrder: i,
          },
          select: { id: true },
        }),
      ),
    )

    const victim = await makeUser(`${TAG}-victim`, "victim")
    createdUserIds.push(victim.id)
    const attacker = await makeUser(INJECTION_ID, "attacker")
    createdUserIds.push(attacker.id)

    // Both users hold all three badges; the victim's shelf is already set.
    for (const u of [victim.id, attacker.id]) {
      await prisma.userAchievement.createMany({
        data: badges.map((b, i) => ({
          userId: u,
          achievementId: b.id,
          displayOrder: u === victim.id ? i + 1 : null,
          homeDisplayOrder: u === victim.id && i === 0 ? 1 : null,
        })),
      })
    }

    console.log("schema qualification")

    // CONTROL. Same clause the route runs, unqualified, on this connection. It
    // must find nothing: these userIds exist only in scratch.
    const strayed = await prisma.$executeRaw`
      UPDATE "UserAchievement" SET "displayOrder" = NULL WHERE "userId" = ${victim.id}`
    check(
      "control: an UNQUALIFIED UPDATE moves 0 rows (it is looking at public)",
      strayed === 0,
      `moved ${strayed} — the connection is not split across two schemas, so nothing below proves anything`,
    )
    const victimIntact = await shelfOf(victim.id)
    check(
      "control: the scratch fixture survived the unqualified UPDATE",
      victimIntact.every((r) => r.displayOrder !== null),
      JSON.stringify(victimIntact),
    )

    // POSITIVE. The route, reached over HTTP, must move the scratch rows.
    const victimToken = await signAccessToken(victim.id)
    const reorder = await patch(victimToken, {
      achievementIds: [badges[2].id, badges[0].id],
      featuredAchievementId: badges[2].id,
    })
    check("PATCH as the victim returns 200", reorder.status === 200, `status ${reorder.status}`)
    check("PATCH reports ok:true in its envelope", reorder.ok, JSON.stringify(reorder.envelope))

    const afterReorder = await shelfOf(victim.id)
    const byId = new Map(afterReorder.map((r) => [r.achievementId, r]))
    check(
      "the route wrote the new order INTO THE SCRATCH SCHEMA",
      byId.get(badges[2].id)?.displayOrder === 1 && byId.get(badges[0].id)?.displayOrder === 2,
      JSON.stringify(afterReorder),
    )
    check(
      "the deselected badge left the shelf",
      byId.get(badges[1].id)?.displayOrder === null,
      JSON.stringify(byId.get(badges[1].id)),
    )
    check(
      "the featured badge was set (homeDisplayOrder path)",
      byId.get(badges[2].id)?.homeDisplayOrder === 1,
      JSON.stringify(byId.get(badges[2].id)),
    )
    check(
      "the previously featured badge was unfeatured",
      byId.get(badges[0].id)?.homeDisplayOrder === null,
      JSON.stringify(byId.get(badges[0].id)),
    )

    // ── THE GATE. NOTHING HOSTILE IS SENT UNTIL THIS PASSES ─────────────────
    //
    // Everything above used ORDINARY ids, which is what makes it a safe canary:
    // against an UNFIXED route those statements still go to `public`, but their
    // WHERE names a userId that exists only in scratch, so they match nothing
    // and harm nothing. They fail loudly instead.
    //
    // The injection section below is the opposite. Its whole point is a WHERE
    // that matches every row, so on an unfixed route it is not a test, it is
    // the incident. It therefore runs ONLY once the checks above have proved
    // the route's writes stay in the scratch schema.
    if (failures > 0) {
      console.log("")
      console.log("  ABORTING BEFORE THE INJECTION SECTION.")
      console.log("  The schema-qualification checks above did not pass, which means this")
      console.log("  server's writes are not provably confined to the scratch schema. Sending")
      console.log("  a payload whose WHERE matches every row would hit live `public`.")
      console.log("  Fix the route, restart the server, and re-run.")
      throw new Error("schema qualification unproven — refusing to send the injection payload")
    }

    console.log("\nSQL injection via session.user.id")

    // Re-shelve the victim so the payload has something to destroy.
    await prisma.userAchievement.updateMany({
      where: { userId: victim.id },
      data: { displayOrder: 1 },
    })

    // CONTROL. The payload, against statement 1 built the way the route used to
    // build it. This MUST wipe the victim -- it is the vector, demonstrated.
    const vulnerable = `UPDATE "${schema}"."UserAchievement" SET "displayOrder" = NULL WHERE "userId" = '${attacker.id}'`
    const wiped = await prisma.$executeRawUnsafe(vulnerable)
    const victimAfterExploit = await shelfOf(victim.id)
    check(
      "control: the OLD unescaped interpolation is exploitable (payload wipes other users)",
      wiped > 3 && victimAfterExploit.every((r) => r.displayOrder === null),
      `moved ${wiped} row(s); victim now ${JSON.stringify(victimAfterExploit)} — if this passes trivially the payload is inert and the check below is vacuous`,
    )

    // Restore, then send the SAME payload through the real route.
    await prisma.userAchievement.updateMany({
      where: { userId: victim.id },
      data: { displayOrder: 1 },
    })

    const attackerToken = await signAccessToken(attacker.id)
    const attack = await patch(attackerToken, { achievementIds: [], featuredAchievementId: null })
    check("PATCH with a hostile session id still returns 200", attack.status === 200, `status ${attack.status}`)

    const victimAfterRoute = await shelfOf(victim.id)
    check(
      "the victim's shelf is UNTOUCHED by the hostile id (injection closed)",
      victimAfterRoute.length === 3 && victimAfterRoute.every((r) => r.displayOrder === 1),
      JSON.stringify(victimAfterRoute),
    )

    const attackerAfter = await shelfOf(attacker.id)
    check(
      "the hostile id was treated as an ordinary id (its OWN shelf cleared)",
      attackerAfter.length === 3 && attackerAfter.every((r) => r.displayOrder === null),
      JSON.stringify(attackerAfter),
    )

    // The same payload through the CASE/IN statement, which takes the id twice.
    await prisma.userAchievement.updateMany({ where: { userId: victim.id }, data: { displayOrder: 1 } })
    const attack2 = await patch(attackerToken, {
      achievementIds: [badges[0].id, badges[1].id],
      featuredAchievementId: badges[0].id,
    })
    check("PATCH (CASE/IN path) with a hostile session id returns 200", attack2.status === 200, `status ${attack2.status}`)
    const victimAfter2 = await shelfOf(victim.id)
    check(
      "the victim survives the CASE/IN statement too",
      victimAfter2.every((r) => r.displayOrder === 1),
      JSON.stringify(victimAfter2),
    )
    const attackerAfter2 = await shelfOf(attacker.id)
    const atk = new Map(attackerAfter2.map((r) => [r.achievementId, r]))
    check(
      "the hostile user's own reorder still worked",
      atk.get(badges[0].id)?.displayOrder === 1 && atk.get(badges[1].id)?.displayOrder === 2,
      JSON.stringify(attackerAfter2),
    )

    // A metacharacter in the BODY ids, which is the other half of the surface.
    const attack3 = await patch(victimToken, {
      achievementIds: [`${badges[0].id}' OR '1'='1`],
      featuredAchievementId: `x'; DROP TABLE "UserAchievement"; --`,
    })
    check("PATCH with hostile body ids returns 200", attack3.status === 200, `status ${attack3.status}`)
    const tableStillThere = await prisma.userAchievement.count()
    check(
      "the table still exists after a DROP TABLE payload in the body",
      tableStillThere > 0,
      `count ${tableStillThere}`,
    )

    console.log("\nno stray writes")
  } finally {
    for (const id of createdUserIds) {
      await prisma.user.deleteMany({ where: { id } })
    }
    await prisma.achievement.deleteMany({ where: { key: { startsWith: TAG } } })

    // Unconditional, and it runs even when an assertion above threw. See the
    // note on snapshotLiveShelf().
    const repaired = await restoreLiveShelf(liveSnapshot)
    if (repaired > 0) {
      console.log("")
      console.log("  ##################################################################")
      console.log(`  #  ${String(repaired).padEnd(3)} LIVE ROW(S) STRAYED AND WERE RESTORED FROM SNAPSHOT  #`)
      console.log("  ##################################################################")
      failures++
    }
  }

  const liveAfter = await liveShelf()
  console.log(
    `  live (public) after:  rows=${liveAfter.rows} shelved=${liveAfter.shelved} ` +
      `featured=${liveAfter.featured} sum=${liveAfter.sum}`,
  )
  check("live row count unchanged", liveAfter.rows === liveBefore.rows, `${liveBefore.rows} -> ${liveAfter.rows}`)
  check(
    "live displayOrder count unchanged",
    liveAfter.shelved === liveBefore.shelved,
    `${liveBefore.shelved} -> ${liveAfter.shelved}`,
  )
  check(
    "live homeDisplayOrder count unchanged",
    liveAfter.featured === liveBefore.featured,
    `${liveBefore.featured} -> ${liveAfter.featured}`,
  )
  check(
    "live SUM(displayOrder) unchanged",
    liveAfter.sum === liveBefore.sum,
    `${liveBefore.sum} -> ${liveAfter.sum}`,
  )

  console.log(failures === 0 ? "\n  all checks passed\n" : `\n  ${failures} check(s) failed\n`)
  await prisma.$disconnect()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
