/**
 * Perishables and category-match notifications, over real HTTP.
 *
 * Run (with `npm run dev` up):
 *   npx tsx --env-file=.env scripts/verify-perishable-http.ts
 *
 * ── WHY THIS CANNOT BE A LIBRARY TEST ───────────────────────────────────────
 *
 * `notifyCategoryMatchesAsync()` is fire-and-forget and is called from the
 * create route, not from a library anything else can drive. So the only way to
 * find out whether posting a listing actually notifies anybody is to post a
 * listing and then look for the notification — which is what this does.
 *
 * It is also the only place the perishable rule is exercised end to end: the
 * schema refusals (a unit with no quantity, a window on a standard item) live
 * in zod and are invisible to a library-level test that constructs rows
 * directly.
 *
 * ── THE POLL IS NOT A SLEEP ─────────────────────────────────────────────────
 *
 * The notification write is deliberately not awaited by the route — the whole
 * point is that posting does not wait on twenty-five writes — so it lands
 * shortly AFTER the 201. This polls for it with a deadline rather than sleeping
 * a fixed guess, so a fast machine finishes immediately and a slow one still
 * passes.
 */

import prisma from "../src/lib/prisma"
import { signAccessToken } from "../src/lib/auth-tokens"
import { valueCap } from "../src/lib/trade-rules"
import { bracketOf } from "../src/lib/brackets"
import { decideItemValue } from "../src/lib/valuation-server"
import { requireScratchSchema } from "./lib/live-guard"

const BASE = process.env.BAYLO_BASE_URL ?? "http://localhost:3000"

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  ok    ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

