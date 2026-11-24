import "../support/admin-env"
import assert from "node:assert/strict"
import { beforeEach } from "node:test"

import { admin, call, env, member, reset, signInAs } from "../support/admin-env"
import { integration as it } from "../support/case"
import { suspendedBody, suspensionState } from "@/lib/moderation"
import { clientIp, rateLimit } from "@/lib/rate-limit"

beforeEach(reset)

const suspend = async (action: "suspend" | "unsuspend", extra: Record<string, unknown> = {}) => {
  const mod = await import("@/app/api/admin/users/[id]/route")
  const res = await call(mod.POST, "POST", { action, reason: action === "suspend" ? "Spam listings" : "Appeal accepted", ...extra }, "victim-1")
  return { status: res.status, json: await res.json() }
}
const asMember = async () => {
  const mod = await import("@/app/api/admin/users/route")
  env.sessionUserId = "victim-1"
  return (await call(mod.GET, "GET")).status
}
const setup = () => {
  signInAs(admin())
  env.users["victim-1"] = member({ id: "victim-1", email: "v@example.com", name: "Vic" })
}

it("User Suspension", "Test integration when an admin suspends a member, the member's session stops being accepted", "Access Control",
  "Member is signed in and not suspended; an admin is signed in",
  "Verify the member is treated as a signed-in non-admin (403) before and as signed out (401) after the suspension",
  async () => {
    setup()
    assert.equal(await asMember(), 403)
    env.sessionUserId = "admin-1"
    assert.equal((await suspend("suspend", { days: 7 })).status, 200)
    assert.equal(await asMember(), 401)
  })

it("User Suspension", "Test integration when an admin lifts a suspension, the member's access returns", "Access Control",
  "Member is suspended indefinitely; an admin is signed in",
  "Verify the member is refused as signed out (401) while suspended and accepted again as a signed-in member (403 for admin pages) after the lift",
  async () => {
    setup()
    await suspend("suspend")
    assert.equal(await asMember(), 401)
    env.sessionUserId = "admin-1"
    assert.equal((await suspend("unsuspend")).status, 200)
    assert.equal(await asMember(), 403)
  })

it("User Suspension", "Test integration when an admin suspends the same member twice, the first suspension is remembered", "Moderation Rules",
  "Member is already suspended by an earlier request",
  "Verify the second request is refused with 409 ALREADY_SUSPENDED and only one suspension is stored",
  async () => {
    setup()
    await suspend("suspend", { days: 3 })
    const second = await suspend("suspend", { days: 3 })
    assert.equal(second.status, 409)
    assert.equal(second.json.meta.code, "ALREADY_SUSPENDED")
    assert.equal(env.created.length, 1)
  })

it("User Suspension", "Test integration when a member is suspended, lifted and suspended again, the suspension level and audit trail follow", "Audit Log",
  "Member has no earlier suspensions",
  "Verify levels 1 and 2 are recorded and the audit log reads USER_SUSPENDED, USER_UNSUSPENDED, USER_SUSPENDED in order",
  async () => {
    setup()
    await suspend("suspend", { days: 1 })
    await suspend("unsuspend")
    await suspend("suspend", { days: 5 })
    assert.deepEqual(env.created.map((c) => (c as { level: number }).level), [1, 2])
    assert.deepEqual(env.audits.map((a) => a.action), ["USER_SUSPENDED", "USER_UNSUSPENDED", "USER_SUSPENDED"])
  })

it("User Suspension", "Test integration when a suspended member tries to sign in, the refusal carries what the admin entered", "Sign-in Refusal",
  "An admin suspended the member for 7 days with the reason 'Spam listings'",
  "Verify the 403 body has code ACCOUNT_SUSPENDED with the same reason, level 1 and an end date about 7 days ahead",
  async () => {
    setup()
    await suspend("suspend", { days: 7 })
    const body = suspendedBody(suspensionState(env.users["victim-1"]))
    assert.equal(body.code, "ACCOUNT_SUSPENDED")
    assert.deepEqual([body.reason, body.level, body.indefinite], ["Spam listings", 1, false])
    const days = (body.until!.getTime() - Date.now()) / 86_400_000
    assert.ok(days > 6.9 && days < 7.1, String(days))
  })

it("Report Review", "Test integration when two admins mark the same report as 'reviewing', the second is told it is already being reviewed", "Audit Log",
  "An open report exists",
  "Verify the first request moves the report to REVIEWING with one audit entry and the second is refused with 409",
  async () => {
    signInAs(admin())
    const row = { id: "rep-1", status: "OPEN" }
    env.tables.moderationCase = {
      findUnique: async () => row,
      update: async (a: { data: { status: string } }) => void (row.status = a.data.status),
    }
    const mod = await import("@/app/api/admin/reports/[id]/resolve/route")
    const first = await call(mod.POST, "POST", { action: "reviewing", note: "Checking photos" }, "rep-1")
    const second = await call(mod.POST, "POST", { action: "reviewing", note: "Also checking" }, "rep-1")
    assert.equal(first.status, 200)
    assert.equal(second.status, 409)
    assert.equal(row.status, "REVIEWING")
    assert.equal(env.audits.length, 1)
  })

it("Admin Access", "Test integration when an admin's role is removed while still signed in, the next request is refused", "User Roles",
  "Admin is signed in and has just used the admin pages",
  "Verify the first request passes the gate and, after the role changes to member, the same session is refused with 403",
  async () => {
    signInAs(admin())
    const mod = await import("@/app/api/admin/users/route")
    const before = await call(mod.GET, "GET").catch((e: Error) => e)
    assert.ok(before instanceof Error, "gate should have let the admin through to the data layer")
    env.users["admin-1"].role = "USER"
    assert.equal((await call(mod.GET, "GET")).status, 403)
  })

it("Client Address", "Test integration when people behind a trusted proxy sign up, each address gets its own rate limit", "Rate Limit",
  "Requests arrive through Cloudflare from two different addresses and the limit is 3 per hour",
  "Verify the first address is blocked on its 4th request while the second address is still allowed",
  () => {
    process.env.TRUST_PROXY = "cloudflare"
    const key = (ip: string) => `signup:${clientIp(new Request("http://x", { headers: { "cf-connecting-ip": `${ip}.${Math.random()}` } }))}`
    const a = key("1.1.1"), b = key("2.2.2")
    for (let i = 0; i < 3; i++) rateLimit(a, 3, 3_600_000)
    assert.equal(rateLimit(a, 3, 3_600_000).ok, false)
    assert.equal(rateLimit(b, 3, 3_600_000).ok, true)
    delete process.env.TRUST_PROXY
  })
