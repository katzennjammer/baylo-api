/**
 * The pure rules behind HubForm, in a module a test can import.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM HubForm.tsx. The two rules here are the
 * ones the hub admin surface has already got wrong once and is most likely to
 * get wrong again: "is this a real place" and "is this form ready to save".
 * They were live assertions inside a React component, which meant the only way
 * to check them was to render the component and drive it — so in practice
 * nobody checked them, and the tests that did exist had to reach through JSX to
 * ask a question that has nothing to do with JSX.
 *
 * HubForm.tsx imports these and the test imports these. There is one
 * implementation, so a test cannot pass against a copy that has drifted.
 *
 * NO REACT, NO DOM, NO "use client" — the whole point is that this is callable
 * from `tsx` with nothing set up. The component supplies the state; these
 * functions decide.
 */

/** The fields a hub's coordinates and text live in. Structural, so Hub satisfies it. */
export interface HubCoordinates {
  latitude: number
  longitude: number
}

/** The text fields the Save gate requires, plus coordinates. */
export interface HubRequiredFields extends HubCoordinates {
  name: string
  address: string
  city: string
}

/**
 * Whether these coordinates name a real place.
 *
 * (0, 0) is Null Island — the Gulf of Guinea — and no hub is ever there. It is
 * the value an unfilled number input submits, so in this codebase the pair
 * means "no coordinates chosen", not "a coordinate that happens to be zero".
 *
 * NaN fails here too, and deliberately: a cleared input and an untouched one
 * look identical to the person in front of the form, and both mean the same
 * thing about whether a place has been picked.
 *
 * MIRRORS isNullIsland() in @/lib/safe-zones, which the API routes enforce.
 * They are separate because this module is imported by a client component and
 * safe-zones.ts constructs Prisma types; if the sentinel ever changes, both
 * change together. The API test (verify-hub-null-island.ts) pins the server
 * half, and this one pins the client half.
 */
export function hasCoordinates(value: HubCoordinates): boolean {
  return (
    Number.isFinite(value.latitude) &&
    Number.isFinite(value.longitude) &&
    !(value.latitude === 0 && value.longitude === 0)
  )
}

/**
 * Whether Save may be pressed.
 *
 * Takes the four fields it actually reads; callers pass a whole Hub, and the
 * index signature is what lets them. Without it this parameter type would
 * reject `{ ...VALID, landmark: "" }` in a test for passing a field the rule
 * deliberately ignores — a test that cannot be written is a rule nobody
 * documents.
 *
 * Name, address and city are the three strings a hub cannot be understood
 * without — a hub with a name and no address is a pin on a map that nobody can
 * navigate to, and `city` is what the admin list groups and filters by, so a
 * blank one puts the row in a bucket with no label.
 *
 * `landmark` is NOT required here even though createSchema requires it on the
 * server. That is not an inconsistency to paper over: the landmark rule is the
 * server's, and it stays there. Duplicating it would mean two places to change
 * and a client that could drift out of step with a rule it does not own. The
 * button gates on what the FORM needs to be worth submitting; the API gates on
 * what may be stored.
 *
 * Trimmed, so a field containing a single space does not satisfy the gate — the
 * server trims before its own min(1) check and would reject the row anyway, and
 * a button that lights up for input the server will refuse is worse than one
 * that stays dark.
 */
export function canSaveHub(value: HubRequiredFields & Record<string, unknown>): boolean {
  return (
    value.name.trim().length > 0 &&
    value.address.trim().length > 0 &&
    value.city.trim().length > 0 &&
    hasCoordinates(value)
  )
}

/**
 * The message shown when Save is blocked by coordinates specifically, kept
 * beside the rule so the reason and the refusal cannot disagree.
 */
export const NO_COORDINATES_MESSAGE =
  "Set a latitude and longitude before saving — (0, 0) is not a real location."