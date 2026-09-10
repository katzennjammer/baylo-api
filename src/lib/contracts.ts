import type { PrismaClient } from "@/generated/prisma/client"
import { DPA } from "@/lib/reputation-config"
import { getEffectiveTier, type TrustTier } from "@/lib/reputation"

/**
 * Deferred Points Agreements.
 *
 * A DPA is a promise: two items were unequal in value, the party who received
 * the better one owes the difference in Leaves, and they have until a deadline
 * to earn it. Everything in this file exists to keep that promise enforceable
 * by the only two means the system actually has.
 *
 * WHAT IT CANNOT DO, AND WHY THAT IS THE DESIGN. There is no repossession here,
 * no reversal, no return. The item was handed over at a meetup between two
 * people and no amount of database state can bring it back; a function called
 * reverseTrade() would be a fiction with a stack trace. So a default costs the
 * debtor their tier, their public record, and their ability to start new
 * trades, and nothing else.
 *
 * DEBT SURVIVES DEFAULT. Marking a contract DEFAULTED does not close it or zero
 * what is owed: auto-payment keeps applying to defaulted contracts exactly as
 * it does to active ones. If default wiped the balance, default would be the
 * cheapest way to pay.
 *
 * AND THERE IS A WAY BACK. A defaulter is blocked from INITIATING trades, never
 * from accepting them or from listing items — see the note on the restriction
 * in @/lib/reputation-gate. Trading is now the only source of Leaves, so a
 * blanket ban would leave a defaulter permanently unable to earn the Leaves
 * that would clear the default that caused the ban.
 */

type ContractDb = Pick<
  PrismaClient,
  "user" | "deferredContract" | "leafTransaction" | "tradeRequest"
>

/** Statuses in which principal is still owed. */
export const OWING_STATUSES = ["ACTIVE", "DEFAULTED"] as const

/**
 * Statuses that occupy a debtor's single contract slot and count against their
 * tier's debt ceiling. PENDING_ACCEPT is in here on purpose: a proposal that
 * has not been accepted is not debt yet, but five of them stacked under the cap
 * all become debt the moment five creditors say yes.
 */
export const COMMITTING_STATUSES = ["PENDING_ACCEPT", "ACTIVE", "DEFAULTED"] as const

export interface DebtorStanding {
  /** COMPLETED TradeRequest rows, counted — never User.totalTrades, which drifts. */
  completedTrades: number
  /** Unpaid principal across ACTIVE and DEFAULTED contracts. */
  outstandingDebt: number
  /** outstandingDebt plus principal on PENDING_ACCEPT proposals. */
  committedDebt: number
  /** Contracts in a COMMITTING status right now. */
  openContracts: number
  /** Contracts ever stamped defaultedAt, including ones since paid off. */
  lifetimeDefaults: number
  /** A DEFAULTED contract standing right now. This is what blocks initiating. */
  hasUnsettledDefault: boolean
  /**
   * Share of finished contracts settled on or before their deadline, or null
   * when this debtor has never finished one.
   *
   * Null rather than 0 or 1. A debtor with no history has no rate, and showing
   * "0% on time" for someone who has simply never borrowed would be a lie that
   * costs them a creditor.
   */
  onTimeRate: number | null
  finishedContracts: number
}

/**
 * Everything a creditor's decision and every server-side gate needs about one
 * debtor, in three queries.
 *
 * Deliberately NOT cached and not denormalised onto User. These numbers gate
 * decisions about who owes what, and a stale copy of them is worse than a slow
 * one.
 */
