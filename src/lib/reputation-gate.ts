import { NextResponse } from "next/server"
import prisma from "@/lib/prisma"
import {
  getTrustTier,
  getEffectiveTier,
  getTierLimits,
  type TrustTier,
  type TierLimits,
} from "@/lib/reputation"
import {
  expireStaleProposals,
  loadDebtorStanding,
  sweepLapsedContracts,
  type DebtorStanding,
} from "@/lib/contracts"
import { bracketOf, PREMIUM_MIN_BRACKET, valueNeedsPremium } from "@/lib/brackets"
import { isPremium } from "@/lib/premium"

/**
 * Server-side enforcement of the reputation tiers.
 *
 * Until now getTrustTier() was a badge. It coloured a chip on a profile and
 * restricted nothing, which meant every "limit" the product described was
 * really a suggestion that a client could decline to follow. This module is
 * where the tiers stop being decoration.
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
 */

export interface TraderStanding extends DebtorStanding {
  userId: string
  rating: number
  /** What the trade history alone says. Shown for explanation, never enforced on. */
  baseTier: TrustTier
  /** The base tier after DPA defaults are charged against it. THIS is enforced on. */
  tier: TrustTier
  limits: TierLimits
  /** isPremium(User.premiumUntil) at load time. See @/lib/premium. */
  premium: boolean
}

/**
 * The caller's full standing, with the lazy deadline sweep run first.
 *
 * The sweep runs BEFORE the counts are read, and that ordering is the whole
 * point of putting it here: a deadline that lapsed an hour ago must already be
 * a default by the time this function decides whether the user may start a
 * trade. There is no cron, so if the gate did not sweep, a defaulter would keep
 * full privileges for as long as nobody happened to open their contract list.
 */
export async function loadStanding(userId: string): Promise<TraderStanding> {
  await sweepLapsedContracts(prisma, { debtorId: userId })
  // And the other half of the sweep: a PENDING_ACCEPT proposal past its own
  // deadline lapses to DECLINED, freeing the slot it was holding. It runs here
  // for exactly the reason the default sweep does — this function decides
  // whether the user may propose, and a proposal nobody ever answered must not
  // still be counted as a commitment by the time it does. See the note on
  // expireStaleProposals().
  await expireStaleProposals(prisma, { debtorId: userId })

  const [user, standing] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { rating: true, premiumUntil: true },
    }),
    loadDebtorStanding(prisma, userId),
  ])

  const rating = user?.rating ?? 0
  const premium = isPremium(user?.premiumUntil)
  // completedTrades, not User.totalTrades. The counter has drifted above the
  // real count on live data (two users sit one and two trades high), and a gate
  // that opens early is not a gate.
  const baseTier = getTrustTier(standing.completedTrades, rating)
  const tier = getEffectiveTier(standing.completedTrades, rating, {
    lifetimeDefaults: standing.lifetimeDefaults,
    hasUnsettledDefault: standing.hasUnsettledDefault,
  })

  return { ...standing, userId, rating, baseTier, tier, limits: getTierLimits(tier), premium }
}

/** 403 in the shape the pre-v1 routes use: `{ error }`. */
function forbidden(message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: message, ...extra }, { status: 403 })
}

// ── The initiating restriction ───────────────────────────────────────────────

/**
 * Blocks a user with a standing default from STARTING a trade.
 *
 * Read the asymmetry carefully, because getting it wrong produces a deadlock
 * that no amount of good behaviour escapes:
 *
 *   BLOCKED   proposing a trade, making an offer — anything where the defaulter
 *             reaches for someone else's item and takes on more exposure.
 *   ALLOWED   accepting a trade or an offer, and listing items.
 *
 * Trading is the only way to earn Leaves in this economy. A blanket ban would
 * mean a defaulter can never earn the Leaves that would clear the default that
 * caused the ban — permanently restricted, with no move available that improves
 * their position. So the accept path is deliberately left open, and listing is
 * left open too, because a defaulter with no listings would have nothing for
 * anyone to make them an offer on and the open accept path would be theatre.
 *
 * The path out is concrete: list, receive an offer, accept it, complete the
 * swap. Both the Leaves received and the VERIFIED_SWAP task reward land in the
 * debtor's balance, applyEarningsToContracts() sweeps them straight to the
 * creditor, and when the last Leaf lands the contract goes FULFILLED and this
 * function stops returning a 403.
 *
 * Note also what the defaulter CANNOT do through the open accept path: spend.
 * On both the offer and the trade paths it is the initiator who pledges Leaves,
 * so a blocked initiator is already a blocked spender, and the accept path can
 * only bring Leaves in.
 */
export function enforceCanInitiateTrade(standing: TraderStanding): NextResponse | null {
  if (!standing.hasUnsettledDefault) return null
  return forbidden(
    "You have an unfulfilled deferred agreement. You cannot start new trades until it is settled — " +
      "you can still list items and accept offers, and Leaves you earn go straight to the debt.",
    {
      code: "DPA_DEFAULTED",
      outstandingDebt: standing.outstandingDebt,
    },
  )
}

// ── The premium bracket gate ─────────────────────────────────────────────────

