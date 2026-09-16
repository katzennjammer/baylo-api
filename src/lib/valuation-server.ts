import prisma from "@/lib/prisma"
import {
  valueItem,
  comparablesWhere,
  COMPARABLE_SELECT,
  MAX_COMPARABLES,
  type Valuation,
} from "@/lib/valuation"
import { bracketOf } from "@/lib/brackets"
import { classifyValue, valueCap, type ValueDecision } from "@/lib/trade-rules"

/**
 * The database half of the valuation model.
 *
 * @/lib/valuation is deliberately pure — constants and arithmetic, no imports
 * that touch I/O — so that the model can be exercised without a database and so
 * that "same inputs, same output" is a property of a function rather than a
 * property of a request. This file is the thin layer that fetches the one input
 * the model cannot compute for itself: the settled comparables for a category.
 *
 * Everything that needs a valuation goes through here — the /api/v1/valuation
 * endpoint, its deprecated /api/ai/value shim, and the item create and update
 * handlers that enforce the value cap. That matters more than it sounds: if
 * the endpoint that shows the user a suggestion and the handler that judges
 * their own value were to compute the suggestion differently, the server would
 * route to review values its own wizard said were fine.
 */

/** Comparables for a category, in a stable order. See the orderBy note. */
async function fetchComparables(category: string) {
  const rows = await prisma.item.findMany({
    where: comparablesWhere(category),
    select: COMPARABLE_SELECT,
    // A TOTAL order. `createdAt` alone is not one: two items created in the
    // same millisecond tie, and the tiebreak would be whatever the optimiser
    // returns first — which is the non-determinism this whole module claims not
    // to have. `id` is unique, so (createdAt, id) never ties.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_COMPARABLES,
  })
  return rows.map((r) => ({ valueLeaves: r.valueLeaves!, condition: r.condition }))
}

/** Value a (category, condition) pair against current trade history. */
export async function valuate(category: string, condition: string): Promise<Valuation> {
  return valueItem({ category, condition, comparables: await fetchComparables(category) })
}

// ── The write-path guard ─────────────────────────────────────────────────────

export interface ValuationDecision {
  /** Columns to merge into the Prisma create/update `data`. */
  data: {
    valueLeaves: number
    suggestedLeaves: number
    valuationSource: string
    valueSetByUser: boolean
  }
  /** The valuation that produced them, for the caller's response or logging. */
  valuation: Valuation
  /** Which of the four cases the request fell in. */
  decision: ValueDecision
  /**
   * TRUE when the listing must not go live until an admin approves it. The
   * caller writes `status: PENDING_REVIEW` (on create) or moves an AVAILABLE
   * listing there (on edit); this function only decides, it never writes.
   */
  needsReview: boolean
  /** The cap the request was judged against, for the caller's response. */
  cap: ReturnType<typeof valueCap>
}

export type ValuationOutcome = { ok: true } & ValuationDecision

/**
 * Decide what value a listing gets, and whether it can go live with it.
 *
 * THE SERVER RECOMPUTES THE SUGGESTION. It does not accept one from the client
 * and judge the request against that — a client that supplies both the
 * suggestion and the "override" of it has not been bounded by anything.
 * Because the model is deterministic, the server can derive the same
 * suggestion the client was shown from the same two labels, so there is
 * nothing the client needs to be trusted about.
 *
 * ── THE RULES (16 Sep 2026) ─────────────────────────────────────────────────
 *
 * The value sets the bracket, and the bracket is what trading is judged on,
 * so raising it is raising your reach. Hence:
 *
 *   no number, or the suggestion itself   the suggestion stands; not user-set
 *   LOWER than the suggestion              allowed, always. Nobody games a
 *                                          bracket downwards.
 *   HIGHER, up to ONE bracket above the    allowed, user-set, live at once.
 *   suggestion's bracket
 *   HIGHER than that                       stored as REQUESTED, user-set, and
 *                                          `needsReview` — the listing waits
 *                                          in PENDING_REVIEW for an admin.
 *
 * This replaced a ±25% band that REFUSED anything outside it with a 400. The
 * band did two things badly: it blocked honest lowering (a 25% floor on a
 * suggestion that was simply wrong), and 25% up was sometimes no bracket at
 * all and sometimes two. A bracket cap is the rule the trading side actually
 * cares about, and review instead of refusal means a genuinely undervalued
 * item still has a path.
 *
 * There is no `ok: false` any more. Every request has an answer; the caller
 * decides what a `needsReview` answer means for the row's status.
 */
export async function decideItemValue(
  category: string,
  condition: string,
  requestedValue: number | null | undefined,
): Promise<ValuationOutcome> {
  const valuation = await valuate(category, condition)
  const { suggestedLeaves, valuationSource } = valuation
  const cap = valueCap(suggestedLeaves)
  const decision = classifyValue(requestedValue, suggestedLeaves)

  const userSet = decision !== "suggested"
  const valueLeaves = userSet ? Math.trunc(requestedValue as number) : suggestedLeaves

  return {
    ok: true,
    valuation,
    decision,
    needsReview: decision === "needsReview",
    cap,
    data: { valueLeaves, suggestedLeaves, valuationSource, valueSetByUser: userSet },
  }
}

/**
 * The sentence the owner is told when their value goes to review, and the
 * one an edit sheet shows in advance. One place, so the wizard, the edit
 * path and the notification agree on the words.
 */
export function reviewNotice(requested: number, suggestedLeaves: number): string {
  const cap = valueCap(suggestedLeaves)
  return (
    `Values above Bracket ${cap.maxBracketWithoutReview} are checked first. ` +
    `${requested.toLocaleString("en-US")} Leaves is Bracket ${bracketOf(requested)}, so this listing ` +
    `will show only to you until an admin approves it.`
  )
}
