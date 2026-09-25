/**
 * Does `expirePerishableItems()` write to the schema its connection names?
 *
 * Run: .\scripts\scratch.ps1 -Run scripts\verify-perishable-schema-qualification.ts
 *
 * ── THE BUG THIS CATCHES ────────────────────────────────────────────────────
 *
 * `$executeRaw` sends SQL through the driver verbatim. The driver adapter's
 * `{ schema }` option qualifies the MODEL queries Prisma builds; it does not
 * rewrite a raw string, and nothing sets `search_path`. So an unqualified
 * `UPDATE "Item"` resolved against the connection's default search_path --
 * `public`, the LIVE database -- no matter what `?schema=` said. A harness
 * pointed at scratch_x was updating live rows and reporting scratch counts.
 *
 * ── HOW IT PROVES IT, RATHER THAN ASSERTING IT ──────────────────────────────
 *
 * One perishable row, already past its window, is created IN THE SCRATCH
 * SCHEMA through Prisma's model API (which does honour the adapter's schema).
 * Then the same WHERE clause is run twice against the same connection:
 *
 *   unqualified   UPDATE "Item"              -> hits public   -> 0 rows
 *   qualified     UPDATE "scratch_x"."Item"  -> hits scratch  -> 1 row
 *
 * The 0-vs-1 split IS the bug: same clause, same connection, two schemas. The
 * harness asserts that the unqualified form is still blind to the fixture (so
 * the test cannot pass for the wrong reason) and that the live counters either
 * side of the run are identical (so the proof never costs a live row).
 *
 * Read-only against `public` throughout: it counts there and never writes.
 */
import prisma, { databaseSchema } from "../src/lib/prisma"
import { expirePerishableItems } from "../src/lib/perishable"

const TAG = `perish-qual-${Date.now()}`

let failures = 0
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

/** Live counts, read straight out of `public` by name. Never written. */
async function liveCounts(): Promise<{ perishable: number; expired: number; due: number }> {
  const [row] = await prisma.$queryRaw<Array<{ perishable: bigint; expired: bigint; due: bigint }>>`
    SELECT COUNT(*) FILTER (WHERE "isPerishable")                       AS perishable,
           COUNT(*) FILTER (WHERE "status" = 'EXPIRED')                 AS expired,
           COUNT(*) FILTER (WHERE "isPerishable"
                              AND "status" = 'AVAILABLE'
                              AND "tradeWithinHours" IS NOT NULL
                              AND "createdAt" + make_interval(hours => "tradeWithinHours") < now()) AS due
    FROM "public"."Item"`
  return { perishable: Number(row.perishable), expired: Number(row.expired), due: Number(row.due) }
}

/** A due perishable in whatever schema the client is bound to. */
async function fixture(userId: string, title: string): Promise<string> {
  const item = await prisma.item.create({
    data: {
      title: `${TAG} ${title}`,
      description: "perishable fixture",
      images: "[]",
      category: "OTHER",
      condition: "GOOD",
      status: "AVAILABLE",
      isPerishable: true,
      tradeWithinHours: 6,
      // Ten hours old against a six-hour window: due, by a clear margin.
      createdAt: new Date(Date.now() - 10 * 60 * 60 * 1000),
      userId,
    },
    select: { id: true },
  })
  return item.id
}