export async function loadDebtorStanding(
  db: ContractDb,
  userId: string,
): Promise<DebtorStanding> {
  const [completedTrades, open, finished] = await Promise.all([
    db.tradeRequest.count({
      where: { status: "COMPLETED", OR: [{ senderId: userId }, { receiverId: userId }] },
    }),
    db.deferredContract.findMany({
      where: { debtorId: userId, status: { in: [...COMMITTING_STATUSES] } },
      select: { status: true, amountLeaves: true, amountPaidLeaves: true },
    }),
    // Every contract that ever reached an end. `defaultedAt` rather than
    // `status` is what identifies a past default below, because a defaulted
    // contract that was later paid off now reads FULFILLED and must still count.
    db.deferredContract.findMany({
      where: { debtorId: userId, status: { in: ["FULFILLED", "DEFAULTED"] } },
      select: { status: true, deadline: true, fulfilledAt: true, defaultedAt: true },
    }),
  ])

  let outstandingDebt = 0
  let committedDebt = 0
  for (const c of open) {
    const unpaid = Math.max(0, c.amountLeaves - c.amountPaidLeaves)
    committedDebt += unpaid
    if (c.status !== "PENDING_ACCEPT") outstandingDebt += unpaid
  }

  const lifetimeDefaults = finished.filter((c) => c.defaultedAt !== null).length
  const onTime = finished.filter(
    (c) => c.status === "FULFILLED" && c.fulfilledAt !== null && c.fulfilledAt <= c.deadline,
  ).length

  return {
    completedTrades,
    outstandingDebt,
    committedDebt,
    openContracts: open.length,
    lifetimeDefaults,
    hasUnsettledDefault: open.some((c) => c.status === "DEFAULTED"),
    onTimeRate: finished.length === 0 ? null : onTime / finished.length,
    finishedContracts: finished.length,
  }
}

/**
 * The EFFECTIVE trust tier for many users at once — what a badge is allowed to
 * claim about each of them.
 *
 * The batched sibling of loadDebtorStanding(). That function answers everything
 * about ONE debtor in three queries; a feed page needs one number about twenty
 * people, and twenty times three queries on the hottest endpoint in the app is
 * not a trade anyone would make. This is the same rules over a whole page in
 * three queries TOTAL.
 *
 * WHY IT IS NOT `getTrustTier(user.totalTrades, user.rating)`. Two reasons,
 * both of which put a badge and a gate in direct contradiction:
 *
 *   1. `User.totalTrades` DRIFTS. It is a denormalised counter and it currently
 *      sits above the real COMPLETED count on live rows — one user reads 3
 *      there and has 2 real completed trades, which is the difference between
 *      "Rising Trader" on their badge and "New Trader" at the gate. Every gate
 *      in this codebase counts TradeRequest rows instead; so does this.
 *   2. TIERS ARE CHARGED FOR DPA DEFAULTS and a raw getTrustTier() knows
 *      nothing about them. An unsettled default floors a user outright. Without
 *      this, a defaulter with thirty trades wears "Top Trader" while the
 *      contract gates refuse to let them initiate anything.
 *
 * THE SWEEP IS NOT RUN, AND THE LAPSE IS COUNTED ANYWAY. sweepLapsedContracts()
 * is a WRITE, and a feed read must not issue one per owner per page. Instead an
 * ACTIVE contract already past its deadline is treated here as the unsettled
 * default it is about to become — the same condition the sweep tests, evaluated
 * without persisting anything. That is what keeps the badge honest in the
 * window between a deadline passing and somebody touching that debtor's
 * contracts, which on a quiet account can be days. It is safe to leave
 * `lifetimeDefaults` alone in that window because an unsettled default floors
 * the tier outright, and the floor is below anything the per-default demotion
 * could reach.
 *
 * `ratings` is passed in rather than queried because every caller already has
 * it — the owner block selects `rating` — and a fourth query for a column
 * already in hand is the kind of thing that turns one endpoint into seventeen.
 */
