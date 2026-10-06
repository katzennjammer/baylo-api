// Pure checks for the two readers of the Suspension and Subscription tables.
// No database: run with `npx tsx scripts/verify-suspension-subscription.ts`.
import assert from "node:assert/strict"
import { suspensionState, suspendedBody, suspensionEndedMessage } from "../src/lib/moderation"
import { isPremium, isVip, premiumUntil, vipUntil } from "../src/lib/premium"

const H = 3_600_000
const at = (ms: number) => new Date(Date.now() + ms)
const row = (endsAt: Date | null, liftedAt: Date | null = null) => ({ startsAt: at(-2 * H), endsAt, liftedAt })

assert.equal(suspensionState({ suspensions: [] }).suspended, false, "no rows")
assert.deepEqual(
  (({ suspended, indefinite }) => ({ suspended, indefinite }))(suspensionState({ suspensions: [row(null)] })),
  { suspended: true, indefinite: true }, "endsAt null is INDEFINITE, not over")
assert.equal(suspensionState({ suspensions: [row(at(H))] }).suspended, true, "still running")
assert.equal(suspensionState({ suspensions: [row(at(-H))] }).suspended, false, "lapsed")
assert.equal(suspensionState({ suspensions: [row(null, at(-H))] }).suspended, false, "lifted")
assert.equal(suspensionState({ suspensions: [row(at(-H)), row(null, at(-H)), row(at(H))] }).suspended, true, "history + one in force")

// What a suspended account is told at sign-in: the admin's reason, the dates, the level.
const told = suspendedBody(suspensionState({ suspensions: [{ ...row(at(H)), reason: "Spam listings", level: 2 }] }))
assert.equal(told.code, "ACCOUNT_SUSPENDED")
assert.equal(told.reason, "Spam listings", "the admin's reason reaches the user verbatim")
assert.equal(told.level, 2)
assert.equal(told.indefinite, false)
assert.ok(told.until && told.since)
const forever = suspendedBody(suspensionState({ suspensions: [{ ...row(null), reason: "Fraud", level: 1 }] }))
assert.deepEqual([forever.indefinite, forever.until], [true, null], "indefinite has no end date")

// The "your suspension is over" notice: which sentence, and that it restates the reason.
const D = 24 * H
const ran = suspensionEndedMessage({ reason: "Spam listings", startsAt: at(-8 * D), endsAt: at(-D), liftedAt: null })
assert.match(ran, /Your 7-day suspension ended on /, "ran its course: says how long it was")
assert.match(ran, /"Spam listings"/, "restates the admin's reason")
const early = suspensionEndedMessage({ reason: "Spam", startsAt: at(-3 * D), endsAt: at(4 * D), liftedAt: at(-D) })
assert.match(early, /Our team lifted the suspension .* ahead of its end date/, "lifted early")
const open = suspensionEndedMessage({ reason: "Fraud", startsAt: at(-3 * D), endsAt: null, liftedAt: at(-D) })
assert.match(open, /Our team lifted the suspension/)
assert.doesNotMatch(open, /ahead of its end date/, "an indefinite one had no end date to be ahead of")
assert.ok(suspensionEndedMessage({ reason: "x".repeat(900), startsAt: at(-2 * D), endsAt: at(-D), liftedAt: null }).length < 500, "a long reason is cut")
console.log("sample notice:", ran)

const subs = [
  { tier: "PREMIUM" as const, endsAt: at(-H) },
  { tier: "PREMIUM" as const, endsAt: at(H) },
  { tier: "VIP" as const, endsAt: at(-H) },
]
assert.equal(isPremium(premiumUntil(subs)), true, "the latest PREMIUM row decides")
assert.equal(isVip(vipUntil(subs)), false, "a lapsed VIP row is not VIP")
assert.equal(premiumUntil([]), null)
assert.equal(isPremium(premiumUntil(undefined)), false)

console.log("verify-suspension-subscription: all passed")
