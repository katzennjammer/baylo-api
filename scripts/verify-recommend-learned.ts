// Pure checks for the learned recommender (29 Nov 2026). No database.
//
//   npx tsx --tsconfig tsconfig.json scripts/verify-recommend-learned.ts
//
//   1  newer outranks older, all else equal (recency carries the most weight)
//   2  a known owner outranks an unknown one at the same age
//   3  reasons: KNOWN, CATEGORY, POPULAR, NEW are each named when they lead
//   4  every weight is zero or positive (each factor can only raise a listing)
//   5  same inputs, same order

import { LEARNED_WEIGHTS, scoreLearned, type LearnedSignals } from "../src/lib/recommend-learned"
import type { Candidate, Engagement } from "../src/lib/recommend"

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, d: unknown = "") => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) } else { fail++; console.log(`  FAIL  ${name}  ${JSON.stringify(d)}`) }
}
const now = new Date("2026-11-29T00:00:00Z")
const daysAgo = (n: number) => new Date(now.getTime() - n * 864e5)
const empty = (): LearnedSignals => ({ likes: new Map(), comments: new Map(), offers: new Map(), trades: new Map(), own: new Map(), totalEvents: 0, ownCount: 0, knownOwners: new Set() })
const c = (id: string, age: number, category = "BOOKS", ownerId = "o-" + id): Candidate => ({ id, category, createdAt: daysAgo(age), ownerId })
const noEng = new Map<string, Engagement>()

const r1 = scoreLearned([c("old", 10), c("new", 1)], empty(), noEng, now)
check("newer outranks older", r1[0].id === "new", r1.map((x) => x.id))

const s2 = empty(); s2.knownOwners.add("o-known"); s2.totalEvents = 3
const r2 = scoreLearned([c("stranger", 3), c("known", 3)], s2, noEng, now)
check("known owner outranks a stranger at the same age", r2[0].id === "known" && r2[0].reason.code === "KNOWN", r2)

const s3 = empty(); s3.comments.set("ART", 5); s3.totalEvents = 5
const r3 = scoreLearned([c("art", 20, "ART")], s3, noEng, now)
check("category interest names CATEGORY", r3[0].reason.code === "CATEGORY", r3[0].reason)
const eng = new Map<string, Engagement>([["hot", { offers: 3, likes: 2, comments: 1 }]])
const r4 = scoreLearned([c("hot", 20), c("cold", 20)], empty(), eng, now)
check("engagement names POPULAR and ranks first", r4[0].id === "hot" && r4[0].reason.code === "POPULAR", r4)
const r5 = scoreLearned([c("plain", 2)], empty(), noEng, now)
check("recency alone names NEW", r5[0].reason.code === "NEW", r5[0].reason)

check("every weight is zero or positive", Object.values(LEARNED_WEIGHTS).every((w) => w >= 0), LEARNED_WEIGHTS)
const a = scoreLearned([c("x", 3), c("y", 3), c("z", 5)], s2, eng, now).map((x) => x.id).join()
const b = scoreLearned([c("z", 5), c("y", 3), c("x", 3)], s2, eng, now).map((x) => x.id).join()
check("deterministic regardless of input order", a === b, [a, b])

console.log(`\n  ${pass} passed, ${fail} failed\n`)
if (fail) process.exitCode = 1