export async function loadEffectiveTiers(
  db: ContractDb,
  users: readonly { id: string; rating: number }[],
  now: Date = new Date(),
): Promise<Map<string, TrustTier>> {
  const out = new Map<string, TrustTier>()
  if (users.length === 0) return out

  const ids = [...new Set(users.map((u) => u.id))]

  const [sent, received, defaults] = await Promise.all([
    // Completed trades, counted from the rows. Prisma cannot group on "either
    // of two columns", so the two sides are counted separately and added. That
    // is identical to the single-user count({ OR: [...] }) for every row where
    // sender and receiver differ, which is every row — a self-trade has no
    // meaning here and no path in the API creates one.
    db.tradeRequest.groupBy({
      by: ["senderId"],
      where: { status: "COMPLETED", senderId: { in: ids } },
      _count: { _all: true },
    }),
    db.tradeRequest.groupBy({
      by: ["receiverId"],
      where: { status: "COMPLETED", receiverId: { in: ids } },
      _count: { _all: true },
    }),
    // One aggregate for both default facts. Grouping by status as well as
    // debtor is what lets a single pass answer "how many ever" and "is one
    // outstanding right now" — DEFAULTED rows are the unsettled ones, and a
    // lapsed ACTIVE row is a DEFAULTED row the sweep has not written yet.
    db.deferredContract.groupBy({
      by: ["debtorId", "status"],
      where: {
        debtorId: { in: ids },
        OR: [
          // Every default that ever happened, including ones since paid off:
          // `defaultedAt` survives the status going back to FULFILLED, which is
          // exactly why it and not `status` identifies a past default.
          { status: { in: ["FULFILLED", "DEFAULTED"] }, defaultedAt: { not: null } },
          { status: "ACTIVE", deadline: { lt: now } },
        ],
      },
      _count: { _all: true },
    }),
  ])

  const trades = new Map<string, number>()
  for (const row of sent) {
    trades.set(row.senderId, (trades.get(row.senderId) ?? 0) + row._count._all)
  }
  for (const row of received) {
    trades.set(row.receiverId, (trades.get(row.receiverId) ?? 0) + row._count._all)
  }

  const lifetimeDefaults = new Map<string, number>()
  const unsettled = new Set<string>()
  for (const row of defaults) {
    lifetimeDefaults.set(row.debtorId, (lifetimeDefaults.get(row.debtorId) ?? 0) + row._count._all)
    // DEFAULTED is an unpaid default standing right now; ACTIVE only reached
    // this result set by being past its deadline, which is the same thing one
    // sweep away.
    if (row.status === "DEFAULTED" || row.status === "ACTIVE") unsettled.add(row.debtorId)
  }

  for (const user of users) {
    out.set(
      user.id,
      getEffectiveTier(trades.get(user.id) ?? 0, user.rating, {
        lifetimeDefaults: lifetimeDefaults.get(user.id) ?? 0,
        hasUnsettledDefault: unsettled.has(user.id),
      }),
    )
  }
  return out
}

// ── The lazy deadline sweep ──────────────────────────────────────────────────

/**
 * Moves every lapsed ACTIVE contract to DEFAULTED. Returns how many actually
 * transitioned on THIS call.
 *
 * There is no cron, so this runs on read: every contract endpoint, the profile,
 * and every gate check calls it before deciding anything. Scoped by debtor or
 * by contract wherever the caller knows one, so the common case touches an
 * indexed handful of rows rather than the whole table.
 *
 * DOUBLE-APPLICATION IS PREVENTED STRUCTURALLY, not by remembering. The status
 * transition is a CONDITIONAL write — `WHERE id = ? AND status = 'ACTIVE'` —
 * and its affected-row count is the sole authority for whether this call was
 * the one that defaulted the contract. Two requests racing the same lapsed
 * deadline both run the update; exactly one gets count 1.
 *
 * The reputational penalty needs no idempotence work of its own, because it is
 * not applied here at all: the tier demotion is DERIVED from defaultedAt at
 * read time by getEffectiveTier(). There is no counter that could be
 * incremented twice, which is the failure this design is avoiding rather than
 * guarding against. `defaultedAt` is stamped by the same conditional write.
 */
export async function sweepLapsedContracts(
  db: ContractDb,
  scope: { debtorId?: string; contractId?: string } = {},
): Promise<number> {
  const now = new Date()
  const lapsed = await db.deferredContract.findMany({
    where: {
      status: "ACTIVE",
      deadline: { lt: now },
      ...(scope.debtorId ? { debtorId: scope.debtorId } : {}),
      ...(scope.contractId ? { id: scope.contractId } : {}),
    },
    select: { id: true },
  })
  if (lapsed.length === 0) return 0

  let defaulted = 0
  for (const { id } of lapsed) {
    const res = await db.deferredContract.updateMany({
      where: { id, status: "ACTIVE" },
      data: { status: "DEFAULTED", defaultedAt: now },
    })
    // count === 0 means another request got there first. Not an error, and
    // emphatically not a reason to apply anything a second time.
    defaulted += res.count
  }
  return defaulted
}

// ── Auto-payment ─────────────────────────────────────────────────────────────

export interface ContractPayment {
  contractId: string
  creditorId: string
  amount: number
  fulfilled: boolean
}

