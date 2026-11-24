import assert from "node:assert/strict"
import { beforeEach } from "node:test"

import { admin, call, env, member, reset, signInAs } from "../support/admin-env"
import { suite } from "../support/case"

const c = suite("Admin: Access Control")

// Every /api/admin route and the methods it exports.
const ROUTES: [string, string[]][] = [
  ["access", ["GET", "PATCH"]],
  ["achievements/[id]", ["PATCH"]],
  ["achievements", ["GET", "POST"]],
  ["anomalies", ["GET"]],
  ["appeals/[id]", ["POST"]],
  ["appeals", ["GET"]],
  ["audit", ["GET"]],
  ["hubs/[id]", ["PATCH"]],
  ["hubs/geocode", ["GET"]],
  ["hubs", ["GET", "POST"]],
  ["id-verification/[id]", ["POST"]],
  ["listings/[id]", ["POST"]],
  ["listings", ["GET"]],
  ["organizations/[id]", ["POST"]],
  ["reports/[id]/resolve", ["POST"]],
  ["reports/[id]", ["GET"]],
  ["reports", ["GET"]],
  ["trades/[id]/reverse-reward", ["POST"]],
  ["users/[id]", ["POST"]],
  ["users", ["GET"]],
]

beforeEach(reset)

for (const [route, methods] of ROUTES) {
  for (const method of methods) {
    const label = `${method} /api/admin/${route}`
    c("Sign-in Required", `Visitor who is not signed in calls ${label}`, "Refused with 401 UNAUTHENTICATED; the database is never touched", async () => {
      const mod = await import(`@/app/api/admin/${route}/route`)
      const res = await call(mod[method], method, {})
      assert.equal(res.status, 401)
      assert.equal((await res.json()).code, "UNAUTHENTICATED")
    })
    c("Staff Only", `Signed-in non-admin member calls ${label}`, "Refused with 403 FORBIDDEN; the database is never touched", async () => {
      signInAs(member())
      const mod = await import(`@/app/api/admin/${route}/route`)
      const res = await call(mod[method], method, {})
      assert.equal(res.status, 403)
      assert.equal((await res.json()).code, "FORBIDDEN")
    })
  }
}

c("Role Re-check", "Admin role was revoked after the session was issued", "Role is re-read from the database, so the request is refused (403)", async () => {
  // The session says user-1 exists; the database now says USER.
  signInAs(member({ id: "ex-admin" }))
  const mod = await import("@/app/api/admin/users/route")
  assert.equal((await call(mod.GET, "GET")).status, 403)
})
c("Role Re-check", "Admin account has been suspended", "Treated as signed out (401)", async () => {
  const until = new Date(Date.now() + 86_400_000)
  signInAs(admin({ suspensions: [{ startsAt: new Date(), endsAt: until, liftedAt: null }] }))
  const mod = await import("@/app/api/admin/users/route")
  assert.equal((await call(mod.GET, "GET")).status, 401)
})
c("Role Re-check", "Admin account has been deleted", "Treated as signed out (401)", async () => {
  signInAs(admin({ deletedAt: new Date() }))
  const mod = await import("@/app/api/admin/users/route")
  assert.equal((await call(mod.GET, "GET")).status, 401)
})
c("Role Re-check", "Admin's earlier suspension has already ended", "Access is allowed again (gate passes, route proceeds)", async () => {
  signInAs(admin({ suspensions: [{ startsAt: new Date(2020, 0, 1), endsAt: new Date(2020, 1, 1), liftedAt: null }] }))
  const mod = await import("@/app/api/admin/users/route")
  const res = await call(mod.GET, "GET").catch((e: Error) => e)
  // The gate passed: what follows is the route reaching for the (unfaked) database.
  assert.ok(res instanceof Error && /findMany|DB touched/.test(res.message), String(res))
})
void env