async function main() {
  const schema = databaseSchema()
  console.log(`\n  schema: ${schema}`)

  if (schema === "public") {
    console.error("\n  REFUSING TO RUN on `public`: this harness creates a perishable row and")
    console.error("  expires it. Run it on a scratch schema:")
    console.error("      .\\scripts\\scratch.ps1 -Run scripts\\verify-perishable-schema-qualification.ts\n")
    process.exit(2)
  }

  const before = await liveCounts()
  console.log(
    `  live (public) before: perishable=${before.perishable} EXPIRED=${before.expired} due=${before.due}\n`,
  )

  let userId = ""
  try {
    const user = await prisma.user.create({
      data: { name: TAG, email: `${TAG}@example.invalid`, isVerified: true },
      select: { id: true },
    })
    userId = user.id

    const first = await fixture(userId, "tray of fish")

    // The fixture must be visible to the model API (which is schema-aware) and
    // INVISIBLE to an unqualified raw read. That second half is what makes the
    // 0-vs-1 below mean "wrong schema" rather than "clause matched nothing".
    const [seen] = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*) AS n FROM "Item" WHERE "id" = ${first}`
    check(
      "fixture is invisible to an UNQUALIFIED raw read (raw SQL leaves the schema)",
      Number(seen.n) === 0,
      `unqualified SELECT found ${seen.n} row(s) for a scratch-only id`,
    )

    // ── 1 ── the original failure, reproduced verbatim: unqualified first.
    const unqualified = await prisma.$executeRaw`
      UPDATE "Item"
         SET "status" = 'EXPIRED', "updatedAt" = now()
       WHERE "userId" = ${userId}
         AND "isPerishable" = true
         AND "status" = 'AVAILABLE'
         AND "tradeWithinHours" IS NOT NULL
         AND "createdAt" + make_interval(hours => "tradeWithinHours") < now()`
    check(
      "unqualified UPDATE moves 0 rows (it is looking at public, not scratch)",
      unqualified === 0,
      `moved ${unqualified}`,
    )

    const stillAvailable = await prisma.item.findUnique({
      where: { id: first },
      select: { status: true },
    })
    check(
      "fixture is untouched by the unqualified UPDATE",
      stillAvailable?.status === "AVAILABLE",
      `status is ${stillAvailable?.status}`,
    )

    // ── 2 ── the function under test, on the same connection, same clause.
    const moved = await expirePerishableItems(prisma, { userId })
    check("userId-scoped expirePerishableItems() moves 1 row in scratch", moved === 1, `moved ${moved}`)

    const after = await prisma.item.findUnique({ where: { id: first }, select: { status: true } })
    check("the scratch fixture is now EXPIRED", after?.status === "EXPIRED", `status is ${after?.status}`)

    // ── 3 ── the itemId and unscoped variants take the same route.
    const second = await fixture(userId, "second tray")
    const byItem = await expirePerishableItems(prisma, { itemId: second })
    check("itemId-scoped variant moves 1 row in scratch", byItem === 1, `moved ${byItem}`)
    const secondAfter = await prisma.item.findUnique({ where: { id: second }, select: { status: true } })
    check("the second fixture is EXPIRED", secondAfter?.status === "EXPIRED", `status is ${secondAfter?.status}`)

    const third = await fixture(userId, "third tray")
    const unscoped = await expirePerishableItems(prisma)
    check("unscoped variant moves the remaining scratch row", unscoped === 1, `moved ${unscoped}`)
    const thirdAfter = await prisma.item.findUnique({ where: { id: third }, select: { status: true } })
    check("the third fixture is EXPIRED", thirdAfter?.status === "EXPIRED", `status is ${thirdAfter?.status}`)

    // ── 3b ── the owner was told, once per expiry, in scratch (25 Sep 2026).
    // The notice is written by the Prisma model API inside the sweep's
    // transaction, so it lands where the adapter's schema says -- and a sweep
    // that finds nothing AVAILABLE writes nothing.
    const notices = await prisma.notification.findMany({
      where: { userId, type: "LISTING_EXPIRED" },
      select: { entityType: true, entityId: true },
    })
    check("one LISTING_EXPIRED notice per expired fixture", notices.length === 3, `found ${notices.length}`)
    check(
      "each notice points at its listing via listing_review",
      [first, second, third].every((id) =>
        notices.some((n) => n.entityType === "listing_review" && n.entityId === id),
      ),
    )
    const again = await expirePerishableItems(prisma, { userId })
    const noticesAgain = await prisma.notification.count({ where: { userId, type: "LISTING_EXPIRED" } })
    check("a second sweep moves nothing and notifies nobody", again === 0 && noticesAgain === 3, `moved ${again}, notices ${noticesAgain}`)
  } finally {
    if (userId) await prisma.user.deleteMany({ where: { id: userId } })
  }

  // ── 4 ── nothing above cost a live row.
  const after = await liveCounts()
  console.log(
    `\n  live (public) after:  perishable=${after.perishable} EXPIRED=${after.expired} due=${after.due}`,
  )
  check(
    "live perishable count unchanged",
    after.perishable === before.perishable,
    `${before.perishable} -> ${after.perishable}`,
  )
  check("live EXPIRED count unchanged", after.expired === before.expired, `${before.expired} -> ${after.expired}`)
  // `::text` because live may not have the enum value yet, and comparing an
  // enum column to a label it lacks is an error rather than a zero.
  const [liveNotices] = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*) AS n FROM "public"."Notification" WHERE "type"::text = 'LISTING_EXPIRED'`
  check("no LISTING_EXPIRED notice was written to live", Number(liveNotices.n) === 0, `${liveNotices.n} row(s)`)

  console.log(failures === 0 ? "\n  all checks passed\n" : `\n  ${failures} check(s) failed\n`)
  await prisma.$disconnect()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
