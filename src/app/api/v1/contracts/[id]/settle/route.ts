import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import {
  ContractRaceError,
  OWING_STATUSES,
  payContract,
  sweepLapsedContracts,
} from "@/lib/contracts"
import { enforceRateLimit } from "@/lib/rate-limit-config"
import { ok, unauthenticated, notFound, conflict, invalid } from "@/lib/v1/envelope"
import { parseJsonBody } from "@/lib/v1/body"
import {
  V1_CONTRACT_SELECT,
  V1_CONTRACT_PARTIES_SELECT,
  v1Contract,
  type V1ContractRow,
} from "@/lib/v1/contract"

export const dynamic = "force-dynamic"

/**
 * POST /api/v1/contracts/[id]/settle — the debtor pays, deliberately.
 *
 * ══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
 *
 * Until now a contract could only be paid down PASSIVELY, by
 * `applyEarningsToContracts()`, which runs whenever the debtor is credited and
 * puts whatever arrived against the oldest debt first. That rule is not going
 * anywhere — earned Leaves go to the debt before they go anywhere else, and the
 * debtor does not get to opt out of it — but it left a debtor with a balance and
 * an intention no way to act on either. The Settle button in the design had
 * nothing behind it, and a person who wanted to clear a debt today had to wait
 * until they happened to earn.
 *
 * ══ WHAT IS DIFFERENT FROM THE PASSIVE PATH, AND WHAT IS NOT ════════════════
 *
 * DIFFERENT: the debtor names the contract and the amount, and may pay part.
 * IDENTICAL: everything after that. Both go through `payContract()` — the same
 * conditional status write, the same two balance moves, the same CONTRACT_PAY /
 * CONTRACT_COLLECT ledger pair — so there is exactly one place in the codebase
 * where Leaves move for a debt, and
 *
 *     SUM(User.leaves) == SUM(LeafTransaction.amount)
 *
 * holds across this route for the same reason it already held across the other.
 *
 * ══ SIX REFUSALS, IN THE ORDER A REQUEST IS MOST LIKELY TO BE WRONG ═════════
 *
 *   404  no such contract, or the caller is not its DEBTOR
 *   409  the contract is not in an owing status
 *   400  the amount is above what is still unpaid
 *   400  the amount is above the debtor's balance
 *   409  the contract changed under the request (a concurrent payment)
 *   429  too many settlement attempts
 *
 * ONLY THE DEBTOR. A creditor cannot call this, and 404 rather than 403 is the
 * deliberate line the rest of v1 takes: a 403 would confirm the row exists.
 * There is no "collect" direction here and there is not going to be — you cannot
 * make someone pay, which is the same rule the Promises screen draws when it
 * gives creditor rows no controls.
 *
 * ══ THE BALANCE IS `user.leaves`, NOT `availableLeaves()` ═══════════════════
 *
 * The same call `applyEarningsToContracts()` makes, and for the reason written
 * out there: contract debt outranks Leaves pledged to pending offers. Netting
 * off open offers here would let a debtor park their whole balance in offers and
 * never be able to pay. An offer left short by a settlement fails its own
 * re-check when the receiver accepts — a path that already exists and already
 * answers a clear 400.
 *
 * ══ A DEFAULTED CONTRACT CAN BE SETTLED ════════════════════════════════════
 *
 * `OWING_STATUSES` is ACTIVE and DEFAULTED, and DEFAULTED is in it on purpose.
 * That is what makes the debt survive the default, and it is also the way out of
 * the trading restriction: pay it off, the contract reaches FULFILLED, the
 * restriction lifts. `defaultedAt` is never cleared — the default stays on the
 * record permanently — so settling late repairs the standing without erasing the
 * history. §10.4's `1, settled late` is exactly that pair of facts.
 *
 * ══ NOTHING CONGRATULATES ═══════════════════════════════════════════════════
 *
 * The response is the updated contract and the debtor's new balance. No award,
 * no bonus, no notification to the creditor beyond what the ledger already
 * records. Paying a debt is not an achievement, and `lifetimeLeaves` is
 * untouched on both sides because moving Leaves between two people is not
 * earning them.
 */

