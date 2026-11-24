// Plain-language wording for the admin console: what an AdminAction.action
// means as something a person did, and how long ago a moment was. One place,
// so the dashboard feed and the Platform reports page read the same.

/** Completes the sentence "<name> …". Keyed by AdminActionKind. */
const ACTION_PHRASE: Record<string, string> = {
  REPORT_REVIEWING: "started reviewing a report",
  REPORT_DISMISSED: "dismissed a report",
  REPORT_ACTIONED: "resolved a report",
  LISTING_HIDDEN: "took down a listing",
  LISTING_UNHIDDEN: "restored a listing",
  USER_SUSPENDED: "suspended a user",
  USER_UNSUSPENDED: "lifted a suspension",
  HUB_CREATED: "added a hub",
  HUB_UPDATED: "edited a hub",
  HUB_DEACTIVATED: "deactivated a hub",
  HUB_REACTIVATED: "reactivated a hub",
  ID_VERIFICATION_APPROVED: "approved an ID",
  ID_VERIFICATION_REJECTED: "rejected an ID",
  ROLE_CHANGED: "changed an account's role",
  OFFER_EXPIRED: "expired an offer",
  LISTING_VALUE_APPROVED: "approved a listing value",
  LISTING_VALUE_REJECTED: "rejected a listing value",
  TRADE_REWARD_REVERSED: "reversed a trade reward",
  TRADE_CANCELLED: "cancelled a trade",
  // UPHELD means the original decision stood, i.e. the owner's appeal lost.
  LISTING_APPEAL_UPHELD: "denied an appeal",
  LISTING_APPEAL_OVERTURNED: "granted an appeal",
  ACHIEVEMENT_CREATED: "added an achievement",
  ACHIEVEMENT_UPDATED: "edited an achievement",
  ACHIEVEMENT_DEACTIVATED: "deactivated an achievement",
  ACHIEVEMENT_REACTIVATED: "reactivated an achievement",
  ORGANIZATION_VERIFIED: "verified an organization",
  ORGANIZATION_REJECTED: "rejected an organization",
}

/** "approved an ID". Falls back to the enum in lower case for a kind added later. */
export function actionPhrase(action: string): string {
  return ACTION_PHRASE[action] ?? action.split("_").join(" ").toLowerCase()
}

/** "Approved an ID" -- the same phrase as a standalone label. */
export function actionLabel(action: string): string {
  const phrase = actionPhrase(action)
  return phrase.charAt(0).toUpperCase() + phrase.slice(1)
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "always" })

/** "5 minutes ago", "3 hours ago", "12 days ago". */
export function timeAgo(date: Date): string {
  const minutes = Math.round((date.getTime() - Date.now()) / 60_000)
  if (Math.abs(minutes) < 1) return "just now"
  if (Math.abs(minutes) < 60) return relative.format(minutes, "minute")
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return relative.format(hours, "hour")
  return relative.format(Math.round(hours / 24), "day")
}

/**
 * A square Cloudinary thumbnail, `px` on a side, for admin tables. Only public
 * `image/upload/v<n>/` URLs are rewritten -- every URL /api/upload returns;
 * anything else (seed photos, an already-transformed URL) is used as it is.
 */
export function adminThumb(url: string, px: number): string {
  return url.replace(
    /^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(v\d+\/)/,
    `$1w_${px},h_${px},c_fill,q_auto,f_auto/$2`,
  )
}
