/**
 * The Moderation column, in words that say who the listing is waiting on.
 * Shared by the Listings table and the listing detail page.
 *
 * "Visible" used to be the answer for anything not hidden, which on a
 * PENDING_REVIEW row was a lie: nobody but the owner could see it. Hidden
 * wins over the review states because it is the one an owner cannot undo by
 * editing.
 */
export function moderationLabel(status: string, hidden: boolean): { text: string; color: string } {
  if (hidden) return { text: "Hidden", color: "var(--adm-warn)" }
  if (status === "PENDING_REVIEW") return { text: "Waiting for review", color: "var(--adm-queue)" }
  if (status === "VALUE_REJECTED") return { text: "Value rejected — owner choosing", color: "var(--adm-warn)" }
  if (status === "AVAILABLE") return { text: "Visible", color: "var(--adm-good)" }
  return { text: "Not listed", color: "var(--adm-text-secondary)" }
}
