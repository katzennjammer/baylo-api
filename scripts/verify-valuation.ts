// Acceptance harness for item valuation.
//
// Drives the real routes over HTTP, per the house convention, and checks the
// claims the manuscript is going to make about them:
//
//   - a valuation response carries valuationSource, set to one of exactly two
//     values, and the Item it produces stores that value
//   - DETERMINISM: identical inputs return byte-identical output, twice
//   - condition CHANGES the number: same category, two conditions, two values,
//     and the arithmetic of whichever path the data takes -- category band on
//     an empty database, condition-normalised comparables on a seeded one
//   - a user value BELOW the suggestion is accepted, however far below
//   - a value up to ONE BRACKET above the suggestion's bracket is accepted and
//     goes live; both numbers and `valueSetByUser` are stored
//   - a value further above that is accepted but PARKED: the listing is
//     created in PENDING_REVIEW, invisible to everyone but its owner, and an
//     admin decides
//   - one re-valuation per listing, then 409
//   - the old /api/ai/value path still answers, from the same model
//   - a per-path census of every Item in the database
//
// Run (from baylo/, with a dev server on BASE):
//   npx tsx --env-file=.env scripts/verify-valuation.ts
import prisma from "../src/lib/prisma"
import { valueCap } from "../src/lib/trade-rules"
import { signAccessToken } from "../src/lib/auth-tokens"
import {
  CONDITION_MULTIPLIERS,
  CATEGORY_BANDS,
  COMPARABLE_SELECT,
  MAX_COMPARABLES,
  comparablesWhere,
  OVERRIDE_BAND_PCT,
  MIN_COMPARABLES,
  MAX_REVALUATIONS,
  valueItem,
  overrideBounds,
} from "../src/lib/valuation"
import { requireScratchSchema } from "./lib/live-guard"

