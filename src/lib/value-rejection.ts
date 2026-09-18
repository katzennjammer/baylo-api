import type { ValueRejectionReason } from "@/generated/prisma/client"

/**
 * The closed list of reasons a value review can be refused for, and the
 * sentence each one puts in front of the owner.
 *
 * ── WHY THE OWNER IS TOLD, WHEN ID REJECTIONS TELL THEM LESS ──────────────
 *
 * ID verification shows a reason too, but hides who decided; report
 * resolutions show neither. This list exists because a rejected VALUE is
 * something the owner is being asked to FIX -- relist at the suggestion,
 * bring the number inside the cap, or delete -- and a person cannot fix what
 * they are not told. So the CODE is shown, deliberately. What is never shown
 * is the moderator's own note (audit-only, see the reject-value handler) or
 * the moderator's name (no `actorId` on the notification, same as every other
 * admin-raised notification in this codebase).
 *
 * ── ONE TABLE, THREE READERS ──────────────────────────────────────────────
 *
 *   `label`  the admin's word for it, in the <select> on the Listings page
 *   `owner`  the sentence the owner reads, on the notification and the review
 *            screen. Written to be actionable, not accusatory: ABOVE_MARKET
 *            is what an admin picks when they suspect a reach grab, and the
 *            owner is told the market fact, not the suspicion.
 *
 * The mobile client keeps a hand-mirrored copy of `owner` for the review
 * screen (it renders the code it is sent, so a code this file knows and the
 * app does not falls back to OTHER's sentence there). Change one, change the
 * other -- the same rule brackets.ts lives by.
 */
export const VALUE_REJECTION_REASONS: Record<
  ValueRejectionReason,
  { label: string; owner: string }
> = {
  OVERVALUED_FOR_CONDITION: {
    label: "Overvalued for its condition",
    owner: "The value asked for is more than this item's condition supports.",
  },
  ABOVE_MARKET: {
    label: "Above what similar items list for",
    owner: "Similar items on Baylo list for well below the value asked for.",
  },
  WRONG_CATEGORY: {
    label: "Category doesn't match the item",
    owner: "The category chosen doesn't match the item, so the value was judged against the wrong things.",
  },
  PHOTOS_DO_NOT_SUPPORT_VALUE: {
    label: "Photos don't support the value",
    owner: "The photos don't show enough to support the value asked for.",
  },
  OTHER: {
    label: "Other",
    owner: "The value asked for could not be approved.",
  },
}

export const VALUE_REJECTION_REASON_CODES = Object.keys(
  VALUE_REJECTION_REASONS,
) as ValueRejectionReason[]

/** The owner's sentence for a code; OTHER's for a code this build does not know. */
export function valueRejectionSentence(code: string | null | undefined): string {
  return (
    VALUE_REJECTION_REASONS[code as ValueRejectionReason]?.owner ??
    VALUE_REJECTION_REASONS.OTHER.owner
  )
}

/** The moderator's note on a rejection is capped here and in the form. */
export const VALUE_REJECTION_NOTE_MAX = 300