const bodySchema = z.strictObject({
  /**
   * How much to pay, in Leaves. Whole numbers only, at least 1.
   *
   * Omit it to pay the whole remaining balance — which is what a `Settle` button
   * with no amount picker means, and it is safer than making the client compute
   * the remainder and send it: the remainder can move between the read that
   * produced the screen and the write, and a client-computed figure would then
   * be either short or a refusal.
   */
  amountLeaves: z.number().int().min(1).max(1_000_000).optional(),
})

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const viewerId = session.user.id
  const { id } = await params

  // Money moves here, so the brake goes on before anything is read. Keyed on
  // the user rather than the IP: the thing being bounded is one account's write
  // rate against its own balance, not traffic from an address.
  const limited = enforceRateLimit("contractSettle", viewerId)
  if (limited) return limited

  const parsed = await parseJsonBody(req, bodySchema)
  if (!parsed.ok) return parsed.response

  // Sweep first. A contract whose deadline lapsed before the debtor got round to
  // paying is DEFAULTED, and they are entitled to know that is what they just
  // paid — the row this route returns has to be the truth, not a stale ACTIVE.
  await sweepLapsedContracts(prisma, { contractId: id })

  const contract = await prisma.deferredContract.findUnique({
    where: { id },
    select: {
      id: true,
      debtorId: true,
      creditorId: true,
      amountLeaves: true,
      amountPaidLeaves: true,
      status: true,
    },
  })

  // 404 for both "absent" and "not yours", and for a creditor calling it. A 403
  // would confirm the row exists, which is a disclosure in itself.
  if (!contract) return notFound("Contract not found")
  if (contract.debtorId !== viewerId) return notFound("Contract not found")

  if (!OWING_STATUSES.includes(contract.status as (typeof OWING_STATUSES)[number])) {
    return conflict(
      contract.status === "FULFILLED"
        ? "This agreement is already settled."
        : contract.status === "PENDING_ACCEPT"
          ? "This agreement has not been accepted yet, so there is nothing owed on it."
          : `Only a live agreement can be settled (this one is ${contract.status}).`,
      { rule: "CONTRACT_NOT_OWING", status: contract.status },
    )
  }

  const outstanding = Math.max(0, contract.amountLeaves - contract.amountPaidLeaves)
  if (outstanding === 0) {
    return conflict("There is nothing left owing on this agreement.", {
      rule: "CONTRACT_NOT_OWING",
    })
  }

  const requested = parsed.data.amountLeaves ?? outstanding
  if (requested > outstanding) {
    return invalid(
      `That is more than is owed. ${outstanding} ${outstanding === 1 ? "Leaf" : "Leaves"} ` +
        `remain on this agreement.`,
      { outstanding },
    )
  }

  /*
   * ── THE WHOLE PAYMENT, IN ONE TRANSACTION ─────────────────────────────────
   *
   * The balance is read INSIDE it, not above it. A figure read before the
   * transaction opened can be stale by exactly the amount that matters — a
   * concurrent settlement, an offer being accepted, a task award landing — and
   * spending against a stale balance is how an account goes negative.
   *
   * `payContract({ strict: true })` throws `ContractRaceError` when its
   * conditional write loses, rather than returning null. On the passive sweep
   * losing that race means "another credit already handled this contract" and is
   * ignored; here it means the debtor asked to pay a specific amount and it did
   * not happen, and answering 200 to that would tell somebody their debt had
   * moved when it had not.
   */
  try {
    const result = await prisma.$transaction(async (tx) => {
      const debtor = await tx.user.findUnique({
        where: { id: viewerId },
        select: { leaves: true },
      })
      const balance = debtor?.leaves ?? 0

      if (balance < requested) {
        // Thrown rather than returned so the transaction rolls back cleanly and
        // there is one exit path for every refusal below this line.
        throw new InsufficientLeavesError(balance, requested)
      }

      const payment = await payContract(tx, {
        contract,
        debtorId: viewerId,
        amount: requested,
        strict: true,
      })

      const row = await tx.deferredContract.findUnique({
        where: { id },
        select: { ...V1_CONTRACT_SELECT, ...V1_CONTRACT_PARTIES_SELECT },
      })

      return {
        payment,
        row,
        // Read after the writes, so the client is told the balance it actually
        // has rather than the one it had a moment ago. The Trades screen shows
        // this number and a stale one there is a spend ceiling that lies.
        balance: balance - requested,
      }
    })

    return ok({
      contract: result.row ? v1Contract(result.row as V1ContractRow, viewerId) : null,
      payment: {
        amountLeaves: requested,
        /** True when this payment closed the agreement. Not a celebration. */
        fulfilled: result.payment?.fulfilled ?? false,
        remainingLeaves: Math.max(0, outstanding - requested),
      },
      viewer: { leaves: result.balance },
    })
  } catch (err) {
    if (err instanceof InsufficientLeavesError) {
      return invalid(
        `You have ${err.balance} ${err.balance === 1 ? "Leaf" : "Leaves"}, and this ` +
          `payment needs ${err.requested}.`,
        { rule: "INSUFFICIENT_LEAVES", balance: err.balance, requested: err.requested },
      )
    }
    if (err instanceof ContractRaceError) {
      return conflict(err.message, { rule: "CONTRACT_CHANGED" })
    }
    throw err
  }
}

/**
 * The debtor cannot cover the amount they asked to pay.
 *
 * Carries both figures so the message can name them — "you have 130 Leaves, and
 * this payment needs 180" is actionable where "insufficient balance" is not, and
 * the numbers are read inside the transaction so they are the real ones.
 */
class InsufficientLeavesError extends Error {
  constructor(
    readonly balance: number,
    readonly requested: number,
  ) {
    super("Insufficient Leaves")
    this.name = "InsufficientLeavesError"
  }
}
