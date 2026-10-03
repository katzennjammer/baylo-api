import { createHash } from "node:crypto"

// An hourly, deterministic shuffle. Was part of @/lib/featured, which drove
// the paid Featured section; boosting was removed in schema v2 and these two
// pure functions are what survives, because the organisation spotlight
// (GET /api/v1/organizations/spotlight) rotates the same way.

const HOUR_MS = 60 * 60 * 1000

/** The UTC hour `now` falls in, as a whole number. The rotation's clock. */
export function rotationHour(now: Date = new Date()): number {
  return Math.floor(now.getTime() / HOUR_MS)
}

/**
 * Every row, shuffled into an order that is FIXED FOR THE HOUR and different
 * the next. Each id's place is sha256("<hour>:<seed>:<id>"), so the order is a
 * pure function of its inputs: the same on every request and every server
 * instance within the hour, reshuffled at the top of the next UTC hour, and
 * stable under churn (an id's key does not depend on the other ids).
 */
export function hourlyRotation<T extends { id: string }>(
  rows: readonly T[],
  seed: string,
  now: Date = new Date(),
): T[] {
  const hour = rotationHour(now)
  return rows
    .map((row) => ({
      row,
      key: createHash("sha256").update(`${hour}:${seed}:${row.id}`).digest("hex"),
    }))
    // Fixed-width hex compares correctly as a string; a collision falls back
    // to the id so the order is total.
    .sort((a, b) =>
      a.key === b.key ? (a.row.id < b.row.id ? -1 : 1) : a.key < b.key ? -1 : 1,
    )
    .map((x) => x.row)
}