/**
 * Applies a debtor's spendable Leaves to their open contracts, oldest first.
 *
 * Called on every event that CREDITS a debtor: a task reward, Leaves received
 * in a settled trade, the signup grant. The debtor never presses "pay" — the
 * rule is that earned Leaves go to the debt before they go anywhere else, and
 * the debtor does not get to opt out of it.
 *
 * DEFAULTED contracts are paid down here too, not just ACTIVE ones. That is
 * what makes the debt survive the default, and it is also the way out of the
 * trading restriction: keep accepting trades, keep earning, and the contract
 * eventually reaches FULFILLED and the restriction lifts.
 *
 * Contract debt outranks Leaves already pledged to pending offers.
 * availableLeaves() subtracts pending offers from the balance, and this
 * function deliberately does not consult it — otherwise a debtor parks their
 * whole balance in open offers and never pays. An offer left short by a payment
 * fails its own re-check when the receiver accepts, a path that already exists
 * and already returns a clear 400.
 *
 * MUST run inside a transaction. Each payment writes the CONTRACT_PAY /
 * CONTRACT_COLLECT ledger pair and moves both balances in the same statement
 * sequence, so SUM(User.leaves) == SUM(LeafTransaction.amount) holds at every
 * commit boundary and is never observable mid-flight.
 */
