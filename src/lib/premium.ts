/**
 * The one reader of `User.premiumUntil`.
 *
 * A subscription is a DATE, not a flag: null or past means not subscribed, and
 * nothing has to run at expiry for that to become true. Every gate and every
 * payload that says "premium" goes through this function so the definition of
 * "subscribed" cannot fork.
 *
 * There is no writer in the app. Play Billing is the only lawful way to sell a
 * digital subscription inside the Android app, there is no Play Console
 * account yet to test it against, and a purchase flow that cannot be exercised
 * is worse than none. Until then `scripts/set-premium.ps1` sets the column by
 * hand so both sides of the gate can be demonstrated.
 */
export function isPremium(premiumUntil: Date | null | undefined, now: Date = new Date()): boolean {
  return premiumUntil != null && premiumUntil.getTime() > now.getTime()
}
