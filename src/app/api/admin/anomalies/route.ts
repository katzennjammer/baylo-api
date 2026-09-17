import { NextRequest } from "next/server"
import { z } from "zod"
import { requireRole } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { bracketOf } from "@/lib/brackets"
import { valueCap } from "@/lib/trade-rules"
import { ok } from "@/lib/v1/envelope"
import { parseQuery } from "@/lib/v1/query"
import { NEW_PARTNER_WINDOW_DAYS } from "@/lib/task-constants"

export const dynamic = "force-dynamic"

/**
 * GET /api/admin/anomalies — the signals this system produces that need a
 * human eye.
 *
 *   1  VALUE REVIEWS. Listings whose owner asked for a value more than one
 *      bracket above the server's own suggestion. The value sets the bracket
 *      and the bracket is what trading is judged on, so this is the one place
 *      a person can move their own reach by typing — which is why it waits for
 *      an admin instead of going live. The row carries BOTH numbers and both
 *      brackets, because the question a reviewer is answering is "is this a
 *      fair correction or a reach grab", and one number cannot answer it.
 *      THIS IS A QUEUE, not a report: each row has an approve and a reject.
 *
 *   2  REPEAT-TRADE-PAIR FLAGS. TaskCompletion rows with task = SAFEZONE_MEETUP
 *      and leaves = 0. awardTask() writes one of those every time two users who
 *      have already traded inside NEW_PARTNER_WINDOW_DAYS trade again: the swap
 *      completes normally and pays nothing, because otherwise two accounts
 *      could pass the same two items back and forth and mint Leaves forever.
 *      (The same pair-and-item guards now cover the trade reward as well, in
 *      @/lib/trade-reward, and they deny silently — a denied reward writes no
 *      row, so this list remains the way a colluding pair becomes visible.)
 *
 * The DPA-defaults section is gone with deferred agreements (16 Sep 2026).
 *
 *      A zero row is not itself misconduct — friends trade repeatedly, and the
 *      faucet guard already did its job. It is a SIGNAL, and it is worth a
 *      human's eye at volume: one pair with eleven zero-award swaps in a
 *      fortnight is the shape of two accounts run by one person, and nothing
 *      else in this system would ever mention it.
 *
 * The repeat-pair half is READ-ONLY: a zero-award swap is a signal, not
 * misconduct, and a moderator who wants to act does it through the report
 * queue or the user route, where the audit row gets written. The value-review
 * half is a queue and is acted on through POST /api/admin/listings/[id].
 */

const querySchema = z.strictObject({
  /** Minimum zero-award swaps before a pair is worth listing. */
  minRepeats: z.coerce.number().int().min(2).max(100).optional().default(3),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
})

/** One row of the repeat-pair query. */
interface PairRow {
  userId: string
  partnerId: string
  zeroSwaps: bigint | number
  lastAt: Date
}

export async function GET(req: NextRequest) {
  const gate = await requireRole("MODERATOR")
  if (gate.response) return gate.response

  const parsed = parseQuery(req, querySchema)
  if (!parsed.ok) return parsed.response
  const { minRepeats, limit } = parsed.data

  // ── 1 ── listings waiting on a value decision.
  //
  // Oldest first, deliberately, unlike every other admin list here: this is a
  // queue somebody is WAITING IN. Their listing is invisible to everyone else
  // until it is answered, so the fair order is the order they arrived.
  const reviews = await prisma.item.findMany({
    where: { status: "PENDING_REVIEW" },
    select: {
      id: true,
      title: true,
      category: true,
      condition: true,
      valueLeaves: true,
      suggestedLeaves: true,
      valuationSource: true,
      createdAt: true,
      updatedAt: true,
      user: { select: { id: true, name: true, email: true, suspendedAt: true } },
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: limit,
  })

  // ── 2 ── repeat pairs.
  //
  // Raw SQL, and for the same reason /messages/conversations is: this is a
  // GROUP BY over a derived pair key with a HAVING on the aggregate, and Prisma
  // has no expression for it. Fully parameterised — minRepeats and limit are
  // integers validated by the schema above and passed as bindings, not
  // interpolated. Identifiers and aliases are quoted because Postgres folds
  // unquoted names to lower case.
  //
  // TaskCompletion.refId is the tradeId for a SAFEZONE_MEETUP, which is what
  // lets the join recover who the partner was: the completion row records that
  // USER got zero, and the trade records who they got zero with. (Rows written
  // before 16 Sep 2026 carry task = VERIFIED_SWAP, which was the repeatable
  // task then; both are counted so the history stays visible.)
  const pairs = await prisma.$queryRaw<PairRow[]>`
    SELECT
      tc."userId" AS "userId",
      CASE WHEN tr."senderId" = tc."userId" THEN tr."receiverId" ELSE tr."senderId" END AS "partnerId",
      COUNT(*)            AS "zeroSwaps",
      MAX(tc."createdAt") AS "lastAt"
    FROM "TaskCompletion" tc
    JOIN "TradeRequest" tr ON tr."id" = tc."refId"
    WHERE tc."task" IN ('SAFEZONE_MEETUP', 'VERIFIED_SWAP')
      AND tc."leaves" = 0
    GROUP BY tc."userId", "partnerId"
    HAVING COUNT(*) >= ${minRepeats}
    ORDER BY "zeroSwaps" DESC, "lastAt" DESC
    LIMIT ${limit}
  `

  // Names for the pairs, in one query rather than one per row.
  const ids = [...new Set(pairs.flatMap((p) => [p.userId, p.partnerId]))]
  const people = ids.length
    ? await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, email: true, suspendedAt: true, createdAt: true },
      })
    : []
  const byId = new Map(people.map((p) => [p.id, p]))

  return ok(
    {
      valueReviews: reviews.map((i) => ({
        itemId: i.id,
        title: i.title,
        category: i.category,
        condition: i.condition,
        // Both numbers and both brackets. The decision is about the DISTANCE
        // between them, and a reviewer should not have to do the lookup.
        requestedLeaves: i.valueLeaves,
        suggestedLeaves: i.suggestedLeaves,
        requestedBracket: i.valueLeaves === null ? null : bracketOf(i.valueLeaves),
        suggestedBracket: i.suggestedLeaves === null ? null : bracketOf(i.suggestedLeaves),
        /** How far above the cap they asked to go. 1 would not be here. */
        bracketsAboveCap:
          i.valueLeaves === null || i.suggestedLeaves === null
            ? null
            : bracketOf(i.valueLeaves) - valueCap(i.suggestedLeaves).maxBracketWithoutReview,
        valuationSource: i.valuationSource,
        owner: i.user,
        submittedAt: i.updatedAt,
        createdAt: i.createdAt,
      })),
      repeatPairs: pairs.map((p) => ({
        user: byId.get(p.userId) ?? { id: p.userId },
        partner: byId.get(p.partnerId) ?? { id: p.partnerId },
        zeroAwardSwaps: Number(p.zeroSwaps),
        lastAt: p.lastAt,
      })),
    },
    {
      applied: { minRepeats, limit },
      explain: {
        dpaDefaults:
          "DeferredContract.defaultedAt is stamped by the deadline sweep and never cleared. stillOwing > 0 means the debt is still live.",
        repeatPairs: `VERIFIED_SWAP completions worth 0 Leaves — the faucet guard refusing a partner already traded with inside ${NEW_PARTNER_WINDOW_DAYS} days. Not misconduct on its own; a signal at volume.`,
      },
    },
  )
}
