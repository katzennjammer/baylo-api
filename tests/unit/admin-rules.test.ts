import "../support/admin-env"
import assert from "node:assert/strict"

import { MIN_AGE, ageOn, isAdult, parseDateOfBirth } from "@/lib/age"
import { appealKindFor, APPEAL_MESSAGE_MAX } from "@/lib/appeals"
import { asReport } from "@/lib/report-case"
import { hashIdNumber, normaliseIdNumber } from "@/lib/id-verification"
import { bracketNeedsVip, bracketOf, valueNeedsPremium, valueNeedsVip } from "@/lib/brackets"
import {
  CATEGORY_LABEL, suspendedBody, suspensionEndedMessage, suspensionState, toDbCategory, toDbTarget, toWireCategory, toWireTarget,
} from "@/lib/moderation"
import { DEFAULT_WINDOW_DAYS, formatReportDate, normaliseWindowDays } from "@/lib/admin-reports"
import { clientIp, rateLimit } from "@/lib/rate-limit"
import { hashResetToken } from "@/lib/reset-token"
import { suite } from "../support/case"

const rules = suite("Admin: Moderation Rules")
const util = suite("Admin: Reporting and Utilities")
const DAY = 86_400_000

// ── Suspension state ────────────────────────────────────────────────────────
rules("Users", "Member has no suspensions", "Not suspended", () => {
  assert.equal(suspensionState({ suspensions: [] }).suspended, false)
})
rules("Users", "Member has a suspension that ends tomorrow", "Suspended, not indefinite", () => {
  const s = suspensionState({ suspensions: [{ startsAt: new Date(), endsAt: new Date(Date.now() + DAY), liftedAt: null, reason: "Spam", level: 1 }] })
  assert.deepEqual([s.suspended, s.indefinite, s.reason, s.level], [true, false, "Spam", 1])
})
rules("Users", "Member has a suspension with no end date", "Suspended and indefinite", () => {
  const s = suspensionState({ suspensions: [{ startsAt: new Date(), endsAt: null, liftedAt: null }] })
  assert.deepEqual([s.suspended, s.indefinite, s.until], [true, true, null])
})
rules("Users", "Member's suspension ended yesterday", "No longer suspended", () => {
  const s = suspensionState({ suspensions: [{ startsAt: new Date(Date.now() - 5 * DAY), endsAt: new Date(Date.now() - DAY), liftedAt: null }] })
  assert.equal(s.suspended, false)
})
rules("Users", "Admin lifted the suspension early", "No longer suspended", () => {
  const s = suspensionState({ suspensions: [{ startsAt: new Date(), endsAt: null, liftedAt: new Date() }] })
  assert.equal(s.suspended, false)
})
rules("Users", "Suspended member tries to sign in (indefinite)", "403 body has code ACCOUNT_SUSPENDED and mentions support", () => {
  const b = suspendedBody(suspensionState({ suspensions: [{ startsAt: new Date(), endsAt: null, liftedAt: null, reason: "Fraud", level: 2 }] }))
  assert.equal(b.code, "ACCOUNT_SUSPENDED")
  assert.equal(b.indefinite, true)
  assert.match(b.error, /Contact support/)
  assert.deepEqual([b.reason, b.level], ["Fraud", 2])
})
rules("Users", "Suspended member tries to sign in (fixed term)", "Message states the end date", () => {
  const until = new Date(Date.now() + 3 * DAY)
  const b = suspendedBody(suspensionState({ suspensions: [{ startsAt: new Date(), endsAt: until, liftedAt: null }] }))
  assert.equal(b.indefinite, false)
  assert.match(b.error, /suspended until/)
})
rules("Users", "A 7-day suspension runs its course", "'Welcome back' message names '7-day' and the reason", () => {
  const startsAt = new Date("2026-06-01T00:00:00Z")
  const m = suspensionEndedMessage({ reason: "Spam", startsAt, endsAt: new Date(startsAt.getTime() + 7 * DAY), liftedAt: null })
  assert.match(m, /7-day suspension ended/)
  assert.match(m, /"Spam"/)
})
rules("Users", "Admin lifts a suspension before its end date", "Message says it was lifted 'ahead of its end date'", () => {
  const startsAt = new Date("2026-06-01T00:00:00Z")
  const m = suspensionEndedMessage({ reason: "Spam", startsAt, endsAt: new Date(startsAt.getTime() + 30 * DAY), liftedAt: new Date(startsAt.getTime() + DAY) })
  assert.match(m, /lifted the suspension/)
  assert.match(m, /ahead of its end date/)
})
rules("Users", "Suspension reason is 500 characters long", "Reason is shortened to 200 characters with an ellipsis", () => {
  const startsAt = new Date("2026-06-01T00:00:00Z")
  const m = suspensionEndedMessage({ reason: "x".repeat(500), startsAt, endsAt: new Date(startsAt.getTime() + DAY), liftedAt: null })
  assert.ok(m.includes("x".repeat(200) + "…"))
  assert.ok(!m.includes("x".repeat(201)))
})

