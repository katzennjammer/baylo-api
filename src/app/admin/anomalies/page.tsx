import prisma from "@/lib/prisma"
import { NEW_PARTNER_WINDOW_DAYS } from "@/lib/task-constants"
import { suspensionState } from "@/lib/moderation"
import { bracketOf } from "@/lib/brackets"
import { valueCap } from "@/lib/trade-rules"
import { ValueReviewActions } from "../listings/ValueReviewActions"

export const dynamic = "force-dynamic"
export const revalidate = 0

/**
 * /admin/review-queue — the signals this system records that need a human eye.
 *
 *   VALUE REVIEWS      Listings whose owner asked for a value more than one
 *                      bracket above the server's own suggestion. The value
 *                      sets the bracket and the bracket is what trading is
 *                      judged on, so this is the one place a person can move
 *                      their own reach by typing. A QUEUE: somebody is waiting,
 *                      their listing is invisible until it is answered, and the
 *                      two buttons are the answer. A rejected listing LEAVES
 *                      this queue (status VALUE_REJECTED, 18 Sep 2026): it is
 *                      waiting for its owner, not for us, and the Listings
 *                      page's "Value rejected" filter is where those live.
 *   REPEAT PAIRS       Repeatable-task completions worth 0 Leaves — the faucet
 *                      guard refusing a partner already traded with inside the
 *                      window. Not misconduct on its own; a signal at volume.
 *
 * THE REPEAT-PAIR HALF HAS NO BUTTON, deliberately. A zero-award swap is a
 * signal, and a moderator who wants to act does it through the report queue or
 * the user route, where an audit row gets written with a reason. The review
 * half writes its own audit row (and notifies the owner), which is what earns
 * it the right to be actioned from here.
 *
 * The deferred-agreement defaults section went with DPAs on 16 Sep 2026.
 */

const MIN_REPEATS = 3

interface PairRow {
  userId: string
  partnerId: string
  zeroSwaps: bigint | number
  lastAt: Date
}

const card: React.CSSProperties = {
  background: "#fff", borderRadius: 14, border: "1px solid rgba(0,0,0,.08)",
  padding: 20, display: "flex", flexDirection: "column", gap: 12,
}
const th: React.CSSProperties = { padding: "10px 12px", textAlign: "left", color: "#888", fontSize: 12 }
const td: React.CSSProperties = { padding: "10px 12px", fontSize: 13 }