const BASE = process.env.ACCEPT_BASE ?? "http://127.0.0.1:3100"
const P = "zzval-"

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`) }
}

const show = (v: unknown) => JSON.stringify(v, null, 2)

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function cleanup() {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: P } }, select: { id: true },
  })
  const ids = users.map((u) => u.id)
  if (!ids.length) return
  await prisma.leafTransaction.deleteMany({ where: { userId: { in: ids } } })
  await prisma.taskCompletion.deleteMany({ where: { userId: { in: ids } } })
  await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: ids } }, { actorId: { in: ids } }] } })
  await prisma.item.deleteMany({ where: { userId: { in: ids } } })
  await prisma.user.deleteMany({ where: { id: { in: ids } } })
}

interface Api { status: number; body: Record<string, unknown> }

async function api(path: string, token: string, init?: RequestInit): Promise<Api> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

const post = (path: string, token: string, body: unknown) =>
  api(path, token, { method: "POST", body: JSON.stringify(body) })

/** A listing body with everything the create schema requires. */
const listing = (over: Record<string, unknown>) => ({
  title: `${P}item`,
  description: "harness fixture",
  category: "BOOKS",
  condition: "GOOD",
  images: [],
  ...over,
})

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  requireScratchSchema("scripts/verify-valuation.ts")
  console.log(`Driving ${BASE}\n`)
  await cleanup()

  const user = await prisma.user.create({
    data: {
      name: "ZZ Valuer",
      email: `${P}u-${Date.now()}@example.local`,
      isVerified: true,
      // Past the government-ID gate. This suite creates listings through the
      // real POST /api/items, which requires it; without the stamp every
      // creation here is a 403 and the valuation assertions all read undefined.
      // Stamped rather than given an APPROVED IdVerification row -- the ID flow
      // has its own harness in scripts/verify-id-verification.ts.
      idVerifiedGrandfatheredAt: new Date(),
    },
  })
  const token = await signAccessToken(user.id)

  // ── 0. The model's constants, stated once so the output is self-describing.
  console.log("0. model configuration")
  console.log(`     override band     ±${Math.round(OVERRIDE_BAND_PCT * 100)}%`)
  console.log(`     min comparables   ${MIN_COMPARABLES}`)
  console.log(`     max revaluations  ${MAX_REVALUATIONS}`)
  console.log(`     condition mult.   ${Object.entries(CONDITION_MULTIPLIERS).map(([k, v]) => `${k}=${v}`).join("  ")}`)

  // ── 1. Auth.
  console.log("\n1. auth")
  const anon = await fetch(`${BASE}/api/v1/valuation?category=BOOKS&condition=GOOD`)
  check("401 without a token", anon.status === 401, `${anon.status}`)

  // ── 2. A real valuation response.
  console.log("\n2. a real valuation response")
  const v1 = await api("/api/v1/valuation?category=ELECTRONICS&condition=GOOD", token)
  console.log(show(v1.body))
  const d1 = v1.body.data as Record<string, unknown> | null
  check("200", v1.status === 200, `${v1.status}`)
  check("valuationSource is set",
    d1?.valuationSource === "comparables" || d1?.valuationSource === "category_band",
    String(d1?.valuationSource))
  check("carries a suggestion, a range and an allowed band",
    typeof d1?.suggestedLeaves === "number" && !!d1?.allowed && typeof d1?.basis === "string")

  // ── 3. Determinism. The headline claim.
  console.log("\n3. determinism — same inputs twice")
  const runA = await api("/api/v1/valuation?category=BIKES&condition=FAIR", token)
  const runB = await api("/api/v1/valuation?category=BIKES&condition=FAIR", token)
  console.log("  run 1:", JSON.stringify(runA.body.data))
  console.log("  run 2:", JSON.stringify(runB.body.data))
  check("two runs are byte-identical",
    JSON.stringify(runA.body.data) === JSON.stringify(runB.body.data))

  // The pure model, hammered. The route is deterministic given the database;
  // the function is deterministic full stop, and that is the property the
  // manuscript's "objective and consistent" claim actually rests on.
  const comps = [
    { valueLeaves: 900, condition: "NEW" },
    { valueLeaves: 300, condition: "POOR" },
    { valueLeaves: 500, condition: "GOOD" },
    { valueLeaves: 410, condition: "FAIR" },
  ]
  const first = JSON.stringify(valueItem({ category: "GAMING", condition: "LIKE_NEW", comparables: comps }))
  let stable = true
  for (let i = 0; i < 500; i++) {
    if (JSON.stringify(valueItem({ category: "GAMING", condition: "LIKE_NEW", comparables: comps })) !== first) stable = false
  }
  check("valueItem() is identical over 500 calls", stable)
  console.log(`     ${first}`)

  // ── 4. Condition changes the value.
  //
  // THE ARITHMETIC IS RESTATED BY HAND, FOR WHICHEVER PATH THE DATABASE TAKES.
  //
  // This section used to assert the CATEGORY-BAND arithmetic unconditionally,
  // and valueItem() only takes that path when a category has fewer than
  // MIN_COMPARABLES settled, priced items. prisma/seed.ts deliberately plants
  // four settled ELECTRONICS rows so the COMPARABLES path is reachable at all,
  // so the two equality checks failed on every seeded database -- 47 of 49,
  // with a comment explaining that red meant the seed was present.
  //
  // A test that is expected to fail is not a test. It is also the one shape of
  // failure that hides a real regression, because the eye learns to skip it.
  //
  // So the harness reads `valuationSource` off the response and checks the
  // arithmetic that source implies:
  //
  //   category_band   midpoint of the band x the condition multiplier
  //   comparables     each settled row normalised by ITS OWN condition
  //                   multiplier, meaned, x this condition's multiplier
  //
  // Both are written out here in full rather than by calling valueItem(),
  // which would only prove the function equals itself. The comparables are
  // read with the same where/order/take the server uses -- see
  // fetchComparables() in @/lib/valuation-server -- because a different
  // ordering would silently value a different sample.
  console.log("\n4. condition affects value — same category, different condition")
  const mint    = await post("/api/items", token, listing({ title: `${P}mint`, category: "ELECTRONICS", condition: "NEW" }))
  const cracked = await post("/api/items", token, listing({ title: `${P}cracked`, category: "ELECTRONICS", condition: "POOR" }))
  const mintV    = mint.body.valueLeaves as number
  const crackedV = cracked.body.valueLeaves as number
  const source   = mint.body.valuationSource as string
  console.log(`  NEW  ELECTRONICS -> valueLeaves=${mintV} suggested=${mint.body.suggestedLeaves} source=${source}`)
  console.log(`  POOR ELECTRONICS -> valueLeaves=${crackedV} suggested=${cracked.body.suggestedLeaves} source=${cracked.body.valuationSource}`)
  check("both created", mint.status === 201 && cracked.status === 201, `${mint.status}/${cracked.status}`)
  check("the two values differ", mintV !== crackedV, `${mintV} vs ${crackedV}`)
  check("NEW is worth more than POOR", mintV > crackedV, `${mintV} <= ${crackedV}`)
  check("both items took the SAME path", cracked.body.valuationSource === source,
    `${source} vs ${cracked.body.valuationSource}`)

  // valueItem()'s rounding, restated: half-up, floored at 1 Leaf.
  const round1 = (n: number) => Math.max(1, Math.floor(n + 0.5))

  let base: number
  if (source === "comparables") {
    const rows = await prisma.item.findMany({
      where: comparablesWhere("ELECTRONICS"),
      select: COMPARABLE_SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_COMPARABLES,
    })
    const normalised = rows
      .filter((r) => (r.valueLeaves ?? 0) > 0)
      .map((r) => (r.valueLeaves as number) / CONDITION_MULTIPLIERS[r.condition as keyof typeof CONDITION_MULTIPLIERS])
    base = normalised.reduce((a, b) => a + b, 0) / normalised.length
    console.log(`  comparables path: ${normalised.length} settled rows, condition-normalised mean ${base.toFixed(3)}`)
    check(`the sample is at or above MIN_COMPARABLES (${MIN_COMPARABLES})`,
      normalised.length >= MIN_COMPARABLES, `${normalised.length}`)
  } else {
    const [lo, hi] = CATEGORY_BANDS.ELECTRONICS
    base = (lo + hi) / 2
    console.log(`  category_band path: band ${lo}-${hi}, midpoint ${base}`)
  }

  check(`NEW  = base × ${CONDITION_MULTIPLIERS.NEW} (${source})`,
    mintV === round1(base * CONDITION_MULTIPLIERS.NEW),
    `${mintV} != ${round1(base * CONDITION_MULTIPLIERS.NEW)}`)
  check(`POOR = base × ${CONDITION_MULTIPLIERS.POOR} (${source})`,
    crackedV === round1(base * CONDITION_MULTIPLIERS.POOR),
    `${crackedV} != ${round1(base * CONDITION_MULTIPLIERS.POOR)}`)

  // ── 5. valuationSource is persisted, not just returned.
  console.log("\n5. valuationSource is stored on the Item")
  const mintRow = await prisma.item.findUnique({
    where: { id: mint.body.id as string },
    select: { valueLeaves: true, suggestedLeaves: true, valuationSource: true, revaluationCount: true },
  })
  console.log(" ", show(mintRow))
  check("row carries valuationSource", mintRow?.valuationSource === mint.body.valuationSource)
  check("row carries suggestedLeaves", mintRow?.suggestedLeaves === mint.body.suggestedLeaves)
  check("stored suggestion equals stored value when unoverridden",
    mintRow?.valueLeaves === mintRow?.suggestedLeaves)

  // ── 6. Setting your own value: the bracket cap, and review above it.
  //
  // The +/-25% band stopped being a RULE on 16 Sep 2026 -- it is the slider's
  // range now. What the server enforces is the bracket: lower is always fine,
  // up to one bracket above the suggestion's bracket goes live, and anything
  // further is stored as asked and parked in PENDING_REVIEW.
  console.log("\n6. setting your own value")
  const bandRef = await api("/api/v1/valuation?category=BOOKS&condition=GOOD", token)
  const suggested = (bandRef.body.data as { suggestedLeaves: number }).suggestedLeaves
  const cap = valueCap(suggested)
  const slider = overrideBounds(suggested)
  console.log(`  BOOKS/GOOD suggestion ${suggested} (bracket ${cap.suggestedBracket}), ` +
    `live up to bracket ${cap.maxBracketWithoutReview} (${cap.maxValueWithoutReview}), ` +
    `slider ${slider.min}-${slider.max}`)

  const inBand = Math.round((suggested + slider.max) / 2)
  const okRes = await post("/api/items", token, listing({ title: `${P}inband`, valueLeaves: inBand }))
  console.log(`  inside the slider band ${inBand} -> ${okRes.status}`)
  check("a value inside the slider band is accepted", okRes.status === 201, `${okRes.status}`)
  check("the value is what got stored", okRes.body.valueLeaves === inBand, `${okRes.body.valueLeaves}`)
  check("the suggestion is stored ALONGSIDE it, not overwritten",
    okRes.body.suggestedLeaves === suggested, `${okRes.body.suggestedLeaves} != ${suggested}`)
  // `valueSetByUser` is read from the ROW, not the response: it is a fact for
  // the admin Listings page and the census query, and the public item payload
  // deliberately does not carry it.
  const inBandRow = await prisma.item.findUnique({
    where: { id: okRes.body.id as string },
    select: { valueSetByUser: true, status: true },
  })
  check("it is marked as the owner's own value", inBandRow?.valueSetByUser === true, show(inBandRow))
  check("and it went live", inBandRow?.status === "AVAILABLE", show(inBandRow))

  // As far below as it gets. Nobody games a bracket downwards.
  const lowRes = await post("/api/items", token, listing({ title: `${P}low`, valueLeaves: 1 }))
  check("a value far BELOW the suggestion is accepted", lowRes.status === 201, `${lowRes.status}`)
  const lowRow = await prisma.item.findUnique({
    where: { id: lowRes.body.id as string },
    select: { valueLeaves: true, valueSetByUser: true, status: true },
  })
  check("…stored as asked, live, and flagged as the owner's",
    lowRow?.valueLeaves === 1 && lowRow?.status === "AVAILABLE" && lowRow?.valueSetByUser === true,
    show(lowRow))

  // The top of the one-bracket-up allowance: live.
  const atCap = cap.maxValueWithoutReview ?? suggested * 10
  const capRes = await post("/api/items", token, listing({ title: `${P}atcap`, valueLeaves: atCap }))
  check(`the top of bracket ${cap.maxBracketWithoutReview} (${atCap}) is live`,
    capRes.status === 201 && capRes.body.status === "AVAILABLE" && capRes.body.valueLeaves === atCap,
    show(capRes.body))

  // One Leaf further: the next bracket up, which needs a human.
  const overRes = await post("/api/items", token, listing({ title: `${P}review`, valueLeaves: atCap + 1 }))
  console.log(`\n  ABOVE THE CAP (${atCap + 1}) -> HTTP ${overRes.status}`)
  console.log(show(overRes.body.valueReview))
  check("a value above the cap is ACCEPTED, not refused", overRes.status === 201, `${overRes.status}`)
  check("…and parked in PENDING_REVIEW", overRes.body.status === "PENDING_REVIEW", `${overRes.body.status}`)
  check("…at the value the owner asked for", overRes.body.valueLeaves === atCap + 1, `${overRes.body.valueLeaves}`)
  check("…with the suggestion kept beside it", overRes.body.suggestedLeaves === suggested)
  const review = overRes.body.valueReview as { decision?: string; pending?: boolean; notice?: string } | undefined
  check("…and the response says so before the owner has to ask",
    review?.decision === "needsReview" && review?.pending === true && typeof review?.notice === "string",
    show(review))

  // It is invisible to everyone else, which is the whole point of parking it.
  const stranger = await prisma.user.findFirst({ where: { id: { not: user.id }, deletedAt: null }, select: { id: true } })
  if (stranger) {
    const strangerToken = await signAccessToken(stranger.id)
    const peek = await api(`/api/v1/items/${overRes.body.id}`, strangerToken)
    check("a listing in review is 404 to anybody but its owner", peek.status === 404, `${peek.status}`)
  }
  const browse = await api("/api/v1/browse?limit=50", token)
  const inBrowse = JSON.stringify(browse.body).includes(`${P}review`)
  check("…and does not appear in browse", !inBrowse)

  // ── 7. Edits are bounded too, and re-price on a condition change.
  console.log("\n7. edit path")
  const editId = okRes.body.id as string
  const bigEdit = await api(`/api/items/${editId}`, token, {
    method: "PATCH", body: JSON.stringify({ valueLeaves: (cap.maxValueWithoutReview ?? suggested) * 4 }),
  })
  check("PATCH far above the cap is accepted and sent to review",
    bigEdit.status === 200 && bigEdit.body.status === "PENDING_REVIEW", `${bigEdit.status} ${bigEdit.body.status}`)
  // ...and bringing it back inside the cap republishes it without an admin.
  const backEdit = await api(`/api/items/${editId}`, token, {
    method: "PATCH", body: JSON.stringify({ valueLeaves: inBand }),
  })
  check("PATCH back inside the cap goes live again",
    backEdit.status === 200 && backEdit.body.status === "AVAILABLE", `${backEdit.status} ${backEdit.body.status}`)

  // A value edit is refused outright while an offer on the listing is pending:
  // the bracket is what that offer was judged on.
  const other = await prisma.user.findFirst({ where: { id: { not: user.id }, deletedAt: null }, select: { id: true } })
  if (other) {
    const theirItem = await prisma.item.findFirst({
      where: { userId: other.id, status: "AVAILABLE", valueLeaves: { not: null } },
      select: { id: true, valueLeaves: true },
    })
    const mine = await prisma.item.findUnique({ where: { id: editId }, select: { valueLeaves: true } })
    if (theirItem && mine?.valueLeaves != null && theirItem.valueLeaves != null) {
      const pending = await prisma.offer.create({
        data: {
          postId: editId, senderId: other.id, receiverId: user.id, status: "PENDING",
          offeredItems: JSON.stringify([{ id: theirItem.id }]),
        },
        select: { id: true },
      })
      const locked = await api(`/api/items/${editId}`, token, {
        method: "PATCH", body: JSON.stringify({ valueLeaves: inBand + 1 }),
      })
      check("a value edit is refused while an offer is pending",
        locked.status === 409 && locked.body.code === "VALUE_LOCKED_BY_OFFER", `${locked.status} ${show(locked.body.code)}`)
      await prisma.offer.delete({ where: { id: pending.id } })
    }
  }

  const condEdit = await api(`/api/items/${editId}`, token, {
    method: "PATCH", body: JSON.stringify({ condition: "POOR", valueLeaves: null }),
  })
  console.log(`  BOOKS GOOD->POOR: value ${okRes.body.valueLeaves} -> ${condEdit.body.valueLeaves}, source ${condEdit.body.valuationSource}`)
  check("a condition edit re-prices the listing", condEdit.status === 200 &&
    condEdit.body.valueLeaves !== okRes.body.valueLeaves, `${condEdit.status} ${condEdit.body.valueLeaves}`)

  const titleOnly = await api(`/api/items/${editId}`, token, {
    method: "PATCH", body: JSON.stringify({ title: `${P}renamed` }),
  })
  check("a title-only edit does NOT re-price",
    titleOnly.body.valueLeaves === condEdit.body.valueLeaves,
    `${titleOnly.body.valueLeaves} != ${condEdit.body.valueLeaves}`)

  // ── 8. One re-valuation per listing.
  console.log("\n8. re-valuation budget")
  const rv1 = await api(`/api/v1/valuation?category=BOOKS&condition=POOR&itemId=${editId}`, token)
  const rv2 = await api(`/api/v1/valuation?category=BOOKS&condition=POOR&itemId=${editId}`, token)
  console.log(`  first re-valuation  -> ${rv1.status}`)
  console.log(`  second re-valuation -> ${rv2.status}  ${JSON.stringify(rv2.body.error)}`)
  check("the first re-valuation succeeds", rv1.status === 200, `${rv1.status}`)
  check("the second is refused with 409", rv2.status === 409, `${rv2.status}`)
  check("the counter reflects exactly one spend",
    (await prisma.item.findUnique({ where: { id: editId }, select: { revaluationCount: true } }))?.revaluationCount === 1)

  const foreign = await api(`/api/v1/valuation?category=BOOKS&condition=GOOD&itemId=${mint.body.id}x`, token)
  check("an unknown itemId is 404", foreign.status === 404, `${foreign.status}`)

  // ── 8b. The comparables path, over HTTP.
  //
  // No live category has reached MIN_COMPARABLES yet — the statistical branch
  // has been armed and never fired, which is precisely the gap this harness
  // exists to close. Three settled, priced PLANTS items are created so the
  // branch is exercised end to end through the real route rather than only
  // through the pure function, and they are torn down with the rest of the
  // fixtures. Their conditions differ on purpose: the path normalises each
  // comparable by its own multiplier before averaging, and three identical
  // conditions would not prove that happened.
  console.log("\n8b. the comparables path, end to end")
  const seeded = [
    { condition: "NEW" as const,      valueLeaves: 280 },
    { condition: "GOOD" as const,     valueLeaves: 200 },
    { condition: "POOR" as const,     valueLeaves: 90  },
  ]
  for (const [i, sIt] of seeded.entries()) {
    await prisma.item.create({
      data: {
        title: `${P}comp-${i}`, description: "settled comparable", images: "[]",
        category: "PLANTS", condition: sIt.condition, valueLeaves: sIt.valueLeaves,
        status: "OWNED", userId: user.id,
      },
    })
  }
  console.log(`  seeded ${seeded.length} settled PLANTS items: ` +
    seeded.map((x) => `${x.valueLeaves}@${x.condition}`).join(", "))

  const compA = await api("/api/v1/valuation?category=PLANTS&condition=GOOD", token)
  const compB = await api("/api/v1/valuation?category=PLANTS&condition=GOOD", token)
  console.log(show(compA.body.data))
  const cd = compA.body.data as { valuationSource: string; sampleSize: number; suggestedLeaves: number }
  check("the route now takes the comparables path", cd.valuationSource === "comparables", cd.valuationSource)
  check(`sampleSize is ${MIN_COMPARABLES}`, cd.sampleSize === MIN_COMPARABLES, String(cd.sampleSize))
  check("still deterministic on the comparables path",
    JSON.stringify(compA.body.data) === JSON.stringify(compB.body.data))

  // Condition normalisation: 280/1.40 = 200, 200/1.00 = 200, 90/0.45 = 200.
  // All three normalise to exactly 200, so a GOOD-condition suggestion must be
  // 200 — if the raw values were averaged instead it would be 190.
  check("comparables are normalised by their own condition before averaging",
    cd.suggestedLeaves === 200, `${cd.suggestedLeaves} (raw mean would be 190)`)

  const compPoor = await api("/api/v1/valuation?category=PLANTS&condition=POOR", token)
  const cp = (compPoor.body.data as { suggestedLeaves: number; valuationSource: string })
  console.log(`  PLANTS/GOOD -> ${cd.suggestedLeaves}   PLANTS/POOR -> ${cp.suggestedLeaves}`)
  check("condition still moves the number on the comparables path",
    cp.suggestedLeaves === 90 && cp.valuationSource === "comparables", `${cp.suggestedLeaves}`)

  // And an item created in that category records the comparables path.
  const compItem = await post("/api/items", token, listing({ title: `${P}from-comps`, category: "PLANTS", condition: "GOOD" }))
  console.log(`  new PLANTS listing -> value=${compItem.body.valueLeaves} source=${compItem.body.valuationSource}`)
  check("a listing valued this way stores valuationSource=comparables",
    compItem.body.valuationSource === "comparables", String(compItem.body.valuationSource))

  // ── 9. The deprecated path still answers, from the same model.
  console.log("\n9. legacy /api/ai/value")
  const legacy = await api("/api/ai/value?category=ELECTRONICS&condition=NEW", token)
  const modern = await api("/api/v1/valuation?category=ELECTRONICS&condition=NEW", token)
  const mdata = modern.body.data as { suggestedLeaves: number; valuationSource: string }
  console.log(" ", JSON.stringify(legacy.body))
  check("the old path still returns 200", legacy.status === 200, `${legacy.status}`)
  check("it agrees with v1 on the number", legacy.body.suggestedLeaves === mdata.suggestedLeaves,
    `${legacy.body.suggestedLeaves} != ${mdata.suggestedLeaves}`)
  check("it agrees with v1 on the path taken", legacy.body.valuationSource === mdata.valuationSource)
  check("it is marked deprecated", typeof legacy.body.deprecated === "string")

  // ── 10. The census.
  console.log("\n10. how every Item in the database was valued")
  const census = await prisma.item.groupBy({
    by: ["valuationSource"], _count: { _all: true },
  })
  const total = await prisma.item.count()
  for (const row of census.sort((a, b) => (b._count._all - a._count._all))) {
    const name = row.valuationSource ?? "(pre-model — predates the valuation system)"
    console.log(`  ${String(row._count._all).padStart(4)}  ${name}`)
  }
  console.log(`  ${String(total).padStart(4)}  TOTAL`)
  check("every item falls in exactly one bucket",
    census.reduce((s, r) => s + r._count._all, 0) === total)

  await cleanup()

  console.log("\n── census after harness teardown (real listings only) ──")
  for (const row of await prisma.item.groupBy({ by: ["valuationSource"], _count: { _all: true } })) {
    console.log(`  ${String(row._count._all).padStart(4)}  ${row.valuationSource ?? "(pre-model)"}`)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  await prisma.$disconnect()
  process.exit(fail ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  await cleanup().catch(() => {})
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
