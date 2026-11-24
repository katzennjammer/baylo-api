import { NextResponse } from "next/server"
import prisma from "@/lib/prisma"
import { getTrustTier, getTierLimits, type TrustTier, type TierLimits } from "@/lib/reputation"
import {
  bracketOf, bracketRange, PREMIUM_MIN_BRACKET, valueNeedsPremium,
} from "@/lib/brackets"
import { isLifetimePremium, isPremium, isVip, premiumUntil, vipUntil, SUBSCRIPTION_SELECT } from "@/lib/premium"

/**
 * Server-side enforcement of the reputation tiers.
 *
 * Until this file existed getTrustTier() was a badge. It coloured a chip on a
 * profile and restricted nothing, which meant every "limit" the product
 * described was really a suggestion that a client could decline to follow.
 * This module is where the tiers stop being decoration.
 *
 * THE RULE THIS FILE EXISTS FOR: a hidden button is not a control. Every check
 * below runs in a route handler, against the database, after the request has
 * been authenticated — never in a component, never as a `disabled` prop, never
 * as a field the client is trusted to echo back. The UI may absolutely hide the
 * button as well; that is a courtesy to the user, not a security boundary, and
 * removing it must change nothing about what the server permits.
 *
 * Each `enforce*` returns a ready-to-return NextResponse, or null to proceed —
 * the same shape as enforceRateLimit(), so a handler reads the same way whether
 * it is being limited by rate or by reputation.
 *
 * ── WHAT THIS FILE IS NOT, SINCE 16 SEP 2026 ────────────────────────────────
 *
 * It is not the bracket rule. "Same bracket, or one below for a fee" is about
 * the PAIR of items and lives in assessOffer() in @/lib/offer-check; the gates
 * here are about the PERSON acquiring. Two consequences worth stating:
 *
 *   - enforceCanInitiateTrade() is gone with deferred agreements. It blocked a
 *     defaulter from starting trades, and there are no defaults any more.
 *   - enforceReachForListing() is gone too. "Within one bracket of your best
 *     item" was a weaker form of the rule assessOffer() now applies to the
 *     specific item being offered, and two checks for one rule meant two
 *     different sentences for the same refusal.
 */

export interface TraderStanding {
  userId: string
  rating: number
  /** COMPLETED TradeRequest rows, counted — never User.totalTrades, which drifts. */
  completedTrades: number
  tier: TrustTier
  limits: TierLimits
  /** A live PREMIUM Subscription row at load time. See @/lib/premium. */
  premium: boolean
  /** A live VIP Subscription row at load time. See @/lib/premium. A superset of premium. */
  vip: boolean
  /**
   * The latest Subscription.endsAt per tier, DISPLAY-ONLY -- "your Premium expires 18 Oct 2026"
   * on the membership screen, or "expired 3 Sep 2026" for a lapsed one (a
   * beta lifetime grant holds a 9999 sentinel; publicStanding() flags it). Never
   * used to decide access: `premium`/`vip` above are what every enforcement
   * check reads, and a client must compare this date to "now" itself to know
   * which sentence it is looking at rather than trust a flag that could go
   * stale between page load and the moment it renders.
   */
  premiumUntil: Date | null
  vipUntil: Date | null
}

/**
 * The caller's standing, in two queries.
 *
 * Deliberately NOT cached and not denormalised onto User. These numbers gate
 * what a person may acquire, and a stale copy of them is worse than a slow one.
 *
 * It used to run two lazy contract sweeps first, because a lapsed deadline had
 * to become a default before the gate could read it. There are no contracts
 * now, so there is nothing to sweep and this is a plain read.
 */
export async function loadStanding(userId: string): Promise<TraderStanding> {
  const [user, completedTrades] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        rating: true, subscriptions: SUBSCRIPTION_SELECT,
        isOrgAccount: true, organization: { select: { verificationStatus: true } },
      },
    }),
    prisma.trade.count({
      where: { status: "COMPLETED", OR: [{ senderId: userId }, { receiverId: userId }] },
    }),
  ])

  const rating = user?.rating ?? 0
  const premiumEnds = premiumUntil(user?.subscriptions)
  const vipEnds = vipUntil(user?.subscriptions)
  const premium = isPremium(premiumEnds)
  const vip = isVip(vipEnds)
  // completedTrades, not User.totalTrades. The counter has drifted above the
  // real count on live data (two users sit one and two trades high), and a gate
  // that opens early is not a gate.
  const tier = getTrustTier(completedTrades, rating)

  /*
   * A VERIFIED SHOP HAS NO TIER CAP (26 Sep 2026). The trade-count ladder is
   * about a person building a reputation, and organisations do not climb it
   * (see @/lib/organizations); a verified MSME's standing is its verification.
   * Without this a shop accepting as itself would read as a New Trader with
   * zero completed trades and be capped at bracket 3 forever -- or until it
   * had done the trades a person does. The PREMIUM gate is untouched: a shop
   * subscribes like anyone, and acquiring a bracket-7 item needs it.
   * A shop that is PENDING or REJECTED keeps the ladder's cap.
   */
  const verifiedShop = user?.isOrgAccount === true && user.organization?.verificationStatus === "VERIFIED"
  const limits = verifiedShop ? { ...getTierLimits(tier), maxItemBracket: null } : getTierLimits(tier)

  return {
    userId, rating, completedTrades, tier, limits, premium, vip,
    premiumUntil: premiumEnds,
    vipUntil: vipEnds,
  }
}

