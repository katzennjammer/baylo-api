// Acceptance harness for "Recommended for you" (@/lib/recommend, 30 Sep 2026).
//
// READ-ONLY, AGAINST LIVE DATA ON PURPOSE. The question is whether the scorer
// does the right thing on Baylo's real trades, offers and likes, which a
// scratch schema does not have. It writes nothing, which is the documented
// exemption in scripts/lib/live-guard.ts -- and it does not rely on that
// promise: every real-data read runs inside a transaction opened with
// SET TRANSACTION READ ONLY, so a write anywhere in the loaders would make
// Postgres refuse it and fail this script.
//
//   npx tsx --env-file=.env scripts/verify-recommend.ts
//
// What it pins down:
//   1  the pure scorer on synthetic input: signal-weight ordering, affinity
//      normalisation, log-scaled popularity, recency, cold-start weights,
//      score bounds, total order, determinism, honest reasons
//   2  the pipeline on real users -- the most-traded, one with offers or likes
//      but no completed trade, and one with no history at all: candidates
//      exclude own / perishable / unavailable, personalization is on exactly
//      when there are signals, the list is sorted and bounded, personal users'
//      shelves lean toward their categories, cold-start shelves lead with the
//      most-engaged item

import prisma from "../src/lib/prisma"
import {
  PERSONAL_CONFIDENCE_POINTS,
  PERSONAL_WEIGHTS,
  SCORE_WEIGHTS,
  affinityConfidence,
  categoryAffinity,
  rawPopularity,
  recencyOf,
  recommendFor,
  scoreCandidates,
  type Candidate,
  type Engagement,
  type Signal,
} from "../src/lib/recommend"

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = "") {
  if (ok) passed++
  else failed++
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`)
}
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9
const DAY = 24 * 60 * 60 * 1000

// ── 1 ── the pure scorer ─────────────────────────────────────────────────────
function pure() {
  console.log("\n1  Pure scorer (synthetic)")
  const now = new Date("2026-09-30T12:00:00Z")

  check(
    "weights order: trade > offer > like > own listing",
    PERSONAL_WEIGHTS.completedTrade > PERSONAL_WEIGHTS.offerSent &&
      PERSONAL_WEIGHTS.offerSent > PERSONAL_WEIGHTS.like &&
      PERSONAL_WEIGHTS.like > PERSONAL_WEIGHTS.ownListing,
  )
  check("score weights sum to 1", close(SCORE_WEIGHTS.personal + SCORE_WEIGHTS.popularity + SCORE_WEIGHTS.recency, 1))

  check("no signals -> empty affinity", categoryAffinity([]).size === 0)

  // Confidence: points / PERSONAL_CONFIDENCE_POINTS, capped at 1.
  const offer = (category: string): Signal => ({ kind: "offerSent", category })
  const trade = (category: string): Signal => ({ kind: "completedTrade", category })
  check("confidence threshold is 24 points", PERSONAL_CONFIDENCE_POINTS === 24)
  check("one offer earns an eighth", close(affinityConfidence([offer("ART")]), 3 / 24))
  check("two offers earn a quarter", close(affinityConfidence([offer("ART"), offer("ART")]), 0.25))
  check("three trades earn half", close(affinityConfidence([trade("A"), trade("B"), trade("C")]), 0.5))
  check("six trades earn it all", affinityConfidence(Array.from({ length: 6 }, () => trade("A"))) === 1)
  check(
    "a 40-signal history is capped at 1",
    affinityConfidence(Array.from({ length: 40 }, () => offer("ART"))) === 1,
  )
  check("two offers: strongest category is 0.25, not 1", close(categoryAffinity([offer("ART"), offer("ART")]).get("ART")!, 0.25))

  // Relative weights, on a thin history (7 points -> confidence 7/24).
  const thin = categoryAffinity([trade("BOOKS"), { kind: "like", category: "GAMING" }, { kind: "ownListing", category: "TOOLS" }])
  check("thin history: strongest category scaled to 7/24", close(thin.get("BOOKS")!, 7 / 24), thin.get("BOOKS")!.toFixed(3))
  check("like = half a trade", close(thin.get("GAMING")! / thin.get("BOOKS")!, 2 / 4))
  check("own listing = quarter of a trade", close(thin.get("TOOLS")! / thin.get("BOOKS")!, 1 / 4))
  const many: Signal[] = Array.from({ length: 4 }, () => ({ kind: "ownListing" as const, category: "TOOLS" }))
  const mixed = categoryAffinity([...many, trade("BOOKS")])
  check("four own listings equal one completed trade", close(mixed.get("TOOLS")!, mixed.get("BOOKS")!))

  // A full history (27 points): strongest category is exactly 1.
  const aff = categoryAffinity([
    ...Array.from({ length: 6 }, () => trade("BOOKS")),
    { kind: "like", category: "GAMING" },
    { kind: "ownListing", category: "TOOLS" },
  ])
  check("full history: strongest category is 1", aff.get("BOOKS") === 1)

  check("recency: now = 1", close(recencyOf(now, now), 1))
  check("recency: 7 days = 0.5", close(recencyOf(new Date(now.getTime() - 7 * DAY), now), 0.5))
  check("recency: 20 days = 0", recencyOf(new Date(now.getTime() - 20 * DAY), now) === 0)
  check("recency: future-dated clamps to 1", recencyOf(new Date(now.getTime() + DAY), now) === 1)
  check("raw popularity: an offer is worth 3", rawPopularity({ offers: 1, likes: 0, comments: 0 }) === 3)

  const old = new Date(now.getTime() - 30 * DAY)
  const cands: Candidate[] = [
    { id: "a", category: "BOOKS", createdAt: old },
    { id: "b", category: "GAMING", createdAt: old },
    { id: "c", category: "TOOLS", createdAt: now },
    { id: "d", category: "ART", createdAt: old },
    { id: "e", category: "MUSIC", createdAt: now },
  ]
  const eng = new Map<string, Engagement>([
    ["b", { offers: 5, likes: 2, comments: 1 }],
    ["d", { offers: 0, likes: 1, comments: 0 }],
  ])

  const personal = scoreCandidates(cands, aff, eng, now)
  const by = new Map(personal.map((s) => [s.id, s]))
  check("most-engaged candidate has popularity 1", by.get("b")!.popularity === 1)
  check("no engagement -> popularity 0", by.get("a")!.popularity === 0)
  check("popularity is log-scaled, not linear", by.get("d")!.popularity > 1 / 18, by.get("d")!.popularity.toFixed(3))
  check(
    "personalised score = 0.6p + 0.3pop + 0.1r",
    close(by.get("a")!.score, 0.6 * 1 + 0.3 * 0 + 0.1 * 0),
    by.get("a")!.score.toFixed(3),
  )
  check("top category item wins for a personalised viewer", personal[0].id === "a", personal.map((s) => s.id).join(","))
  check("reason CATEGORY when personal term leads", by.get("a")!.reason.code === "CATEGORY")
  check("reason POPULAR when only popularity contributes", by.get("d")!.reason.code === "POPULAR")
  check("reason NEW on recency alone", by.get("e")!.reason.code === "NEW")
  check("new item in a weak category still says CATEGORY", by.get("c")!.reason.code === "CATEGORY")
  check(
    "never CATEGORY for an item with zero affinity",
    personal.every((s) => s.reason.code !== "CATEGORY" || s.personal > 0),
  )

  // The over-skew the confidence scaling fixes: two offers in BOOKS.
  const twoOffers = scoreCandidates(cands, categoryAffinity([offer("BOOKS"), offer("BOOKS")]), eng, now)
  const tb = new Map(twoOffers.map((s) => [s.id, s]))
  check("two offers: personal term is 0.25, not 1", close(tb.get("a")!.personal, 0.25))
  check(
    // Unscaled: category match 0.600, most popular 0.300. At 12: level, 0.300 each.
    "two offers: most popular item outranks a cold category match",
    tb.get("b")!.score > tb.get("a")!.score && twoOffers[0].id === "b",
    `popular ${tb.get("b")!.score.toFixed(3)} vs category ${tb.get("a")!.score.toFixed(3)}`,
  )

  const cold = scoreCandidates(cands, new Map(), eng, now)
  const cb = new Map(cold.map((s) => [s.id, s]))
  check("cold start: personal term is 0 everywhere", cold.every((s) => s.personal === 0))
  check("cold start: score = 0.9pop + 0.1r", close(cb.get("b")!.score, 0.9), cb.get("b")!.score.toFixed(3))
  check("cold start: most-engaged item first", cold[0].id === "b")
  check("cold start: no CATEGORY reasons", cold.every((s) => s.reason.code !== "CATEGORY"))

  for (const [name, list] of [["personal", personal], ["cold", cold]] as const) {
    check(`${name}: scores in [0, 1]`, list.every((s) => s.score >= 0 && s.score <= 1 + 1e-9))
    check(`${name}: sorted best first`, list.every((s, i) => i === 0 || list[i - 1].score >= s.score))
  }
  const again = scoreCandidates(cands, aff, eng, now)
  check("deterministic: same inputs, same order", JSON.stringify(again) === JSON.stringify(personal))
}

// ── 2 ── the pipeline on real users, read-only ───────────────────────────────
async function real() {
  console.log("\n2  Real data (read-only transaction on live)")
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY")

      const trades = await tx.trade.findMany({
        where: { status: "COMPLETED" },
        select: { senderId: true, receiverId: true },
      })
      const tradeCount = new Map<string, number>()
      for (const t of trades)
        for (const id of [t.senderId, t.receiverId]) tradeCount.set(id, (tradeCount.get(id) ?? 0) + 1)
      const humans = await tx.user.findMany({
        where: { id: { in: [...tradeCount.keys()] }, isOrgAccount: false, deletedAt: null },
        select: { id: true },
      })
      const traded = humans.map((h) => h.id).sort((a, b) => tradeCount.get(b)! - tradeCount.get(a)!)

      const signalNoTrade = await tx.user.findFirst({
        where: {
          isOrgAccount: false,
          deletedAt: null,
          sentTrades: { none: { status: "COMPLETED" } },
          receivedTrades: { none: { status: "COMPLETED" } },
          // An offer sent: a deal with an offer phase (schema v2).
          OR: [{ sentTrades: { some: { offerStatus: { not: null } } } }, { likes: { some: {} } }],
        },
        select: { id: true },
      })
      const coldUser = await tx.user.findFirst({
        where: {
          isOrgAccount: false,
          deletedAt: null,
          // No completed trade either way, and no offer sent (schema v2: one
          // Trade row per deal, so both conditions are on sentTrades).
          sentTrades: { none: { OR: [{ status: "COMPLETED" }, { offerStatus: { not: null } }] } },
          receivedTrades: { none: { status: "COMPLETED" } },
          likes: { none: {} },
          items: { none: { status: "AVAILABLE" } },
        },
        select: { id: true },
      })

      const subjects: [string, string | undefined][] = [
        ["most-traded", traded[0]],
        ["second-most-traded", traded[1]],
        ["offers/likes, no trade", signalNoTrade?.id],
        ["no history", coldUser?.id],
      ]

      for (const [label, userId] of subjects) {
        if (!userId) {
          console.log(`\n  [${label}] no such user on live -- skipped`)
          continue
        }
        const run = await recommendFor(tx, userId)
        console.log(
          `\n  [${label}] ${userId}: ${run.signals.length} signals ` +
            `(${Object.keys(PERSONAL_WEIGHTS)
              .map((k) => `${k} ${run.signals.filter((s) => s.kind === k).length}`)
              .join(", ")}), ${run.candidates.length} candidates`,
        )
        const affText = [...run.affinity].sort((a, b) => b[1] - a[1]).map(([c, v]) => `${c} ${v.toFixed(2)}`)
        if (affText.length)
          console.log(`    confidence ${affinityConfidence(run.signals).toFixed(2)}; affinity: ${affText.join(", ")}`)

        const ids = run.candidates.map((c) => c.id)
        const rows = await tx.item.findMany({
          where: { id: { in: ids } },
          select: { id: true, userId: true, isPerishable: true, status: true, title: true, moderationHiddenAt: true },
        })
        const rowById = new Map(rows.map((r) => [r.id, r]))
        check("candidates: none are the viewer's own", rows.every((r) => r.userId !== userId))
        check("candidates: none perishable", rows.every((r) => !r.isPerishable))
        check("candidates: all AVAILABLE", rows.every((r) => r.status === "AVAILABLE"))
        check("candidates: none taken down by a moderator", rows.every((r) => r.moderationHiddenAt === null))
        check("personalized exactly when there are signals", run.personalized === run.signals.length > 0)

        const s = run.scored
        check("scored every candidate once", s.length === ids.length && new Set(s.map((x) => x.id)).size === ids.length)
        check("sorted best first", s.every((x, i) => i === 0 || s[i - 1].score >= x.score))
        check("scores in [0, 1]", s.every((x) => x.score >= 0 && x.score <= 1 + 1e-9))
        check("no CATEGORY reason without affinity", s.every((x) => x.reason.code !== "CATEGORY" || x.personal > 0))

        const top = s.slice(0, 10)
        if (run.personalized) {
          // Lift: how much more of the shelf is in the viewer's categories than
          // the pool it was drawn from. >1 means personalisation moved it.
          const catOf = new Map(run.candidates.map((c) => [c.id, c.category]))
          const inAff = (id: string) => (run.affinity.get(catOf.get(id)!) ?? 0) > 0
          const poolShare = ids.filter(inAff).length / Math.max(1, ids.length)
          const shelfShare = top.filter((x) => inAff(x.id)).length / Math.max(1, top.length)
          if (poolShare === 0) {
            console.log("    (none of this viewer's categories has a candidate -- shelf is popularity-led)")
          } else {
            check(
              "shelf leans to the viewer's categories (lift >= 1)",
              shelfShare >= poolShare,
              `shelf ${(shelfShare * 100).toFixed(0)}% vs pool ${(poolShare * 100).toFixed(0)}%, lift ${(shelfShare / poolShare).toFixed(1)}x`,
            )
          }
        } else {
          const maxPop = Math.max(0, ...s.map((x) => x.popularity))
          check("cold start: every personal term is 0", s.every((x) => x.personal === 0))
          if (maxPop > 0) check("cold start: top item is the most engaged", top[0].popularity === maxPop)
          else console.log("    (no engagement in the window -- cold shelf is recency-led)")
        }

        for (const x of top.slice(0, 5)) {
          const r = rowById.get(x.id)
          console.log(
            `    ${x.score.toFixed(3)}  p=${x.personal.toFixed(2)} pop=${x.popularity.toFixed(2)} r=${x.recency.toFixed(2)}  ` +
              `${x.reason.code.padEnd(8)} ${r?.title ?? x.id}`,
          )
        }
      }
    },
    { timeout: 120_000, maxWait: 20_000 },
  )
}

async function main() {
  pure()
  await real()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
