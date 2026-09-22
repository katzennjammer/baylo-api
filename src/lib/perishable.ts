import type { PrismaClient } from "@/generated/prisma/client"
import type { ValuationOutcome } from "@/lib/valuation-server"

/**
 * Perishable listings: how they are valued, and how they stop being listings.
 *
 * ── THE PERISHABLE FLAG BUYS SPEED, NOT VALUE ───────────────────────────────
 *
 * The spec for this feature said perishables "skip the bracket value-review
 * queue", and taken literally that is a self-service route to any bracket: tick
 * Perishable, type 500,000, and land in bracket 10 — which sets the bridging
 * fee (10 × bracket), the premium acquisition gate and every reach calculation
 * in the app. The flag is set by the poster, so the poster would be setting
 * their own bracket.
 *
 * What a perishable actually needs is not to WAIT. A tray of fish that sits in
 * PENDING_REVIEW until a moderator wakes up is a listing whose entire window
 * expires inside the queue — the review is not too strict, it is too slow.
 *
 * So the queue is skipped and the CAP IS NOT. `decideItemValue()` runs exactly
 * as it does for every other listing, and where it would have said "wait", a
 * perishable is CLAMPED to `maxValueWithoutReview` — the same ceiling anybody
 * may raise to unreviewed — and published immediately. Nothing waits, and
 * nothing above the cap can be self-assigned.
 *
 * NOTHING IN @/lib/trade-rules, @/lib/brackets OR @/lib/bridge-fee CHANGES.
 * This reads `valueCap()` and writes a smaller number; the rules it is capped
 * against are the same rules, read from the same place.
 *
 * The owner is told, because a value that silently differs from the one they
 * typed is a bug from where they are sitting. See `clampNotice()`.
 */

/** What happened to a perishable's value, for the response and the wizard. */
export interface PerishableValueOutcome {
  /** Columns to merge into the Prisma `data`, already clamped. */
  data: ValuationOutcome["data"]
  /** True when the value was lowered to the cap. */
  clamped: boolean
  /** What the owner asked for, when clamped. Null otherwise. */
  requestedLeaves: number | null
  /** The sentence to show them, when clamped. */
  notice: string | null
}

/**
 * Apply the perishable rule to an already-computed valuation.
 *
 * Takes the OUTCOME rather than the inputs, so there is exactly one call to
 * `decideItemValue()` on the create path and this cannot re-derive a different
 * suggestion from the same two labels.
 *
 * A perishable that did not need review is returned untouched — the common
 * case, and it must cost nothing.
 */
export function decidePerishableValue(valued: ValuationOutcome): PerishableValueOutcome {
  if (!valued.needsReview) {
    return { data: valued.data, clamped: false, requestedLeaves: null, notice: null }
  }

  // `maxValueWithoutReview` is null only when the cap bracket is the open-ended
  // top one — and in that case `classifyValue()` can never return "needsReview",
  // because no value has a bracket above the highest. So this branch is
  // unreachable with `needsReview` true. Handled rather than asserted: an
  // unreachable branch that throws is still a 500 if the reasoning above ever
  // stops holding, and falling back to the suggestion is the safe direction.
  const ceiling = valued.cap.maxValueWithoutReview
  if (ceiling == null) {
    return {
      data: { ...valued.data, valueLeaves: valued.data.suggestedLeaves, valueSetByUser: false },
      clamped: true,
      requestedLeaves: valued.data.valueLeaves,
      notice: clampNotice(valued.data.valueLeaves, valued.data.suggestedLeaves),
    }
  }

  return {
    data: {
      ...valued.data,
      valueLeaves: ceiling,
      // STILL user-set. They did type their own number, and the admin Listings
      // page shows this flag beside both figures — recording it as `false`
      // would hide that a clamp happened from the one screen built to notice.
      valueSetByUser: true,
    },
    clamped: true,
    requestedLeaves: valued.data.valueLeaves,
    notice: clampNotice(valued.data.valueLeaves, ceiling),
  }
}

/**
 * The sentence the owner reads when their perishable was clamped.
 *
 * It says what was asked, what was given, and why — in that order, because the
 * first thing they want to know is whether their number survived. The "so it is
 * live now" clause is the compensation and belongs at the end: the trade they
 * were given is speed for ceiling, and the sentence should read as that trade.
 */
export function clampNotice(requested: number, granted: number): string {
  return (
    `Perishable listings go live straight away rather than waiting for a value review, ` +
    `so this one is capped at ${granted.toLocaleString("en-US")} Leaves ` +
    `instead of the ${requested.toLocaleString("en-US")} you asked for. ` +
    `Post it as a standard item if the higher value matters more than the speed.`
  )
}

// ── Expiry ───────────────────────────────────────────────────────────────────

/**
 * The windows the wizard offers. Not a closed set at the database — see the
 * note on `Item.tradeWithinHours` — but the only two anything writes today.
 */
