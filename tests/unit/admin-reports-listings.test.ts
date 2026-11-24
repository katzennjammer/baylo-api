import assert from "node:assert/strict"
import { beforeEach } from "node:test"

import { admin, call, env, reset, signInAs } from "../support/admin-env"
import { suite } from "../support/case"

const c = suite("Admin: Reports and Listings")

beforeEach(() => {
  reset()
  signInAs(admin())
})

const resolve = async (body: unknown) => {
  const mod = await import("@/app/api/admin/reports/[id]/resolve/route")
  const res = await call(mod.POST, "POST", body, "rep-1")
  return { status: res.status, json: await res.json() }
}
const listing = async (body: unknown) => {
  const mod = await import("@/app/api/admin/listings/[id]/route")
  const res = await call(mod.POST, "POST", body, "item-1")
  return { status: res.status, json: await res.json() }
}
const appeal = async (body: unknown) => {
  const mod = await import("@/app/api/admin/appeals/[id]/route")
  const res = await call(mod.POST, "POST", body, "ap-1")
  return { status: res.status, json: await res.json() }
}
const caseTable = (row: unknown) => {
  const updates: unknown[] = []
  env.tables.moderationCase = {
    findUnique: async () => row,
    update: async (a: unknown) => void updates.push(a),
  }
  return updates
}

// ── Resolving a user report ─────────────────────────────────────────────────
c("Resolve Report", "Admin resolves a report without a note", "Refused (400): note is required", async () => {
  assert.equal((await resolve({ action: "dismissed" })).status, 400)
})
c("Resolve Report", "Admin sends a note of only spaces", "Refused (400)", async () => {
  assert.equal((await resolve({ action: "dismissed", note: "   " })).status, 400)
})
c("Resolve Report", "Admin sends a note longer than 1000 characters", "Refused (400)", async () => {
  assert.equal((await resolve({ action: "actioned", note: "n".repeat(1001) })).status, 400)
})
c("Resolve Report", "Admin sends an unknown action", "Refused (400)", async () => {
  assert.equal((await resolve({ action: "delete", note: "x" })).status, 400)
})
c("Resolve Report", "Report does not exist", "Refused (404)", async () => {
  caseTable(null)
  assert.equal((await resolve({ action: "dismissed", note: "no case" })).status, 404)
})
c("Resolve Report", "Report was already actioned", "Refused (409) REPORT_ALREADY_RESOLVED", async () => {
  caseTable({ id: "rep-1", status: "ACTIONED" })
  const r = await resolve({ action: "dismissed", note: "again" })
  assert.equal(r.status, 409)
  assert.equal(r.json.meta.code, "REPORT_ALREADY_RESOLVED")
})
c("Resolve Report", "Report was already dismissed", "Refused (409) REPORT_ALREADY_RESOLVED", async () => {
  caseTable({ id: "rep-1", status: "DISMISSED" })
  assert.equal((await resolve({ action: "actioned", note: "again" })).status, 409)
})
c("Resolve Report", "Admin marks a report as 'reviewing' twice", "Second attempt refused (409) REPORT_ALREADY_REVIEWING", async () => {
  caseTable({ id: "rep-1", status: "REVIEWING" })
  const r = await resolve({ action: "reviewing", note: "looking" })
  assert.equal(r.status, 409)
  assert.equal(r.json.meta.code, "REPORT_ALREADY_REVIEWING")
})
c("Resolve Report", "Admin starts reviewing an open report", "Status becomes REVIEWING and REPORT_REVIEWING is audited", async () => {
  const updates = caseTable({ id: "rep-1", status: "OPEN" })
  const r = await resolve({ action: "reviewing", note: "Checking photos" })
  assert.equal(r.status, 200)
  assert.equal(r.json.data.report.status, "REVIEWING")
  assert.equal(updates.length, 1)
  assert.equal(env.audits[0].action, "REPORT_REVIEWING")
  assert.equal(env.audits[0].reason, "Checking photos")
})

// ── Hiding and value review of listings ─────────────────────────────────────
c("Listing Action", "Admin hides a listing without a reason", "Refused (400) on field 'reason'", async () => {
  const r = await listing({ action: "hide" })
  assert.equal(r.status, 400)
  assert.equal(r.json.meta.field, "reason")
})
c("Listing Action", "Admin unhides a listing without a reason", "Refused (400) on field 'reason'", async () => {
  assert.equal((await listing({ action: "unhide" })).status, 400)
})
c("Listing Action", "Admin approves a value without a reason", "Refused (400)", async () => {
  assert.equal((await listing({ action: "approve-value" })).status, 400)
})
c("Listing Action", "Admin rejects a value without choosing a reason code", "Refused (400) on field 'reasonCode'", async () => {
  const r = await listing({ action: "reject-value", note: "too high" })
  assert.equal(r.status, 400)
  assert.equal(r.json.meta.field, "reasonCode")
})
c("Listing Action", "Admin rejects a value with a reason code that is not on the list", "Refused (400)", async () => {
  assert.equal((await listing({ action: "reject-value", reasonCode: "BECAUSE_I_SAID_SO" })).status, 400)
})
c("Listing Action", "Admin sends an unknown action", "Refused (400)", async () => {
  assert.equal((await listing({ action: "delete", reason: "x" })).status, 400)
})
c("Listing Action", "Admin hides a listing that does not exist", "Refused (404)", async () => {
  env.tables.item = { findUnique: async () => null }
  assert.equal((await listing({ action: "hide", reason: "Spam" })).status, 404)
})
c("Listing Action", "Admin rejects a value with a valid code on a listing that does not exist", "Passes validation, then refused (404)", async () => {
  env.tables.item = { findUnique: async () => null }
  assert.equal((await listing({ action: "reject-value", reasonCode: "ABOVE_MARKET" })).status, 404)
})

// ── Appeals ─────────────────────────────────────────────────────────────────
c("Listing Appeal", "Admin decides an appeal with an unknown decision", "Refused (400)", async () => {
  assert.equal((await appeal({ decision: "maybe", reason: "x" })).status, 400)
})
c("Listing Appeal", "Admin decides an appeal without a reason", "Refused (400): reason is required for the audit log", async () => {
  assert.equal((await appeal({ decision: "uphold" })).status, 400)
})
c("Listing Appeal", "Admin decides an appeal that does not exist", "Refused (404)", async () => {
  caseTable(null)
  assert.equal((await appeal({ decision: "overturn", reason: "Evidence supplied" })).status, 404)
})
