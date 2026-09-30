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
 * PROVISIONAL -- BETA PRICING ONLY (30 Sep 2026). During the beta, Premium is
 * sold as a one-time ₱199 LIFETIME grant, not a yearly subscription. The real
 * price and term are undecided and WILL change; do not build on this as if it
 * were the permanent model.
 *
 * A lifetime grant is stored as this exact sentinel in premiumUntil rather
 * than as null (null already means "not subscribed" to every reader) or as a
 * new column (a live migration for a term that is itself provisional). Because
 * it is a real future date, isPremium() and every gate that calls it -- the
 * bracket gate, the bridge-fee discount in offer-check, the achievement, the
 * assistant -- need no change. Nothing does arithmetic on premiumUntil.
 *
 * The one thing it must never do is reach a screen as a date ("until 31 Dec
 * 9999"): publicStanding() sends `premiumLifetime` so the phone says
 * "lifetime" instead. And because it is one exact value, the beta's lifetime
 * grants stay findable (`WHERE "premiumUntil" = sentinel`) when real pricing
 * lands and someone has to decide what happens to them.
 */
export const PREMIUM_LIFETIME_UNTIL = new Date("9999-12-31T00:00:00.000Z")

/** True when premiumUntil is the beta lifetime sentinel above. Display only. */
export function isLifetimePremium(premiumUntil: Date | null | undefined): boolean {
  return premiumUntil != null && premiumUntil.getTime() === PREMIUM_LIFETIME_UNTIL.getTime()
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
