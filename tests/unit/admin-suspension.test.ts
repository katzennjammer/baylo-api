import assert from "node:assert/strict"
import { beforeEach } from "node:test"

import { admin, call, env, member, reset, signInAs } from "../support/admin-env"
import { suite } from "../support/case"

const c = suite("Admin: User Suspension")
const DAY = 86_400_000

beforeEach(() => {
  reset()
  signInAs(admin())
  env.users["victim-1"] = member({ id: "victim-1", email: "v@example.com", name: "Vic" })
})

const post = async (body: unknown, id = "victim-1") => {
  const mod = await import("@/app/api/admin/users/[id]/route")
  const res = await call(mod.POST, "POST", body, id)
  return { status: res.status, json: await res.json() }
}

c("Users", "Admin suspends an account without giving a reason", "Refused (400): a reason is required for the audit log", async () => {
  assert.equal((await post({ action: "suspend" })).status, 400)
})
c("Users", "Admin gives a reason made only of spaces", "Refused (400)", async () => {
  assert.equal((await post({ action: "suspend", reason: "    " })).status, 400)
})
c("Users", "Admin gives a reason longer than 1000 characters", "Refused (400)", async () => {
  assert.equal((await post({ action: "suspend", reason: "x".repeat(1001) })).status, 400)
})
c("Users", "Admin sends an unknown action", "Refused (400)", async () => {
  assert.equal((await post({ action: "ban", reason: "spam" })).status, 400)
})
c("Users", "Admin sends an unknown extra field", "Refused (400): unknown field named in the message", async () => {
  const r = await post({ action: "suspend", reason: "spam", role: "ADMIN" })
  assert.equal(r.status, 400)
  assert.match(r.json.error.message, /role/)
})
c("Users", "Admin sends a body that is not valid JSON", "Refused (400)", async () => {
  assert.equal((await post("{not json")).status, 400)
})
c("Users", "Admin suspends for 0 days", "Refused (400)", async () => {
  assert.equal((await post({ action: "suspend", reason: "spam", days: 0 })).status, 400)
})
c("Users", "Admin suspends for 3651 days", "Refused (400): more than the 10-year limit", async () => {
  assert.equal((await post({ action: "suspend", reason: "spam", days: 3651 })).status, 400)
})
c("Users", "Admin suspends for 2.5 days", "Refused (400): days must be whole", async () => {
  assert.equal((await post({ action: "suspend", reason: "spam", days: 2.5 })).status, 400)
})
c("Users", "Admin lifts a suspension and also sends days", "Refused (400): days has no meaning when unsuspending", async () => {
  assert.equal((await post({ action: "unsuspend", reason: "appeal won", days: 3 })).status, 400)
})
c("Users", "Admin tries to suspend their own account", "Refused (403) SELF_SUSPEND", async () => {
  const r = await post({ action: "suspend", reason: "oops" }, "admin-1")
  assert.equal(r.status, 403)
  assert.equal(r.json.meta.code, "SELF_SUSPEND")
})
c("Users", "Admin suspends an account that does not exist", "Refused (404)", async () => {
  assert.equal((await post({ action: "suspend", reason: "spam" }, "nobody")).status, 404)
})
c("Users", "Admin suspends an account that was deleted", "Refused (409) ACCOUNT_DELETED", async () => {
  env.users["gone"] = member({ id: "gone", deletedAt: new Date() })
  const r = await post({ action: "suspend", reason: "spam" }, "gone")
  assert.equal(r.status, 409)
  assert.equal(r.json.meta.code, "ACCOUNT_DELETED")
})
c("Users", "Admin suspends another admin", "Refused (403) TARGET_IS_ADMIN", async () => {
  env.users["admin-2"] = admin({ id: "admin-2" })
  const r = await post({ action: "suspend", reason: "spam" }, "admin-2")
  assert.equal(r.status, 403)
  assert.equal(r.json.meta.code, "TARGET_IS_ADMIN")
})
c("Users", "Admin suspends an account that is already suspended", "Refused (409) ALREADY_SUSPENDED", async () => {
  env.users["victim-1"].suspensions = [{ startsAt: new Date(), endsAt: null, liftedAt: null }]
  const r = await post({ action: "suspend", reason: "spam" })
  assert.equal(r.status, 409)
  assert.equal(r.json.meta.code, "ALREADY_SUSPENDED")
})
c("Users", "Admin suspends a member for 7 days", "Suspension is saved with an end date 7 days ahead", async () => {
  const before = Date.now()
  const r = await post({ action: "suspend", reason: "Spam listings", days: 7 })
  assert.equal(r.status, 200)
  const data = env.created[0] as { userId: string; level: number; reason: string; endsAt: Date }
  assert.equal(data.userId, "victim-1")
  assert.equal(data.reason, "Spam listings")
  assert.ok(Math.abs(data.endsAt.getTime() - (before + 7 * DAY)) < 5_000)
  assert.equal(r.json.data.user.indefinite, false)
})
c("Users", "Admin suspends a member with no number of days", "Suspension is indefinite (no end date)", async () => {
  const r = await post({ action: "suspend", reason: "Fraud" })
  assert.equal(r.status, 200)
  assert.equal((env.created[0] as { endsAt: Date | null }).endsAt, null)
})
c("Users", "Member has been suspended twice before", "The new suspension is recorded as level 3", async () => {
  env.suspensionCount = 2
  await post({ action: "suspend", reason: "Repeat offence", days: 30 })
  assert.equal((env.created[0] as { level: number }).level, 3)
})
c("Users", "Admin suspends a member", "An audit-log entry USER_SUSPENDED is written with the reason", async () => {
  await post({ action: "suspend", reason: "Spam listings", days: 7 })
  assert.equal(env.audits.length, 1)
  assert.equal(env.audits[0].action, "USER_SUSPENDED")
  assert.equal(env.audits[0].targetId, "victim-1")
  assert.equal(env.audits[0].reason, "Spam listings")
})
c("Users", "Admin lifts a suspension on an account that is not suspended", "Refused (409) NOT_SUSPENDED", async () => {
  const r = await post({ action: "unsuspend", reason: "mistake" })
  assert.equal(r.status, 409)
  assert.equal(r.json.meta.code, "NOT_SUSPENDED")
})
c("Users", "Admin lifts the suspension of a suspended member", "Suspension is marked lifted and USER_UNSUSPENDED is audited", async () => {
  env.users["victim-1"].suspensions = [{ startsAt: new Date(), endsAt: null, liftedAt: null }]
  const r = await post({ action: "unsuspend", reason: "Appeal accepted" })
  assert.equal(r.status, 200)
  assert.equal(env.lifted, 1)
  assert.equal(env.audits[0].action, "USER_UNSUSPENDED")
})