export async function applyEarningsToContracts(
  db: ContractDb,
  debtorId: string,
): Promise<ContractPayment[]> {
  const contracts = await db.deferredContract.findMany({
    where: { debtorId, status: { in: [...OWING_STATUSES] } },
    select: {
      id: true, creditorId: true, amountLeaves: true, amountPaidLeaves: true, status: true,
    },
    // Oldest first, id as the tiebreaker so two contracts created in the same
    // millisecond still have a defined order.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })
  if (contracts.length === 0) return []

  // Read INSIDE the transaction. The balance this function is about to spend
  // was credited moments ago by the caller, so a value read before that credit
  // would be stale by exactly the amount that matters.
  const debtor = await db.user.findUnique({ where: { id: debtorId }, select: { leaves: true } })
  let balance = debtor?.leaves ?? 0
  if (balance <= 0) return []

  const payments: ContractPayment[] = []
  const paidAt = new Date()

  for (const c of contracts) {
    if (balance <= 0) break
    const unpaid = Math.max(0, c.amountLeaves - c.amountPaidLeaves)
    if (unpaid === 0) continue

    const paid = await payContract(db, {
      contract: c,
      debtorId,
      amount: Math.min(unpaid, balance),
      paidAt,
      // The sweep is opportunistic: another writer landing on the same contract
      // between the read and the write means "already handled", not a failure.
      // The deliberate path wants the opposite answer -- see the flag's note.
      strict: false,
    })
    if (!paid) continue

    balance -= paid.amount
    payments.push(paid)
  }

  return payments
}

/**
 * ONE PAYMENT AGAINST ONE CONTRACT. The only place Leaves move for a debt.
 *
 * ── WHY THIS IS A FUNCTION AND NOT TWO COPIES ───────────────────────────────
 *
 * There are two ways a contract gets paid down and they differ only in how the
 * amount is chosen:
 *
 *   applyEarningsToContracts()  the debtor earns, and whatever they earned goes
 *                               to the oldest debt first, without being asked.
 *   POST /contracts/[id]/settle the debtor names an amount and a contract.
 *
 * Everything after that decision is identical — the conditional status write,
 * the two balance moves, the CONTRACT_PAY / CONTRACT_COLLECT ledger pair — and
 * it is the part that must not drift. A second copy of this would be a second
 * chance to write one ledger row and not the other, which is precisely the
 * failure the invariant below exists to make impossible.
 *
 * ── MUST RUN INSIDE A TRANSACTION ───────────────────────────────────────────
 *
 *     SUM(User.leaves) == SUM(LeafTransaction.amount)
 *
 * holds at every commit boundary because both balances and both ledger rows
 * move in one statement sequence. Called outside a transaction, a crash between
 * the two `user.update` calls mints or destroys Leaves. Every caller passes a
 * `tx`.
 *
 * ── THE STATUS WRITE IS THE CONCURRENCY CONTROL ─────────────────────────────
 *
 * `updateMany` is conditional on the `amountPaidLeaves` the caller read AND on
 * the contract still being in an owing status. Two requests racing the same
 * contract both run it; exactly one gets `count: 1` and the other pays nothing.
 * That is what stops a double-tap on a Settle button paying twice, and it is
 * also why the amount is validated against a figure read in the same
 * transaction rather than one the client sent.
 *
 * `lifetimeLeaves` is untouched on both sides. It is the monotonic earned-ever
 * figure ranks key off, and moving Leaves between two users is not earning — a
 * trade settlement does not touch it either.
 *
 * Returns `null` when the conditional write lost, and see `strict` for what a
 * caller should do about that.
 */
export async function payContract(
  db: ContractDb,
  input: {
    /** Read in the same transaction. `amountPaidLeaves` is the CAS witness. */
    contract: {
      id: string
      creditorId: string
      amountLeaves: number
      amountPaidLeaves: number
    }
    debtorId: string
    /** Already clamped to the unpaid remainder and to the debtor's balance. */
    amount: number
    paidAt?: Date
    /**
     * What losing the conditional write means to this caller.
     *
     * `false` (the sweep): another writer got there first, which is a normal
     * outcome of two credits landing at once. Skip the contract and carry on.
     *
     * `true` (a deliberate settlement): the debtor asked to pay a specific
     * amount against a specific contract and it did not happen. Silently paying
     * nothing while answering 200 would tell somebody their debt had moved when
     * it had not, so the route needs to know and answers 409.
     */
    strict?: boolean
  },
): Promise<ContractPayment | null> {
  const { contract: c, debtorId, amount } = input
  const paidAt = input.paidAt ?? new Date()

  if (amount <= 0) return null

  const nowPaid = c.amountPaidLeaves + amount
  const fulfilled = nowPaid >= c.amountLeaves

  const moved = await db.deferredContract.updateMany({
    where: {
      id: c.id,
      amountPaidLeaves: c.amountPaidLeaves,
      status: { in: [...OWING_STATUSES] },
    },
    data: {
      amountPaidLeaves: nowPaid,
      // A defaulted contract paid off in full becomes FULFILLED. defaultedAt is
      // NOT cleared — the default stays on the record permanently — but the
      // status change is what releases the trading restriction. That is the
      // "leave a path out" requirement, and this line is it.
      ...(fulfilled ? { status: "FULFILLED" as const, fulfilledAt: paidAt } : {}),
    },
  })
  if (moved.count !== 1) {
    if (input.strict) {
      throw new ContractRaceError(
        "This agreement changed while the payment was being made. Nothing was taken.",
      )
    }
    return null
  }

  await db.user.update({ where: { id: debtorId }, data: { leaves: { decrement: amount } } })
  await db.user.update({ where: { id: c.creditorId }, data: { leaves: { increment: amount } } })

  await db.leafTransaction.create({
    data: {
      userId: debtorId,
      type: "CONTRACT_PAY",
      amount: -amount,
      description: `Deferred agreement payment (${amount} Leaves)`,
      contractId: c.id,
      eventAt: paidAt,
    },
  })
  await db.leafTransaction.create({
    data: {
      userId: c.creditorId,
      type: "CONTRACT_COLLECT",
      amount: amount,
      description: `Deferred agreement payment received (${amount} Leaves)`,
      contractId: c.id,
      eventAt: paidAt,
    },
  })

  return { contractId: c.id, creditorId: c.creditorId, amount, fulfilled }
}

/**
 * Thrown by `payContract({ strict: true })` when the conditional write lost.
 *
 * A named class rather than a string so the route can tell it from a genuine
 * database failure and answer 409 instead of 500 — retrying with the same body
 * may well succeed, which is exactly the distinction CONFLICT exists to make.
 */
export class ContractRaceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ContractRaceError"
  }
}

// ── Value arithmetic ─────────────────────────────────────────────────────────

export interface TradeSides {
  senderId: string
  receiverId: string
  offeredLeaves: number | null
  offeredItem: { id: string; valueLeaves: number | null }
  requestedItem: { id: string; valueLeaves: number | null }
}

