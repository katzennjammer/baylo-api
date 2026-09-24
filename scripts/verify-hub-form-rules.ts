// The client half of the hub form rules: the (0, 0) refusal and the Save gate.
//
//   npx tsx --tsconfig tsconfig.json scripts/verify-hub-form-rules.ts
//
// NO DATABASE, NO SERVER, NO BROWSER. These are the pure functions HubForm.tsx
// renders from (see src/app/admin/hubs/hub-form-rules.ts), so this runs
// anywhere `tsx` does and takes no time.
//
// WHY THESE TWO AND NOT MORE. Every other rule in this form lives on the server
// and is enforced there; a client check that agreed with a server check the
// client does not run is theatre. These two are different: they are the ones
// that decide what the person in front of the form can DO, and they are the two
// that were wrong — Save was enabled with no name, address, city or
// coordinates, and (0, 0) reached the API and would have been stored. Both are
// silent failures: nothing errors, a hub just exists at the wrong place or half
// written, and nobody finds out until two people are standing in different car
// parks. That is exactly the class of bug that regresses without a test.
//
// The server half of (0, 0) is pinned by verify-hub-null-island.ts.

import { canSaveHub, hasCoordinates, NO_COORDINATES_MESSAGE }
  from "../src/app/admin/hubs/hub-form-rules"

let pass = 0
let fail = 0

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}   ${detail}`)
  }
}
function head(s: string) {
  console.log(`\n── ${s} ${"─".repeat(Math.max(0, 66 - s.length))}`)
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
//
// A complete, valid hub, and then each case is that fixture with exactly ONE
// thing wrong. Built that way on purpose: when a case fails it is unambiguous
// which field caused it, and adding a field to the rule means adding it here
// once rather than to every literal.

const VALID = {
  id: "FIXTURE_HUB",
  name: "SM City Cebu",
  type: "MALL" as const,
  address: "North Reclamation Area, Cebu City",
  city: "Cebu City",
  landmark: "Main entrance, near the north information desk",
  // Cebu. Real coordinates, nothing near the sentinel.
  latitude: 10.3116,
  longitude: 123.9172,
  isActive: true,
}

async function main() {
  // ── 1 ── (0, 0) is not a place
  head("1  hasCoordinates() rejects (0, 0) — Null Island")

  check("(0, 0) is refused", !hasCoordinates({ latitude: 0, longitude: 0 }))
  check(
    "(0, 0) is refused even though both numbers are in range",
    !hasCoordinates({ latitude: 0, longitude: 0 }) &&
    Number.isFinite(0) && Math.abs(0) <= 90,
  )

  // The near-misses. The rule is EXACT, and it has to be: a coordinate pair a
  // ten-thousandth of a degree off the sentinel is a real place in the Gulf of
  // Guinea, and a hub there is somebody's decision rather than a blank field.
  head("1b the rule is exact — near-misses are allowed through")
  check("latitude 0 / longitude 0.0001 is allowed", hasCoordinates({ latitude: 0, longitude: 0.0001 }))
  check("latitude 0.0001 / longitude 0 is allowed", hasCoordinates({ latitude: 0.0001, longitude: 0 }))
  check("a real Cebu hub is allowed", hasCoordinates({ latitude: 10.3116, longitude: 123.9172 }))
  check("negative coordinates are allowed", hasCoordinates({ latitude: -33.8688, longitude: 151.2093 }))

  // NaN is the same state as (0, 0) from the form's point of view — a cleared
  // input — and must not reach the API as `NaN`, which serialises to null and
  // would fail the server's z.number() with a message about the wrong thing.
  head("1c NaN and Infinity do not count as coordinates")
  check("NaN latitude is refused", !hasCoordinates({ latitude: NaN, longitude: 123.9 }))
  check("NaN longitude is refused", !hasCoordinates({ latitude: 10.3, longitude: NaN }))
  check("both NaN is refused", !hasCoordinates({ latitude: NaN, longitude: NaN }))
  check("Infinity is refused", !hasCoordinates({ latitude: Infinity, longitude: 123.9 }))

  // ── 2 ── the Save gate
  head("2  canSaveHub() gates Save on name, address, city and coordinates")

  check("a complete fixture hub may be saved", canSaveHub(VALID), JSON.stringify(VALID))
  check("that fixture's coordinates are not the sentinel", hasCoordinates(VALID))

  // One field wrong at a time. Each of these was saveable before the gate.
  head("2b each required field, blank in turn, blocks Save")
  check("blank name blocks Save", !canSaveHub({ ...VALID, name: "" }), "name")
  check("blank address blocks Save", !canSaveHub({ ...VALID, address: "" }), "address")
  check("blank city blocks Save", !canSaveHub({ ...VALID, city: "" }), "city")
  check(
    "missing coordinates block Save",
    !canSaveHub({ ...VALID, latitude: 0, longitude: 0 }),
    "lat/lng",
  )

  // Whitespace is not a value. The server trims before its own min(1), so
  // " " would be refused there and a Save button that lit up for it would
  // promise something the API does not honour.
  head("2c whitespace alone does not satisfy the gate")
  check("name of one space blocks Save", !canSaveHub({ ...VALID, name: " " }))
  check("address of tabs blocks Save", !canSaveHub({ ...VALID, address: "\t\t" }))
  check("city of spaces blocks Save", !canSaveHub({ ...VALID, city: "   " }))
  check("a name with padding around real text is fine", canSaveHub({ ...VALID, name: "  SM City  " }))

  // The fields the gate deliberately does NOT require, asserted so the omission
  // is a decision on the record rather than something a later reader assumes
  // was forgotten.
  head("2d landmark is not part of the client gate (the server still requires it)")
  check("a blank landmark does not block Save", canSaveHub({ ...VALID, landmark: "" }))

  // ── 3 ── a deactivated hub
  head("3  isActive does not affect the gate")
  check("an inactive hub still passes the field gate", canSaveHub({ ...VALID, isActive: false }))

  // ── 4 ── the two must agree
  head("4  the coordinate rule and the save gate agree")
  // A (0, 0) hub that is otherwise perfect must still be refused — the case
  // where somebody fills in every text field, never touches the map, and
  // presses Save.
  const perfectExceptCoordinates = { ...VALID, latitude: 0, longitude: 0 }
  check("every field but coordinates still blocks Save", !canSaveHub(perfectExceptCoordinates))
  check("…and it is hasCoordinates() that refuses it", !hasCoordinates(perfectExceptCoordinates))
  check(
    "…and the message names the problem",
    NO_COORDINATES_MESSAGE.includes("(0, 0)"),
    NO_COORDINATES_MESSAGE,
  )

  console.log(`\n${"═".repeat(72)}`)
  console.log(`  ${pass} passed, ${fail} failed`)
  console.log(`${"═".repeat(72)}\n`)

  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})