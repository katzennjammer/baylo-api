import assert from "node:assert/strict"
import { beforeEach } from "node:test"

import { admin, call, env, reset, signInAs } from "../support/admin-env"
import { suite } from "../support/case"
import { NO_COORDINATES_MESSAGE, canSaveHub, hasCoordinates } from "@/app/admin/hubs/hub-form-rules"

const c = suite("Admin: ID Verification and Hubs")

beforeEach(() => {
  reset()
  signInAs(admin())
})

const idDecision = async (body: unknown) => {
  const mod = await import("@/app/api/admin/id-verification/[id]/route")
  const res = await call(mod.POST, "POST", body, "idv-1")
  return { status: res.status, json: await res.json() }
}
const orgDecision = async (body: unknown) => {
  const mod = await import("@/app/api/admin/organizations/[id]/route")
  const res = await call(mod.POST, "POST", body, "org-1")
  return { status: res.status, json: await res.json() }
}
const createHub = async (body: unknown) => {
  const mod = await import("@/app/api/admin/hubs/route")
  const res = await call(mod.POST, "POST", body)
  return { status: res.status, json: await res.json() }
}
const HUB = {
  name: "City Hall Lobby", type: "BARANGAY_HALL", address: "Osmena Blvd", latitude: 10.3157, longitude: 123.8854,
  city: "Cebu City", landmark: "Front desk", reason: "New partner site",
}

// ── ID verification ─────────────────────────────────────────────────────────
c("ID Verification", "Admin approves an ID without typing the ID number", "Refused (400)", async () => {
  assert.equal((await idDecision({ action: "approve" })).status, 400)
})
c("ID Verification", "Admin approves with an ID number of only spaces", "Refused (400)", async () => {
  assert.equal((await idDecision({ action: "approve", idNumber: "   " })).status, 400)
})
c("ID Verification", "Admin rejects an ID without choosing a reason", "Refused (400)", async () => {
  assert.equal((await idDecision({ action: "reject" })).status, 400)
})
c("ID Verification", "Admin rejects an ID with a reason that is not on the list", "Refused (400)", async () => {
  assert.equal((await idDecision({ action: "reject", reason: "i_dont_like_it" })).status, 400)
})
c("ID Verification", "Admin rejection also sends fields that belong to an approval", "Refused (400): strict body", async () => {
  assert.equal((await idDecision({ action: "reject", reason: "blurry_photo", idNumber: "A123456" })).status, 400)
})
c("ID Verification", "Admin sends an unknown action", "Refused (400)", async () => {
  assert.equal((await idDecision({ action: "maybe" })).status, 400)
})

// ── Shop (organization) verification ────────────────────────────────────────
c("Organizations", "Admin verifies a shop with a 1-letter reason", "Refused (400): reason must be at least 3 characters", async () => {
  assert.equal((await orgDecision({ decision: "verify", reason: "k" })).status, 400)
})
c("Organizations", "Admin rejects a shop without a rejection reason", "Refused (400)", async () => {
  assert.equal((await orgDecision({ decision: "reject", reason: "Documents unclear" })).status, 400)
})
c("Organizations", "Admin rejects a shop with an unknown rejection reason", "Refused (400)", async () => {
  assert.equal((await orgDecision({ decision: "reject", reason: "Documents unclear", rejectionReason: "VIBES" })).status, 400)
})
c("Organizations", "Admin sends a reason longer than 500 characters", "Refused (400)", async () => {
  assert.equal((await orgDecision({ decision: "verify", reason: "r".repeat(501) })).status, 400)
})
c("Organizations", "Admin decides on a shop that does not exist", "Refused (404)", async () => {
  env.tables.organization = { findUnique: async () => null, findFirst: async () => null }
  const r = await orgDecision({ decision: "verify", reason: "Looks genuine" }).catch((e: Error) => e)
  assert.ok(!(r instanceof Error) && r.status === 404, String(r instanceof Error ? r.message : r.status))
})

// ── Safe-zone hubs ──────────────────────────────────────────────────────────
c("Hubs", "Admin creates a hub without a landmark", "Refused (400)", async () => {
  const { landmark: _l, ...rest } = HUB
  assert.equal((await createHub(rest)).status, 400)
})
c("Hubs", "Admin creates a hub without a reason", "Refused (400): reason is written to the audit log", async () => {
  const { reason: _r, ...rest } = HUB
  assert.equal((await createHub(rest)).status, 400)
})
c("Hubs", "Admin enters latitude 91", "Refused (400)", async () => {
  assert.equal((await createHub({ ...HUB, latitude: 91 })).status, 400)
})
c("Hubs", "Admin enters longitude -181", "Refused (400)", async () => {
  assert.equal((await createHub({ ...HUB, longitude: -181 })).status, 400)
})
c("Hubs", "Admin enters an unknown hub type", "Refused (400)", async () => {
  assert.equal((await createHub({ ...HUB, type: "SECRET_BASE" })).status, 400)
})
c("Hubs", "Admin leaves coordinates at (0, 0)", "Refused (400) NULL_ISLAND: not a real location", async () => {
  const r = await createHub({ ...HUB, latitude: 0, longitude: 0 })
  assert.equal(r.status, 400)
  assert.equal(r.json.meta.rule, "NULL_ISLAND")
})

// ── Hub form (screen rules) ─────────────────────────────────────────────────
const form = { name: "Plaza", address: "Osmena Blvd", city: "Cebu City", latitude: 10.3157, longitude: 123.8854 }
c("Hubs", "Admin fills in every required field", "Save is allowed", () => {
  assert.equal(canSaveHub(form), true)
})
c("Hubs", "Admin leaves the name empty", "Save is blocked", () => {
  assert.equal(canSaveHub({ ...form, name: "  " }), false)
})
c("Hubs", "Admin leaves the address empty", "Save is blocked", () => {
  assert.equal(canSaveHub({ ...form, address: "" }), false)
})
c("Hubs", "Admin leaves the city empty", "Save is blocked", () => {
  assert.equal(canSaveHub({ ...form, city: "" }), false)
})
c("Hubs", "Coordinates are (0, 0)", "Not treated as a location; save is blocked", () => {
  assert.equal(hasCoordinates({ latitude: 0, longitude: 0 }), false)
  assert.equal(canSaveHub({ ...form, latitude: 0, longitude: 0 }), false)
})
c("Hubs", "Coordinates are NaN (box left blank)", "Not treated as a location", () => {
  assert.equal(hasCoordinates({ latitude: NaN, longitude: 125 }), false)
})
c("Hubs", "Latitude is 0 but longitude is real (on the equator)", "Accepted as a location", () => {
  assert.equal(hasCoordinates({ latitude: 0, longitude: 125 }), true)
})
c("Hubs", "Coordinates are missing", "Admin sees the '(0, 0) is not a real location' message", () => {
  assert.match(NO_COORDINATES_MESSAGE, /not a real location/)
})