/**
 * What one party of a trade nets, in Leaves, and therefore the most they could
 * legitimately owe.
 *
 * The sender gives offeredItem plus offeredLeaves and gets requestedItem; the
 * receiver is the mirror. Leaves already moving with the trade are part of the
 * arithmetic — a sender already paying 100 Leaves has 100 less of a gap left to
 * defer, and ignoring that would let the same difference be charged twice.
 *
 * Returns null when either item carries no valueLeaves. A DPA is an agreement
 * about a specific difference; with an unvalued item there is no difference to
 * agree about, and inventing one is worse than refusing.
 */
export function netValueTo(trade: TradeSides, userId: string): number | null {
  const offered = trade.offeredItem.valueLeaves
  const requested = trade.requestedItem.valueLeaves
  if (offered === null || requested === null) return null
  // A leaves-for-item trade stores the listing in BOTH item columns as a
  // placeholder. There is no second item and so no value gap.
  if (trade.offeredItem.id === trade.requestedItem.id) return null

  const leaves = trade.offeredLeaves ?? 0
  if (userId === trade.senderId) return requested - offered - leaves
  if (userId === trade.receiverId) return offered - requested + leaves
  return null
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Term bounds, as dates, for a deadline proposed now. */
export function termBounds(from: Date = new Date()) {
  return {
    earliest: new Date(from.getTime() + DPA.minTermDays * DAY_MS),
    latest: new Date(from.getTime() + DPA.maxTermDays * DAY_MS),
  }
}

/** Extension bounds, as dates, measured from the deadline being extended. */
export function extensionBounds(deadline: Date) {
  return {
    earliest: new Date(deadline.getTime() + DPA.minExtensionDays * DAY_MS),
    latest: new Date(deadline.getTime() + DPA.maxExtensionDays * DAY_MS),
  }
}

// ── What a contract is attached to ───────────────────────────────────────────

/**
 * The sides of a deal, whichever row the contract hangs off.
 *
 * A DPA needs three facts and nothing else: who the two parties are, what each
 * is handing over, and what Leaves are already moving. A TradeRequest carries
 * those directly; an Offer carries them in a different shape — the listing is
 * what the SENDER receives and `offeredItems` is what they give — and the
 * arithmetic is identical once both are reduced to this.
 *
 * `netValueTo()` takes `TradeSides`, so shaping an offer into it is what lets
 * exactly one value calculation serve both attachment points. A second
 * `netValueToFromOffer()` would be the same subtraction written twice, and the
 * two would drift the first time the Leaves term changed.
 */
export interface OfferSides {
  senderId: string
  receiverId: string
  offeredLeaves: number | null
  /** The listing. The sender RECEIVES this — it is the receiver's item. */
  post: { id: string; valueLeaves: number | null }
  /** What the sender puts up. Parsed from `Offer.offeredItems`, values joined. */
  offeredItems: { id: string; valueLeaves: number | null }[]
}

/**
 * An offer, in `TradeSides` terms.
 *
 * MAPPING NOTE, and it is the one thing to get right here. On a TradeRequest,
 * `offeredItem` is the SENDER's and `requestedItem` is what they want. An Offer
 * is the same relationship: `offeredItems` is the sender's side, `post` is what
 * they want. So `offeredItem := offeredItems`, `requestedItem := post`, and the
 * sender/receiver ids carry over unchanged — `netValueTo()`'s sender branch
 * then computes `requested − offered − leaves`, which is exactly the gap the
 * offer screen draws.
 *
 * MULTIPLE OFFERED ITEMS ARE SUMMED, and an unvalued one poisons the sum to
 * null rather than counting as zero. That is the same rule `netValueTo()`
 * already applies to a single unvalued item, and for the same reason: a DPA is
 * an agreement about a specific difference, and with an unvalued item there is
 * no difference to agree about.
 *
 * `id` on the synthesised offered item matters: `netValueTo()` returns null
 * when both ids match, which is how it detects the leaves-for-item placeholder.
 * A Leaves-only offer has an empty `offeredItems`, so it is given the post's own
 * id and correctly reports no item difference.
 */
export function offerAsTradeSides(offer: OfferSides): TradeSides {
  const values = offer.offeredItems.map((i) => i.valueLeaves)
  const anyUnvalued = values.some((v) => v === null)
  const total = anyUnvalued ? null : values.reduce<number>((n, v) => n + (v ?? 0), 0)

  return {
    senderId: offer.senderId,
    receiverId: offer.receiverId,
    offeredLeaves: offer.offeredLeaves,
    offeredItem: {
      // Empty means a Leaves-only offer: no second item, so the same id on both
      // sides, which is the signal netValueTo() already reads as "no gap".
      id: offer.offeredItems[0]?.id ?? offer.post.id,
      valueLeaves: offer.offeredItems.length === 0 ? null : total,
    },
    requestedItem: { id: offer.post.id, valueLeaves: offer.post.valueLeaves },
  }
}

/**
 * `Offer.offeredItems` is a JSON string written by a client. Parsed defensively.
 *
 * The same shape `PATCH /api/offers/[id]` already parses on the accept path,
 * lifted here so both read it identically: anything that is not an object with
 * a non-empty string `id` is dropped, and a malformed blob yields `[]` rather
 * than throwing. A Leaves-only offer legitimately has none.
 */
export function parseOfferedItemIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((x): x is { id?: unknown } => !!x && typeof x === "object")
      .map((x) => x.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
  } catch {
    return []
  }
}