/** 403 in the shape the pre-v1 routes use: `{ error }`. */
function forbidden(message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: message, ...extra }, { status: 403 })
}

// ── The premium bracket gate ─────────────────────────────────────────────────

/**
 * Refuses a non-subscriber ACQUIRING an item in bracket PREMIUM_MIN_BRACKET or
 * above -- on either path. A live Premium or VIP subscription clears it; there
 * is no VIP-only bracket since 22 Oct 2026 (see @/lib/brackets).
 *
 * Both paths, for the same reason the tier cap runs on both: it is a rule
 * about what a person takes in, and a rule that only bound proposers would be
 * avoided by asking the other side to propose. A non-subscriber whose own
 * listing draws an offer of a bracket-7 item is acquiring that item exactly as
 * if they had gone and asked for it; the accept tap is the same trade in the
 * other direction. What is NOT gated is giving: a non-subscriber may offer or
 * hand over their own bracket-9 item to anyone, because the exposure being
 * gated belongs to the side that receives it. (Until 11 Sep 2026 this was
 * propose-only, with the accept side left open as "a toll on selling"; that
 * reading missed that the acceptor is also the one receiving.)
 *
 * Ordered BEFORE the tier cap, deliberately. The lock is a property of the
 * ITEM -- everyone sees the same padlock on the same tile -- while the tier cap
 * is a property of the viewer. If the cap were checked first, the same
 * bracket-8 item would refuse a New Trader with a tier message and a Trusted
 * Trader with a premium one, and the bracket-7 rule would look arbitrary. The
 * client mirrors this order on item detail.
 *
 * An unvalued item passes here. It cannot reach a trade anyway — assessOffer()
 * refuses an item with no value on record, because a rule about brackets
 * cannot judge something that has none.
 *
 * `path` picks the copy. The mobile accept screen shows the message verbatim,
 * and "only proposing on it is locked" on a screen where the person is
 * accepting would name the wrong tap.
 */
export async function enforcePremiumForListing(
  standing: TraderStanding,
  itemIds: string[],
  path: "propose" | "accept" = "propose",
): Promise<NextResponse | null> {
  const ids = itemIds.filter(Boolean)
  if (ids.length === 0) return null
  if (standing.vip || standing.premium) return null

  const rows = await prisma.item.findMany({
    where: { id: { in: ids } },
    select: { id: true, title: true, valueLeaves: true },
  })

  const gated = rows.find((r) => valueNeedsPremium(r.valueLeaves))
  if (!gated) return null

  const lead =
    `Trading at bracket ${PREMIUM_MIN_BRACKET} and above needs a premium subscription, ` +
    `which is coming soon. `
  const tail =
    path === "accept"
      ? `"${gated.title}" is in that bracket, so accepting it is locked. The offer stays where it is.`
      : `"${gated.title}" stays visible; only proposing on it is locked.`
  return forbidden(lead + tail, {
    code: "PREMIUM_REQUIRED",
    bracket: bracketOf(gated.valueLeaves as number),
    minBracket: PREMIUM_MIN_BRACKET,
    path,
  })
}

// ── The item-value ceiling ───────────────────────────────────────────────────

/**
 * Caps the bracket of an item the user is about to ACQUIRE, when the tier has a
 * cap (`limits.maxItemBracket`).
 *
 * NO TIER HAS ONE since Nov 2026: every tier's `maxItemBracket` is null, so
 * this returns null (allowed) for every ordinary trader, as it already did for
 * Top Traders and verified shops. The trust tier no longer limits which items a
 * user may trade for. The gap rule (one bracket) and the Premium gate
 * (Bracket 7+) still do. The function stays so a cap can be reinstated by
 * setting a tier's `maxItemBracket` in @/lib/reputation-config.
 *
 * When a cap is set it applies to what the user RECEIVES, on both the initiate
 * and accept paths, and it compares brackets, not Leaves, so a refusal never
 * prints another person's exact value.
 *
 * An item with a NULL valueLeaves passes here, and cannot reach a trade
 * anyway — see the note on the premium gate.
 */