// ── Report categories and targets ───────────────────────────────────────────
rules("Reports", "Member reports 'scam_or_fraud'", "Stored as SCAM_OR_FRAUD and read back as scam_or_fraud", () => {
  assert.equal(toDbCategory("scam_or_fraud"), "SCAM_OR_FRAUD")
  assert.equal(toWireCategory("SCAM_OR_FRAUD"), "scam_or_fraud")
})
rules("Reports", "Database holds a category this build does not know", "Shown as 'other' instead of crashing", () => {
  assert.equal(toWireCategory("BRAND_NEW_CATEGORY"), "other")
})
rules("Reports", "Every report category is displayed", "Each has a human label", () => {
  assert.equal(Object.keys(CATEGORY_LABEL).length, 6)
  assert.equal(CATEGORY_LABEL.prohibited_item, "Prohibited item")
})
rules("Reports", "Member reports a message", "Stored as MESSAGE and read back as message", () => {
  assert.equal(toDbTarget("message"), "MESSAGE")
  assert.equal(toWireTarget("MESSAGE"), "message")
})
rules("Reports", "Database holds a target type this build does not know", "Falls back to 'user'", () => {
  assert.equal(toWireTarget("PLANET"), "user")
})
rules("Reports", "Moderation-case row is shown as a report", "Fields are renamed (filedBy -> reporter, decisionNote -> resolutionNote)", () => {
  const r = asReport({ id: "1", filedById: "u1", decidedAt: "t", decisionNote: "n" }) as Record<string, unknown>
  assert.deepEqual(r, { id: "1", reporterId: "u1", resolvedAt: "t", resolutionNote: "n" })
})

// ── Appeals ─────────────────────────────────────────────────────────────────
rules("Appeals", "Listing was hidden by a moderator", "Appeal kind is MODERATION_HIDE", () => {
  assert.equal(appealKindFor({ status: "ACTIVE", moderationHiddenAt: new Date() }), "MODERATION_HIDE")
})
rules("Appeals", "Listing's value was rejected", "Appeal kind is VALUE_REJECTION", () => {
  assert.equal(appealKindFor({ status: "VALUE_REJECTED", moderationHiddenAt: null }), "VALUE_REJECTION")
})
rules("Appeals", "Listing is both hidden and value-rejected", "Hide takes priority", () => {
  assert.equal(appealKindFor({ status: "VALUE_REJECTED", moderationHiddenAt: new Date() }), "MODERATION_HIDE")
})
rules("Appeals", "Listing is in good standing", "Nothing to appeal (null)", () => {
  assert.equal(appealKindFor({ status: "ACTIVE", moderationHiddenAt: null }), null)
})
rules("Appeals", "Owner writes an appeal message", "Limit is 300 characters", () => {
  assert.equal(APPEAL_MESSAGE_MAX, 300)
})

// ── Value brackets (admin side) ─────────────────────────────────────────────
rules("Listings", "Item worth 9,000 Leaves", "Bracket 8, Premium needed, VIP not needed", () => {
  assert.equal(bracketOf(9000), 8)
  assert.equal(valueNeedsPremium(9000), true)
  assert.equal(valueNeedsVip(9000), false)
})
rules("Listings", "Item worth 9,001 Leaves", "Bracket 9, VIP needed", () => {
  assert.equal(bracketNeedsVip(bracketOf(9001)), true)
})

// ── Age rule ────────────────────────────────────────────────────────────────
const TODAY = new Date("2026-06-10T12:00:00Z")
util("Registration", "Date of birth is 10 June 2008 (turns 18 today)", "Accepted as an adult", () => {
  assert.equal(isAdult(parseDateOfBirth("2008-06-10", TODAY)!, TODAY), true)
})
util("Registration", "Date of birth is 11 June 2008 (turns 18 tomorrow)", "Counted as 17, not an adult", () => {
  const dob = parseDateOfBirth("2008-06-11", TODAY)!
  assert.equal(ageOn(dob, { year: 2026, month: 6, day: 10 }), MIN_AGE - 1)
  assert.equal(isAdult(dob, TODAY), false)
})
util("Registration", "Date of birth is not in YYYY-MM-DD form", "Rejected (null)", () => {
  assert.equal(parseDateOfBirth("10/06/2008", TODAY), null)
  assert.equal(parseDateOfBirth("", TODAY), null)
})
util("Registration", "Date of birth is 30 February", "Rejected (null)", () => {
  assert.equal(parseDateOfBirth("2000-02-30", TODAY), null)
})
util("Registration", "Date of birth is in the future", "Rejected (null)", () => {
  assert.equal(parseDateOfBirth("2030-01-01", TODAY), null)
})
util("Registration", "Date of birth is more than 120 years ago", "Rejected (null)", () => {
  assert.equal(parseDateOfBirth("1890-01-01", TODAY), null)
})