/**
 * Which row a contract hangs off, as a checked union.
 *
 * THROWS on a row with neither, and that is deliberate. "Exactly one at
 * creation, at least one always" is a CHECK constraint the schema cannot carry
 * (Prisma cannot express one, and MariaDB 10.4 would not receive it through a
 * generated migration), so it is enforced here and at both creation sites. A
 * contract attached to nothing is not a state to render defensively around —
 * it is a bug, and it should surface as one rather than as a screen quietly
 * missing its trade block.
 */
export type ContractSubject =
  | { kind: "trade"; tradeId: string }
  | { kind: "offer"; offerId: string }

export function contractSubject(row: {
  id: string
  tradeId: string | null
  offerId: string | null
}): ContractSubject {
  // The trade wins when both are set, which is the state an offer-born contract
  // reaches once its offer is accepted. At that point the trade is the live
  // object — it is what settles, what the deadline sweep is about, and what the
  // creditor is looking at — and the offer is provenance.
  if (row.tradeId) return { kind: "trade", tradeId: row.tradeId }
  if (row.offerId) return { kind: "offer", offerId: row.offerId }
  throw new Error(`DeferredContract ${row.id} is attached to neither a trade nor an offer`)
}

/**
 * A stale proposal is not a debt, and this is what stops it behaving like one.
 *
 * ── THE HAZARD THIS CLOSES ──────────────────────────────────────────────────
 *
 * PENDING_ACCEPT is a COMMITTING status: it fills the debtor's one contract
 * slot and counts against their tier ceiling. Nothing expired it. A creditor
 * who simply never answered therefore locked the debtor out of proposing
 * anything, to anyone, permanently — the deadline sweep only touches ACTIVE
 * rows, so the proposal sat there forever.
 *
 * That was already true for trade-borne proposals and was survivable, because a
 * proposal needed an accepted trade and both parties were already talking.
 * Offers are the opposite: they are sent to strangers who may never reply, and
 * an offer that expires on its own would otherwise leave its contract behind.
 *
 * So a PENDING_ACCEPT proposal lapses on its own deadline, exactly like an
 * ACTIVE one — but to DECLINED, never to DEFAULTED. Nobody broke a promise
 * here; a promise was made, nobody answered, and it stopped being on the table.
 * `defaultedAt` is NOT stamped, so this costs the debtor no tier and no record.
 */
export async function expireStaleProposals(
  db: ContractDb,
  scope: { debtorId?: string; contractId?: string } = {},
): Promise<number> {
  const now = new Date()
  const stale = await db.deferredContract.findMany({
    where: {
      status: "PENDING_ACCEPT",
      deadline: { lt: now },
      ...(scope.debtorId ? { debtorId: scope.debtorId } : {}),
      ...(scope.contractId ? { id: scope.contractId } : {}),
    },
    select: { id: true },
  })
  if (stale.length === 0) return 0

  let expired = 0
  for (const { id } of stale) {
    const res = await db.deferredContract.updateMany({
      where: { id, status: "PENDING_ACCEPT" },
      data: { status: "DECLINED" },
    })
    expired += res.count
  }
  return expired
}
