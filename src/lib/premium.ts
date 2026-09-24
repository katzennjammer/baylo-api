/**
 * The one reader of `User.premiumUntil`.
 *
 * A subscription is a DATE, not a flag: null or past means not subscribed, and
 * nothing has to run at expiry for that to become true. Every gate and every
 * payload that says "premium" goes through this function so the definition of
 * "subscribed" cannot fork.
 *
 * There is no writer in the app. Play Billing is the only lawful way to sell a
 * digital subscription inside the Android app and there is no Play Console
 * account to test it against, so the column is set by hand
 * (scripts/set-premium.ps1) and read by ONE place: isPremium() in
 * @/lib/premium. What it gates is ACQUIRING an item whose value bracket is
 * PREMIUM_MIN_BRACKET or above -- proposing for one, or accepting an offer
 * of one -- see @/lib/brackets. It never hides a listing and never gates
 * giving one away.
 */
export function isPremium(premiumUntil: Date | null | undefined, now: Date = new Date()): boolean {
  return premiumUntil != null && premiumUntil.getTime() > now.getTime()
}

/**
 * The one reader of `User.vipUntil`. Same date-not-flag shape as isPremium()
 * above, set by hand today via scripts/set-premium.ps1.
 *
 * VIP is a superset of Premium: isVip() true means the caller passes every
 * Premium gate too, without premiumUntil needing to be set. Callers that need
 * "does this person have at least Premium access" should check
 * `isPremium(user.premiumUntil) || isVip(user.vipUntil)`, not isVip() alone.
 */
export function isVip(vipUntil: Date | null | undefined, now: Date = new Date()): boolean {
  return vipUntil != null && vipUntil.getTime() > now.getTime()
}