export async function enforceItemValueCeiling(
  standing: TraderStanding,
  itemIds: string[],
): Promise<NextResponse | null> {
  const capBracket = standing.limits.maxItemBracket
  if (capBracket === null) return null

  const ids = itemIds.filter(Boolean)
  if (ids.length === 0) return null

  // The top of the capped bracket, in Leaves, so the comparison stays a single
  // indexed query rather than a bracket computed per row in JavaScript.
  const ceiling = bracketRange(capBracket).max
  if (ceiling === null) return null

  const over = await prisma.item.findFirst({
    where: { id: { in: ids }, valueLeaves: { gt: ceiling } },
    select: { id: true, title: true, valueLeaves: true },
    orderBy: { valueLeaves: "desc" },
  })
  if (!over) return null

  const itemBracket = bracketOf(over.valueLeaves as number)
  return forbidden(
    `"${over.title}" is in Bracket ${itemBracket}. As a ${standing.tier} you can trade for ` +
      `items up to Bracket ${capBracket} — complete more trades to raise the limit.`,
    {
      code: "TIER_ITEM_VALUE_CAP",
      tier: standing.tier,
      capBracket,
      itemBracket,
    },
  )
}

/**
 * The two gates every trade-initiating route applies together, against the
 * item the caller would RECEIVE.
 *
 * One call so a new initiating path cannot pick up half of the protection,
 * which is the realistic way this gets broken later. Order: premium bracket,
 * then tier cap -- see enforcePremiumForListing() for why premium sits above.
 *
 * THE BRACKET RULE IS NOT HERE. A route that takes an offered item must also
 * call assessOffer() from @/lib/offer-check, which is what judges the pair and
 * prices the bridge. The two are separate because they answer different
 * questions and one of them needs both items.
 */
export async function enforceInitiateTrade(
  userId: string,
  acquiringItemIds: string[],
): Promise<{ response: NextResponse } | { response: null; standing: TraderStanding }> {
  const standing = await loadStanding(userId)
  const locked = await enforcePremiumForListing(standing, acquiringItemIds)
  if (locked) return { response: locked }
  const capped = await enforceItemValueCeiling(standing, acquiringItemIds)
  if (capped) return { response: capped }
  return { response: null, standing }
}

/**
 * The accept path: the same two gates, against what the ACCEPTER receives,
 * with the accept-side copy on the premium one.
 *
 * A separate function rather than a flag on the one above, so that the
 * difference between the two paths is visible at every call site instead of
 * hiding in a boolean argument.
 */
export async function enforceAcceptTrade(
  userId: string,
  acquiringItemIds: string[],
): Promise<{ response: NextResponse } | { response: null; standing: TraderStanding }> {
  const standing = await loadStanding(userId)
  const locked = await enforcePremiumForListing(standing, acquiringItemIds, "accept")
  if (locked) return { response: locked }
  const capped = await enforceItemValueCeiling(standing, acquiringItemIds)
  if (capped) return { response: capped }
  return { response: null, standing }
}

/**
 * The tier and limits as the client should see them.
 *
 * Served from /api/v1/profile/me so a client can grey out what is locked and
 * say why, instead of guessing at the rules or discovering them from a 403.
 * Everything here is advisory: the same numbers are re-derived server-side on
 * every attempt, and nothing the client sends about its own tier is read.
 *
 * `maxItemValueBracket` REPLACED `maxItemValueLeaves`. The client used the raw
 * figure to draw "a New Trader can trade for up to 600" beside a listing whose
 * exact value it was not supposed to show; the bracket says the same thing in
 * the vocabulary the rest of the flow speaks. Both are null for every tier now.
 *
 * The `contracts` block and `restrictions.canInitiateTrades` are gone with
 * deferred agreements. A client reading this payload can no longer be told
 * there is a debt system, because there is not one.
 */
export function publicStanding(standing: TraderStanding) {
  return {
    tier: standing.tier,
    /** isPremium(premiumUntil). Advisory here; enforced by enforcePremiumForListing(). */
    premium: standing.premium,
    /** isVip(vipUntil). Advisory here; enforced by enforcePremiumForListing(). */
    vip: standing.vip,
    /** DISPLAY-ONLY. See the field comment on TraderStanding. ISO or null. */
    premiumUntil: standing.premiumUntil?.toISOString() ?? null,
    /**
     * premiumUntil is the beta lifetime sentinel (see PREMIUM_LIFETIME_UNTIL
     * in @/lib/premium) -- show "lifetime", never the 9999 date. DISPLAY-ONLY.
     */
    premiumLifetime: isLifetimePremium(standing.premiumUntil),
    vipUntil: standing.vipUntil?.toISOString() ?? null,
    completedTrades: standing.completedTrades,
    rating: standing.rating,
    limits: {
      /** null is unlimited (the top tier). The figure the gate enforces. */
      maxItemBracket: standing.limits.maxItemBracket,
    },
    restrictions: {
      canAcceptTrades: true,
      canListItems: true,
    },
  }
}
