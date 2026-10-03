/**
 * Organisation staff (members, invitations, roles) were removed in schema v2:
 * the owner (Organization.ownerId) is the only person who acts as a shop. The
 * retired member routes answer 410 with this sentence.
 */
export const STAFF_REMOVED_MESSAGE =
  "Staff accounts have been removed. The shop's owner posts and trades as the business."
