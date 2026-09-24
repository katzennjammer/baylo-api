/**
 * THE LEDGER RECONCILIATION, in one place, for every script that checks it.
 *
 * Nine verify scripts, the seed, the backup tool and the migration mover each
 * re-implemented `SUM(User.leaves) == SUM(LeafTransaction.amount)` by hand.
 * That was tolerable while it was one comparison. Bracket trading (16 Sep
 * 2026) made it three, and three copies of three comparisons is how one
 * script ends up checking last month's rule. So:
 *
 *   1  SUM(User.leaves) == SUM(amount)                every row, signed.
 *      Unchanged. Every movement writes its ledger row and its balance change
 *      in one transaction, so this holds at every commit.
 *
 *   2  SUM(User.leaves) + escrow == issuance
 *      Nothing is minted outside the issuance types. `escrow` is the fees held
 *      on live offers and trades -- Leaves on no user's balance, whose only
 *      trace is a negative BRIDGE_FEE_HOLD row not yet matched by a RELEASE
 *      or a PAID. `issuance` is every row that brought Leaves INTO the system
 *      (or, for a reversal, took them back out of it).
 *
 *   3  escrow (from the ledger) == held (from the rows)
 *      The ledger and the offer/trade rows agree about what is in escrow. An
 *      ACCEPTED offer whose trade never got created, a hold released twice, a
 *      fee copied to the trade but not off the offer's status -- each shows
 *      here as the two figures parting.
 *
 * Two entry points, because the callers are two kinds: Prisma-based scripts
 * take `ledgerInvariant(prisma)`; `pg-backup.ts` speaks raw SQL and takes
 * `LEDGER_INVARIANT_SQL`. Both produce the same `LedgerFigures`, and
 * `judge()` is the one place the three comparisons are made.
 */

import type { PrismaClient } from "@/generated/prisma/client"

/** Rows that bring Leaves into the system, or (negative) back out of it. */
export const ISSUANCE_TYPES = [
  "SIGNUP_GRANT",
  "TASK_REWARD",
  "TRADE_REWARD",
  "TRADE_REWARD_REVERSAL",
  "QUEST_REWARD",
  "TIER_DAILY_GRANT",
] as const

/** The fee triple. HOLD is negative; RELEASE and PAID positive; live holds net negative. */
export const ESCROW_TYPES = ["BRIDGE_FEE_HOLD", "BRIDGE_FEE_RELEASE", "BRIDGE_FEE_PAID"] as const

/** Trade statuses whose fee is still in escrow. Mirrors LIVE_TRADE_STATUSES in @/lib/bridge-fee. */
const LIVE_TRADE_STATUSES = ["PENDING", "ACCEPTED", "CONFIRMING"] as const

/**
 * A PENDING offer holds Leaves only when the PROPOSER is the payer -- that is,
 * when the item they offered is the lower of the two. An up-bridge quotes its
 * fee on the offer row but holds nothing until the receiver accepts, so
 * counting every pending fee would claim Leaves nobody has spent. See
 * HELD_ON_OFFER_WHERE in @/lib/bridge-fee, which this mirrors in SQL.
 */
const OFFER_HELD_SQL = `status = 'PENDING' AND "bridgeFeeLeaves" IS NOT NULL
        AND "offeredBracket" IS NOT NULL AND "targetBracket" IS NOT NULL
        AND "offeredBracket" < "targetBracket"`

export interface LedgerFigures {
  userLeaves: number
  ledger: number
  /** -(HOLD + RELEASE + PAID). Leaves in escrow according to the ledger. */
  escrow: number
  /** SUM over ISSUANCE_TYPES. */
  issuance: number
  /** Fees on PENDING offers plus live trades. Leaves in escrow according to the rows. */
  held: number
}

export interface LedgerJudgement extends LedgerFigures {
  balanced: boolean
  minted: boolean
  escrowAgrees: boolean
  ok: boolean
  /** One line per check, for a script's own log. */
  lines: string[]
}