export const TRADE_WITHIN_HOURS = [6, 24] as const
export type TradeWithinHours = (typeof TRADE_WITHIN_HOURS)[number]

type PerishableDb = Pick<PrismaClient, "item">

/**
 * Move every perishable past its window to EXPIRED. Returns how many moved.
 *
 * ── A LAZY SWEEP, BECAUSE NOTHING HERE RUNS ON A SCHEDULE ───────────────────
 *
 * This deployment has no cron, no queue and no worker — the note on
 * `OfferStatus.EXPIRED` says so in as many words, and `expireStaleOffers()` is
 * the shape the codebase settled on instead: the read paths that would be wrong
 * if the sweep had not run call it first. This is the same arrangement for the
 * same reason, and `scripts/expire-perishables.ts` is the same function behind a
 * command for when a real scheduler exists.
 *
 * ── MEASURED FROM createdAt, WHICH IS WHAT MAKES IT REPLAYABLE ──────────────
 *
 * The cutoff is computed per row from `createdAt + tradeWithinHours`, never
 * from "now minus a constant". A sweep that has not run for two days expires
 * exactly the listings that were already past their window — no more — and
 * running it twice changes nothing the first run did not, because the second
 * run finds nothing AVAILABLE. That is also why there is no `expiredAt` column
 * to keep in step.
 *
 * ── THE COMPARISON IS DONE IN SQL, NOT IN JS ────────────────────────────────
 *
 * `createdAt + (tradeWithinHours || ' hours')::interval < now()` is a row-wise
 * comparison between two columns, which Prisma's query builder cannot express.
 * Fetching every AVAILABLE perishable and filtering in JS would work and would
 * scale with the number of live perishables rather than with the number of
 * expired ones, on a path that runs on ordinary reads. So it is raw SQL, and
 * the UPDATE is conditional on `status = 'AVAILABLE'` so two concurrent sweeps
 * produce one expiry and one no-op — the same guard `expireStaleOffers()` uses.
 *
 * ── WHAT IT DOES NOT TOUCH ──────────────────────────────────────────────────
 *
 * An item in IN_TRADE is in somebody's trade and its window has stopped
 * mattering: expiring it out from under an accepted counterparty would cancel
 * an obligation by clock. Only AVAILABLE rows move.
 */
export async function expirePerishableItems(
  db: PerishableDb & { $executeRaw: PrismaClient["$executeRaw"] },
  scope: { userId?: string; itemId?: string } = {},
): Promise<number> {
  // Scoped variants are separate statements rather than one interpolated
  // string: `$executeRaw` is a tagged template and its safety comes from the
  // parameters being parameters. Building the WHERE by concatenation is how
  // that guarantee gets lost.
  if (scope.itemId) {
    return db.$executeRaw`
      UPDATE "Item"
         SET "status" = 'EXPIRED', "updatedAt" = now()
       WHERE "id" = ${scope.itemId}
         AND "isPerishable" = true
         AND "status" = 'AVAILABLE'
         AND "tradeWithinHours" IS NOT NULL
         AND "createdAt" + make_interval(hours => "tradeWithinHours") < now()`
  }

  if (scope.userId) {
    return db.$executeRaw`
      UPDATE "Item"
         SET "status" = 'EXPIRED', "updatedAt" = now()
       WHERE "userId" = ${scope.userId}
         AND "isPerishable" = true
         AND "status" = 'AVAILABLE'
         AND "tradeWithinHours" IS NOT NULL
         AND "createdAt" + make_interval(hours => "tradeWithinHours") < now()`
  }

  return db.$executeRaw`
    UPDATE "Item"
       SET "status" = 'EXPIRED', "updatedAt" = now()
     WHERE "isPerishable" = true
       AND "status" = 'AVAILABLE'
       AND "tradeWithinHours" IS NOT NULL
       AND "createdAt" + make_interval(hours => "tradeWithinHours") < now()`
}

/**
 * When a perishable's window closes. Null for anything without both halves.
 *
 * Pure, so the wizard, the tile countdown and the sweep agree on the instant.
 */
export function expiresAt(item: {
  isPerishable: boolean
  tradeWithinHours: number | null
  createdAt: Date
}): Date | null {
  if (!item.isPerishable || item.tradeWithinHours == null) return null
  return new Date(item.createdAt.getTime() + item.tradeWithinHours * 60 * 60 * 1000)
}

/** Hours left, floored at 0. Null when the item has no window. */
export function hoursRemaining(
  item: { isPerishable: boolean; tradeWithinHours: number | null; createdAt: Date },
  now: Date = new Date(),
): number | null {
  const at = expiresAt(item)
  if (!at) return null
  return Math.max(0, (at.getTime() - now.getTime()) / (60 * 60 * 1000))
}