export default async function ReviewQueuePage() {
  const [reviews, pairs] = await Promise.all([
    // Oldest first: a queue somebody is waiting in, unlike every other admin
    // list here. Their listing shows to nobody until this is answered.
    prisma.item.findMany({
      where: { status: "PENDING_REVIEW" },
      select: {
        id: true, title: true, category: true, condition: true,
        valueLeaves: true, suggestedLeaves: true, valuationSource: true, updatedAt: true,
        user: { select: { id: true, name: true, email: true, suspendedAt: true, suspendedUntil: true } },
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: 100,
    }),
    // Raw SQL for the same reason /messages/conversations uses it: a GROUP BY
    // over a derived pair key with a HAVING on the aggregate has no Prisma
    // expression. Fully parameterised. Identifiers and aliases are quoted
    // because Postgres folds unquoted names to lower case.
    prisma.$queryRaw<PairRow[]>`
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
      HAVING COUNT(*) >= ${MIN_REPEATS}
      ORDER BY "zeroSwaps" DESC, "lastAt" DESC
      LIMIT 100
    `,
  ])

  const ids = [...new Set(pairs.flatMap((p) => [p.userId, p.partnerId]))]
  const people = ids.length
    ? await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, email: true, createdAt: true },
      })
    : []
  const byId = new Map(people.map((p) => [p.id, p]))

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-.02em" }}>Review queue</h1>
        <p style={{ fontSize: 13, color: "#777", marginTop: 4, maxWidth: "70ch", lineHeight: 1.6 }}>
          Signals the system already records. Neither is misconduct on its own — both are
          worth a human&apos;s eye. Acting on one means opening the relevant report or user,
          so that an audit row gets written with a reason.
        </p>
      </div>

      <div style={card}>
        <div>
          <p style={{ fontSize: 15, fontWeight: 800 }}>Values waiting for review ({reviews.length})</p>
          <p style={{ fontSize: 12, color: "#888", marginTop: 3, lineHeight: 1.55, maxWidth: "80ch" }}>
            The owner asked for more than one bracket above the suggestion. Until this is
            answered the listing shows to nobody but them. <strong>Approve</strong> publishes it
            at the value they asked for; <strong>Reject</strong> moves it out of this queue,
            still hidden, and tells them which reason — they relist at the suggestion, edit
            within the cap, delete it, or appeal. It is never published at a value its owner
            did not choose.
          </p>
        </div>

        {reviews.length === 0 ? (
          <p style={{ fontSize: 13, color: "#999" }}>Nothing waiting.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
              <thead>
                <tr>
                  <th style={th}>Listing</th>
                  <th style={th}>Owner</th>
                  <th style={th}>Suggested</th>
                  <th style={th}>Asked for</th>
                  <th style={th}>Brackets</th>
                  <th style={th}>Waiting since</th>
                  <th style={th}>Decision</th>
                </tr>
              </thead>
              <tbody>
                {reviews.map((i) => {
                  const suggested = i.suggestedLeaves
                  const asked = i.valueLeaves
                  const cap = suggested === null ? null : valueCap(suggested)
                  return (
                    <tr key={i.id} style={{ borderTop: "1px solid rgba(0,0,0,.06)" }}>
                      <td style={td}>
                        {i.title}
                        <div style={{ fontSize: 11, color: "#aaa" }}>
                          {i.category} · {i.condition} · {i.valuationSource ?? "no source"}
                        </div>
                      </td>
                      <td style={td}>
                        {i.user.name}
                        <div style={{ fontSize: 11, color: "#aaa" }}>
                          {i.user.email}
                          {suspensionState(i.user).suspended && " · SUSPENDED"}
                        </div>
                      </td>
                      <td style={td}>{suggested?.toLocaleString() ?? "—"}</td>
                      <td style={{ ...td, fontWeight: 700 }}>{asked?.toLocaleString() ?? "—"}</td>
                      <td style={td}>
                        {suggested !== null && asked !== null ? (
                          <>
                            {bracketOf(suggested)} → <strong>{bracketOf(asked)}</strong>
                            <div style={{ fontSize: 11, color: "#aaa" }}>
                              live without review up to {cap?.maxBracketWithoutReview}
                            </div>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td style={td}>{i.updatedAt.toLocaleDateString()}</td>
                      <td style={td}>
                        <ValueReviewActions itemId={i.id} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={card}>
        <div>
          <p style={{ fontSize: 15, fontWeight: 800 }}>Repeat trade pairs ({pairs.length})</p>
          <p style={{ fontSize: 12, color: "#888", marginTop: 3, lineHeight: 1.55, maxWidth: "80ch" }}>
            Pairs with {MIN_REPEATS} or more completed swaps whose repeatable task awarded{" "}
            <strong>0 Leaves</strong> —
            the faucet guard refusing a partner already traded with inside{" "}
            {NEW_PARTNER_WINDOW_DAYS} days. Friends genuinely do trade repeatedly, so a few
            of these mean nothing. A pair with a dozen is the shape of two accounts run by
            one person, and nothing else in the system would ever mention it.
          </p>
        </div>

        {pairs.length === 0 ? (
          <p style={{ fontSize: 13, color: "#999" }}>
            No pair has hit {MIN_REPEATS} zero-award swaps.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 680 }}>
              <thead>
                <tr>
                  <th style={th}>User</th>
                  <th style={th}>Partner</th>
                  <th style={th}>Zero-award swaps</th>
                  <th style={th}>Most recent</th>
                </tr>
              </thead>
              <tbody>
                {pairs.map((p) => {
                  const u = byId.get(p.userId)
                  const q = byId.get(p.partnerId)
                  return (
                    <tr key={`${p.userId}-${p.partnerId}`} style={{ borderTop: "1px solid rgba(0,0,0,.06)" }}>
                      <td style={td}>
                        {u?.name ?? p.userId}
                        <div style={{ fontSize: 11, color: "#aaa" }}>{u?.email}</div>
                      </td>
                      <td style={td}>
                        {q?.name ?? p.partnerId}
                        <div style={{ fontSize: 11, color: "#aaa" }}>{q?.email}</div>
                      </td>
                      <td style={{ ...td, fontWeight: 700 }}>{Number(p.zeroSwaps)}</td>
                      <td style={td}>{new Date(p.lastAt).toLocaleString()}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