export function judge(f: LedgerFigures): LedgerJudgement {
  const balanced = f.userLeaves === f.ledger
  const minted = f.userLeaves + f.escrow === f.issuance
  const escrowAgrees = f.escrow === f.held
  return {
    ...f,
    balanced,
    minted,
    escrowAgrees,
    ok: balanced && minted && escrowAgrees,
    lines: [
      `SUM(User.leaves)=${f.userLeaves} == SUM(amount)=${f.ledger}  ${balanced ? "holds" : "BROKEN"}`,
      `SUM(User.leaves)+escrow=${f.userLeaves + f.escrow} == issuance=${f.issuance}  ${minted ? "holds" : "BROKEN"}`,
      `escrow(ledger)=${f.escrow} == held(rows)=${f.held}  ${escrowAgrees ? "holds" : "BROKEN"}`,
    ],
  }
}

type Db = Pick<PrismaClient, "user" | "leafTransaction" | "offer" | "tradeRequest">

export async function ledgerFigures(db: Db): Promise<LedgerFigures> {
  const [u, all, esc, iss, offers, trades] = await Promise.all([
    db.user.aggregate({ _sum: { leaves: true } }),
    db.leafTransaction.aggregate({ _sum: { amount: true } }),
    db.leafTransaction.aggregate({ _sum: { amount: true }, where: { type: { in: [...ESCROW_TYPES] } } }),
    db.leafTransaction.aggregate({ _sum: { amount: true }, where: { type: { in: [...ISSUANCE_TYPES] } } }),
    db.offer.findMany({
      where: { status: "PENDING", bridgeFeeLeaves: { not: null } },
      select: { bridgeFeeLeaves: true, offeredBracket: true, targetBracket: true },
    }),
    db.tradeRequest.aggregate({
      _sum: { bridgeFeeLeaves: true },
      where: { status: { in: [...LIVE_TRADE_STATUSES] } },
    }),
  ])
  return {
    userLeaves: u._sum.leaves ?? 0,
    ledger: all._sum.amount ?? 0,
    escrow: -(esc._sum.amount ?? 0),
    issuance: iss._sum.amount ?? 0,
    held:
      offers
        .filter((o) => (o.offeredBracket ?? 0) < (o.targetBracket ?? 0))
        .reduce((n, o) => n + (o.bridgeFeeLeaves ?? 0), 0) +
      (trades._sum.bridgeFeeLeaves ?? 0),
  }
}

/** Figures plus judgement, for a Prisma-based script. */
export async function ledgerInvariant(db: Db): Promise<LedgerJudgement> {
  return judge(await ledgerFigures(db))
}

/**
 * The same five figures as one SQL statement, for a raw `pg` client. `schema`
 * is the schema the tables live in -- "public" live, the drill schema in a
 * restore rehearsal. Column names match `LedgerFigures`; every value comes
 * back as text and the caller `Number()`s it.
 */
export function LEDGER_INVARIANT_SQL(schema = "public"): string {
  const q = (t: string) => `"${schema}"."${t}"`
  const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ")
  return `
    SELECT
      (SELECT COALESCE(SUM(leaves), 0) FROM ${q("User")})::text AS "userLeaves",
      (SELECT COALESCE(SUM(amount), 0) FROM ${q("LeafTransaction")})::text AS "ledger",
      (SELECT -COALESCE(SUM(amount), 0) FROM ${q("LeafTransaction")}
         WHERE type IN (${list(ESCROW_TYPES)}))::text AS "escrow",
      (SELECT COALESCE(SUM(amount), 0) FROM ${q("LeafTransaction")}
         WHERE type IN (${list(ISSUANCE_TYPES)}))::text AS "issuance",
      ((SELECT COALESCE(SUM("bridgeFeeLeaves"), 0) FROM ${q("Offer")} WHERE ${OFFER_HELD_SQL})
       + (SELECT COALESCE(SUM("bridgeFeeLeaves"), 0) FROM ${q("TradeRequest")}
            WHERE status IN (${list(LIVE_TRADE_STATUSES)})))::text AS "held"`
}

export function figuresFromRow(row: Record<string, string>): LedgerFigures {
  return {
    userLeaves: Number(row.userLeaves),
    ledger: Number(row.ledger),
    escrow: Number(row.escrow),
    issuance: Number(row.issuance),
    held: Number(row.held),
  }
}