async function post(token: string, body: unknown) {
  const res = await fetch(`${BASE}/api/items`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

/** Wait for a row the route writes after responding. See the header. */
async function waitFor<T>(
  find: () => Promise<T | null>,
  timeoutMs = 8000,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await find()
    if (found) return found
    if (Date.now() > deadline) return null
    await new Promise((r) => setTimeout(r, 150))
  }
}

async function main() {
  requireScratchSchema("scripts/verify-perishable-http.ts")
  try {
    await fetch(`${BASE}/api/v1/hubs`)
  } catch {
    console.error(`No server at ${BASE}. Start it with \`npm run dev\` first.`)
    process.exit(2)
  }

  const tag = `verify-perish-${Date.now()}`
  const users: string[] = []

  try {
    const poster = await prisma.user.create({
      data: {
        name: `${tag}-poster`,
        email: `${tag}-poster@test.invalid`,
        isVerified: true,
        idVerifiedGrandfatheredAt: new Date(),
      },
      select: { id: true },
    })
    users.push(poster.id)

    // WANTS FOOD, owns PLANTS. The mutual case.
    const wanter = await prisma.user.create({
      data: {
        name: `${tag}-wanter`,
        email: `${tag}-wanter@test.invalid`,
        isVerified: true,
        idVerifiedGrandfatheredAt: new Date(),
      },
      select: { id: true },
    })
    users.push(wanter.id)

    // Says nothing about what it wants. Must never be notified.
    const silent = await prisma.user.create({
      data: {
        name: `${tag}-silent`,
        email: `${tag}-silent@test.invalid`,
        isVerified: true,
        idVerifiedGrandfatheredAt: new Date(),
      },
      select: { id: true },
    })
    users.push(silent.id)

    await prisma.item.create({
      data: {
        title: `${tag} wanter plants`,
        description: "x",
        images: "[]",
        category: "PLANTS",
        condition: "GOOD",
        status: "AVAILABLE",
        userId: wanter.id,
        lookingForCategories: ["FOOD"],
      },
    })
    await prisma.item.create({
      data: {
        title: `${tag} silent books`,
        description: "x",
        images: "[]",
        category: "BOOKS",
        condition: "GOOD",
        status: "AVAILABLE",
        userId: silent.id,
        lookingForCategories: [],
      },
    })

    const token = await signAccessToken(poster.id)

    // ── the matcher ───────────────────────────────────────────────────────
    console.log("\ncategory-match notifications")

    const created = await post(token, {
      title: `${tag} fresh fish`,
      description: "x",
      category: "FOOD",
      condition: "NEW",
      images: [],
      lookingForCategories: ["PLANTS"],
    })
    check("the listing posts", created.status === 201, `status ${created.status}`)
    const itemId = String(created.body.id)

    const notification = await waitFor(() =>
      prisma.notification.findFirst({
        where: { userId: wanter.id, type: "CATEGORY_MATCH", entityId: itemId },
        select: { id: true, message: true, actorId: true, entityType: true },
      }),
    )
    check("the person who asked for FOOD is notified", notification != null)
    check(
      "the message names both categories",
      !!notification && notification.message.includes("Food") && notification.message.includes("Plants"),
      notification?.message,
    )
    check(
      "the mutual overlap is worded as such",
      !!notification && notification.message.includes("looking for"),
      notification?.message,
    )
    check(
      "it routes to the item, not a trade or a chat",
      notification?.entityType === "item",
      String(notification?.entityType),
    )
    check(
      "IT HAS NO ACTOR — nobody did this to them",
      notification?.actorId === null,
      String(notification?.actorId),
    )

    const silentNotified = await prisma.notification.count({
      where: { userId: silent.id, type: "CATEGORY_MATCH" },
    })
    check("somebody who stated no preference is NOT notified", silentNotified === 0)

    const selfNotified = await prisma.notification.count({
      where: { userId: poster.id, type: "CATEGORY_MATCH", entityId: itemId },
    })
    check("the poster is not notified about their own listing", selfNotified === 0)

    // ── the perishable rule ───────────────────────────────────────────────
    console.log("\nperishables")

    const probe = await decideItemValue("FOOD", "NEW", null)
    const cap = valueCap(probe.data.suggestedLeaves)

    const perishable = await post(token, {
      title: `${tag} perishable fish`,
      description: "x",
      category: "FOOD",
      condition: "NEW",
      images: [],
      isPerishable: true,
      quantity: 2.5,
      quantityUnit: "KG",
      tradeWithinHours: 6,
      lookingForCategories: ["PLANTS"],
    })
    check("a perishable posts", perishable.status === 201, `status ${perishable.status}`)
    check(
      "it is AVAILABLE, never PENDING_REVIEW",
      perishable.body.status === "AVAILABLE" || perishable.body.status === undefined,
      String(perishable.body.status),
    )

    const perishRow = await prisma.item.findUnique({
      where: { id: String(perishable.body.id) },
      select: { isPerishable: true, quantity: true, quantityUnit: true, tradeWithinHours: true, status: true },
    })
    check("the perishable columns are written", perishRow?.isPerishable === true)
    check("the quantity survives as a float", perishRow?.quantity === 2.5, String(perishRow?.quantity))
    check("the unit is stored", perishRow?.quantityUnit === "KG", String(perishRow?.quantityUnit))
    check("the window is stored", perishRow?.tradeWithinHours === 6, String(perishRow?.tradeWithinHours))

    // THE SECURITY PROPERTY: a perishable cannot buy itself a bracket.
    if (cap.maxValueWithoutReview != null) {
      const greedy = await post(token, {
        title: `${tag} gold fish`,
        description: "x",
        category: "FOOD",
        condition: "NEW",
        images: [],
        isPerishable: true,
        tradeWithinHours: 24,
        valueLeaves: cap.maxValueWithoutReview * 50,
      })
      check("an over-valued perishable still posts", greedy.status === 201, `status ${greedy.status}`)
      const greedyRow = await prisma.item.findUnique({
        where: { id: String(greedy.body.id) },
        select: { valueLeaves: true, status: true },
      })
      check(
        "IT IS CLAMPED TO THE CAP, not granted",
        greedyRow?.valueLeaves === cap.maxValueWithoutReview,
        `got ${greedyRow?.valueLeaves}, cap ${cap.maxValueWithoutReview}`,
      )
      check(
        "its bracket is inside the unreviewed cap",
        bracketOf(greedyRow?.valueLeaves ?? 0) <= cap.maxBracketWithoutReview,
      )
      check("it went live rather than to review", greedyRow?.status === "AVAILABLE")
      check(
        "and the owner is told what happened",
        (greedy.body.valueReview as { clamped?: boolean } | undefined)?.clamped === true,
      )

      // The same value WITHOUT the perishable flag must still be parked.
      const standard = await post(token, {
        title: `${tag} gold standard`,
        description: "x",
        category: "FOOD",
        condition: "NEW",
        images: [],
        valueLeaves: cap.maxValueWithoutReview * 50,
      })
      const standardRow = await prisma.item.findUnique({
        where: { id: String(standard.body.id) },
        select: { status: true, valueLeaves: true },
      })
      check(
        "THE SAME VALUE ON A STANDARD ITEM IS STILL PARKED",
        standardRow?.status === "PENDING_REVIEW",
        String(standardRow?.status),
      )
    } else {
      console.log("  skip  FOOD/NEW suggests into the open bracket; the clamp is unreachable")
    }

    // ── the schema refusals ───────────────────────────────────────────────
    console.log("\nimpossible combinations are refused")

    const noUnit = await post(token, {
      title: `${tag} bad`,
      description: "x",
      category: "FOOD",
      condition: "NEW",
      images: [],
      isPerishable: true,
      tradeWithinHours: 6,
      quantity: 3,
    })
    check("a quantity with no unit is refused", noUnit.status === 400, `status ${noUnit.status}`)

    const noWindow = await post(token, {
      title: `${tag} bad2`,
      description: "x",
      category: "FOOD",
      condition: "NEW",
      images: [],
      isPerishable: true,
    })
    check("a perishable with no window is refused", noWindow.status === 400, `status ${noWindow.status}`)

    const windowOnStandard = await post(token, {
      title: `${tag} bad3`,
      description: "x",
      category: "FOOD",
      condition: "NEW",
      images: [],
      tradeWithinHours: 6,
    })
    check(
      "a window on a standard item is refused",
      windowOnStandard.status === 400,
      `status ${windowOnStandard.status}`,
    )

    const tooManyWants = await post(token, {
      title: `${tag} bad4`,
      description: "x",
      category: "FOOD",
      condition: "NEW",
      images: [],
      lookingForCategories: ["PLANTS", "BOOKS", "TOYS", "TOOLS", "MUSIC", "ART", "PETS"],
    })
    check(
      "more than six wanted categories is refused",
      tooManyWants.status === 400,
      `status ${tooManyWants.status}`,
    )
  } finally {
    // Match notifications land on OTHER people's accounts -- anyone whose
    // listing wants what this posted -- so deleting by our own user ids misses
    // exactly the ones that matter. Delete by the listing they point at, BEFORE
    // the listings go (24 Sep 2026: nine orphans on a real account).
    const postedIds = (
      await prisma.item.findMany({ where: { userId: { in: users } }, select: { id: true } })
    ).map((i) => i.id)
    await prisma.notification.deleteMany({
      where: { OR: [{ userId: { in: users } }, { entityType: "item", entityId: { in: postedIds } }] },
    })
    await prisma.item.deleteMany({ where: { userId: { in: users } } })
    await prisma.user.deleteMany({ where: { id: { in: users } } })
    await prisma.$disconnect()
  }

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