/**
 * Refuses a non-subscriber ACQUIRING an item in bracket PREMIUM_MIN_BRACKET or
 * above -- on either path.
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
 * Ordered AFTER the default block (where the path has one) and BEFORE the tier
 * cap, deliberately. The lock is a property of the ITEM -- everyone sees the
 * same padlock on the same tile -- while the tier cap is a property of the
 * viewer. If the cap were checked first, the same bracket-8 item would refuse
 * a New Trader with a tier message and a Trusted Trader with a premium one,
 * and the bracket-7 rule would look arbitrary. The client mirrors this order
 * on item detail.
 *
 * An unvalued item passes, for the same reason it passes the tier cap: it has
 * no bracket to be in.
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
  if (standing.premium) return null

  const ids = itemIds.filter(Boolean)
  if (ids.length === 0) return null

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
 * Caps the value of an item the user is about to ACQUIRE.
 *
 * Applied to what they receive, never to what they give: the exposure being
 * capped belongs to the counterparty handing over the item, not to the user
 * handing over their own.
 *
 * Applies on BOTH the initiate and accept paths, unlike the default
 * restriction above. Reaching for a 5,000-Leaf item is the same reach whoever
 * started the conversation, and a cap that only bound initiators would be
 * avoided by asking the other party to send the offer.
 *
 * An item with a NULL valueLeaves passes. That is a real hole and worth naming:
 * valueLeaves is optional on Item and one live listing has none, so an unvalued
 * listing is currently uncapped. Refusing every unvalued item instead would
 * block ordinary trading on listings that predate valuation, which is a bigger
 * hole in the other direction. Closing it properly means making valueLeaves
 * required, which is a valuation change and out of scope here.
 */
export async function enforceItemValueCeiling(
  standing: TraderStanding,
  itemIds: string[],
): Promise<NextResponse | null> {
  const cap = standing.limits.maxItemValueLeaves
  if (cap === null) return null

  const ids = itemIds.filter(Boolean)
  if (ids.length === 0) return null

  const over = await prisma.item.findFirst({
    where: { id: { in: ids }, valueLeaves: { gt: cap } },
    select: { id: true, title: true, valueLeaves: true },
    orderBy: { valueLeaves: "desc" },
  })
  if (!over) return null

  return forbidden(
    `"${over.title}" is valued at ${over.valueLeaves} Leaves. As a ${standing.tier} you can trade for ` +
      `items up to ${cap} Leaves — complete more trades to raise the limit.`,
    {
      code: "TIER_ITEM_VALUE_CAP",
      tier: standing.tier,
      cap,
      itemValueLeaves: over.valueLeaves,
    },
  )
}

/**
 * The three gates that every trade-initiating route applies together.
 *
 * One call so a new initiating path cannot pick up a third of the protection,
 * which is the realistic way this gets broken later. Order: default block,
 * premium bracket, tier cap -- see enforcePremiumForListing() for why premium
 * sits above the cap.
 */
export async function enforceInitiateTrade(
  userId: string,
  acquiringItemIds: string[],
): Promise<{ response: NextResponse } | { response: null; standing: TraderStanding }> {
  const standing = await loadStanding(userId)
  const blocked = enforceCanInitiateTrade(standing)
  if (blocked) return { response: blocked }
  const locked = await enforcePremiumForListing(standing, acquiringItemIds)
  if (locked) return { response: locked }
  const capped = await enforceItemValueCeiling(standing, acquiringItemIds)
  if (capped) return { response: capped }
  return { response: null, standing }
}

/**
 * The accept path: premium bracket, then value ceiling -- never the default
 * block. Same order as the initiate path with the first gate removed, so a
 * bracket-7 item answers PREMIUM_REQUIRED to a non-subscriber on either side
 * of the trade.
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
 */
export function publicStanding(standing: TraderStanding) {
  return {
    tier: standing.tier,
    baseTier: standing.baseTier,
    /** isPremium(premiumUntil). Advisory here; enforced by enforcePremiumForListing(). */
    premium: standing.premium,
    completedTrades: standing.completedTrades,
    rating: standing.rating,
    limits: {
      maxItemValueLeaves: standing.limits.maxItemValueLeaves,
      mayProposeDpa: standing.limits.mayProposeDpa,
      maxOutstandingDebtLeaves: standing.limits.maxOutstandingDebtLeaves,
    },
    contracts: {
      outstandingDebt: standing.outstandingDebt,
      committedDebt: standing.committedDebt,
      remainingDebtHeadroom: Math.max(
        0,
        standing.limits.maxOutstandingDebtLeaves - standing.committedDebt,
      ),
      openContracts: standing.openContracts,
      lifetimeDefaults: standing.lifetimeDefaults,
      hasUnsettledDefault: standing.hasUnsettledDefault,
      onTimeRate: standing.onTimeRate,
    },
    restrictions: {
      canInitiateTrades: !standing.hasUnsettledDefault,
      // Always true. Spelled out rather than omitted, because it is the field
      // that tells a client the accept path is deliberately open to a
      // defaulter, and a client author reading only `canInitiateTrades: false`
      // would reasonably assume everything else is shut too.
      canAcceptTrades: true,
      canListItems: true,
    },
  }
}