// ── ID numbers ──────────────────────────────────────────────────────────────
util("ID Verification", "Admin types an ID number with dashes, spaces and lowercase", "It is normalised to uppercase letters and digits only", () => {
  assert.equal(normaliseIdNumber("n01-23 456a"), "N0123456A")
})
util("ID Verification", "Same ID is typed two different ways", "Both produce the same hash (duplicate detection)", () => {
  assert.equal(hashIdNumber("N01-23456"), hashIdNumber("n0123456"))
})
util("ID Verification", "Two different ID numbers", "Different hashes, and the hash is not the raw number", () => {
  assert.notEqual(hashIdNumber("A1234567"), hashIdNumber("A1234568"))
  assert.match(hashIdNumber("A1234567"), /^[0-9a-f]{64}$/)
})
util("Security", "Password-reset token is stored", "Only its SHA-256 hash is kept, and the same token always hashes the same", () => {
  assert.equal(hashResetToken("abc"), hashResetToken("abc"))
  assert.notEqual(hashResetToken("abc"), "abc")
  assert.match(hashResetToken("abc"), /^[0-9a-f]{64}$/)
})

// ── Reports page ────────────────────────────────────────────────────────────
util("Reports", "Report page is opened with ?days=7", "Window is 7 days", () => {
  assert.equal(normaliseWindowDays("7"), 7)
})
util("Reports", "Report page is opened with ?days=365", "Window is 365 days", () => {
  assert.equal(normaliseWindowDays("365"), 365)
})
util("Reports", "Report page is opened with an unsupported window (?days=13)", "Falls back to the default of 30 days", () => {
  assert.equal(normaliseWindowDays("13"), DEFAULT_WINDOW_DAYS)
})
util("Reports", "Report page is opened with garbage or nothing", "Falls back to the default of 30 days", () => {
  assert.equal(normaliseWindowDays("abc"), 30)
  assert.equal(normaliseWindowDays(undefined), 30)
})
util("Reports", "?days is repeated in the URL", "The first value is used", () => {
  assert.equal(normaliseWindowDays(["90", "7"]), 90)
})
util("Reports", "A date at 20:00 UTC on 21 Sep is shown", "Shown in Philippine time (Asia/Manila), as the next day (Sep 22, 2026)", () => {
  assert.equal(formatReportDate(new Date("2026-09-21T20:00:00Z")), "Sep 22, 2026")
})

// ── Rate limiting ───────────────────────────────────────────────────────────
util("Security", "Client makes requests up to the limit of 3", "All three requests are allowed", () => {
  const key = `t-${Math.random()}`
  assert.deepEqual([1, 2, 3].map(() => rateLimit(key, 3, 60_000).ok), [true, true, true])
})
util("Security", "Client makes a 4th request inside the window", "Refused with a Retry-After of at most the window length", () => {
  const key = `t-${Math.random()}`
  for (let i = 0; i < 3; i++) rateLimit(key, 3, 60_000)
  const r = rateLimit(key, 3, 60_000)
  assert.equal(r.ok, false)
  assert.ok(r.retryAfter >= 1 && r.retryAfter <= 60)
})
util("Security", "Two different clients use the same endpoint", "Each has its own allowance", () => {
  const a = `t-${Math.random()}`, b = `t-${Math.random()}`
  for (let i = 0; i < 3; i++) rateLimit(a, 3, 60_000)
  assert.equal(rateLimit(a, 3, 60_000).ok, false)
  assert.equal(rateLimit(b, 3, 60_000).ok, true)
})
util("Security", "Client's window has expired", "Allowed again", async () => {
  const key = `t-${Math.random()}`
  rateLimit(key, 1, 20)
  assert.equal(rateLimit(key, 1, 20).ok, false)
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(rateLimit(key, 1, 20).ok, true)
})
util("Security", "Request carries a spoofed x-forwarded-for header and no proxy is trusted", "Header is ignored", () => {
  delete process.env.TRUST_PROXY
  const req = new Request("http://x", { headers: { "x-forwarded-for": "6.6.6.6" } })
  assert.equal(clientIp(req), "direct-client")
})
util("Security", "Request comes through Cloudflare", "cf-connecting-ip is used", () => {
  process.env.TRUST_PROXY = "cloudflare"
  const req = new Request("http://x", { headers: { "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "6.6.6.6" } })
  assert.equal(clientIp(req), "1.2.3.4")
  delete process.env.TRUST_PROXY
})
