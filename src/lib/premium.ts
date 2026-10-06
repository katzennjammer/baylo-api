/** What the readers below need of a Subscription row. */
export type SubscriptionRow = { tier: "PREMIUM" | "VIP"; endsAt: Date }

/** How every reader loads them: `subscriptions: SUBSCRIPTION_SELECT` on a User. */
export const SUBSCRIPTION_SELECT = { select: { tier: true, endsAt: true } } as const

/** The latest endsAt among a user's rows of one tier, lapsed ones included. */
function tierUntil(subs: SubscriptionRow[] | null | undefined, tier: SubscriptionRow["tier"]): Date | null {
  let until: Date | null = null
  for (const s of subs ?? []) if (s.tier === tier && (!until || s.endsAt > until)) until = s.endsAt
  return until
}

/**
 * When this user's Premium / VIP runs (or ran) until, or null if they never
 * had it. These two are what the old User.premiumUntil / User.vipUntil columns
 * were, derived from the Subscription table.
 */
export const premiumUntil = (subs: SubscriptionRow[] | null | undefined) => tierUntil(subs, "PREMIUM")
export const vipUntil = (subs: SubscriptionRow[] | null | undefined) => tierUntil(subs, "VIP")

/**
 * The one reader of a Premium term: `isPremium(premiumUntil(user.subscriptions))`.
 *
 * A subscription is a DATE, not a flag: null or past means not subscribed, and
 * nothing has to run at expiry for that to become true. Every gate and every
 * payload that says "premium" goes through this function so the definition of
 * "subscribed" cannot fork.
 *
 * There is no writer in the app. Play Billing is the only lawful way to sell a
 * digital subscription inside the Android app and there is no Play Console
 * account to test it against, so rows are written by hand
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
 * A lifetime grant is stored as this exact sentinel in Subscription.endsAt rather
 * than as null (null already means "not subscribed" to every reader) or as a
 * flag column (a live migration for a term that is itself provisional). Because
 * it is a real future date, isPremium() and every gate that calls it -- the
 * bracket gate, the bridge-fee discount in offer-check, the achievement, the
 * assistant -- need no change. Nothing does arithmetic on endsAt.
 *
 * The one thing it must never do is reach a screen as a date ("until 31 Dec
 * 9999"): publicStanding() sends `premiumLifetime` so the phone says
 * "lifetime" instead. And because it is one exact value, the beta's lifetime
 * grants stay findable (`WHERE "endsAt" = sentinel`) when real pricing
 * lands and someone has to decide what happens to them.
 */
export const PREMIUM_LIFETIME_UNTIL = new Date("9999-12-31T00:00:00.000Z")

/** True when premiumUntil is the beta lifetime sentinel above. Display only. */
export function isLifetimePremium(premiumUntil: Date | null | undefined): boolean {
  return premiumUntil != null && premiumUntil.getTime() === PREMIUM_LIFETIME_UNTIL.getTime()
}

/**
 * The one reader of a VIP term. Same date-not-flag shape as isPremium()
 * above, set by hand today via scripts/set-premium.ps1.
 *
 * VIP is a superset of Premium: isVip() true means the caller passes every
 * Premium gate too, without a PREMIUM row needing to exist. Callers that need
 * "does this person have at least Premium access" should check
 * `isPremium(premiumUntil(subs)) || isVip(vipUntil(subs))`, not isVip() alone.
 */
export function isVip(vipUntil: Date | null | undefined, now: Date = new Date()): boolean {
  return vipUntil != null && vipUntil.getTime() > now.getTime()
}
