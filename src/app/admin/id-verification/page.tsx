import Link from "next/link"
import prisma from "@/lib/prisma"
import { ID_TYPE_LABEL, REJECTION_LABEL, toWireIdType, toWireRejectionReason } from "@/lib/id-verification"
import { sweepUndeletedIdImages } from "@/lib/id-verification-image"

export const dynamic = "force-dynamic"
export const revalidate = 0

/**
 * /admin/id-verification — the ID review queue.
 *
 * OLDEST FIRST, and that is the only ordering this page offers. Everywhere else
 * in this admin surface the newest row is at the top, because a moderator
 * scanning reports wants to see what just came in. Here the opposite is true:
 * somebody is waiting, unable to post, and the person who has been waiting
 * longest is the one being let down most. Sorting newest-first would mean a
 * steady trickle of submissions could starve the first person in the queue
 * indefinitely, which is the failure mode of every "latest first" support inbox
 * ever built.
 *
 * Server-rendered straight from Prisma, like /admin. The layout has already
 * established this is staff; a server component fetching its own HTTP API would
 * be a round trip to re-answer a question already answered.
 *
 * THE IMAGE SWEEP RUNS HERE. Not on a cron — there isn't one — and not in the
 * decision route, where a Cloudinary retry would be exactly the blocking call
 * the design removed. It runs on the page load of the person most likely to
 * have just made the decision that failed, in the same spirit as
 * sweepLapsedContracts() on the contracts read path. It never throws.
 */

const STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const

interface Props {
  searchParams: Promise<{ status?: string }>
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 600,
    textDecoration: "none",
    border: `1px solid ${active ? "#4CAF50" : "rgba(0,0,0,.14)"}`,
    background: active ? "rgba(76,175,80,.12)" : "#fff",
    color: active ? "#2e7d32" : "#555",
  }
}

const STATUS_COLOR: Record<string, string> = {
  PENDING: "#b45309",
  APPROVED: "#15803d",
  REJECTED: "#6b7280",
}

function ageOf(d: Date): string {
  const ms = Date.now() - d.getTime()
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))}m`
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export default async function IdVerificationQueuePage({ searchParams }: Props) {
  const sp = await searchParams

  // Unknown values are dropped rather than handed to Prisma as an enum. A
  // hand-edited URL is the normal way this page gets a bad parameter.
  const status = (STATUSES as readonly string[]).includes(sp.status ?? "")
    ? (sp.status as (typeof STATUSES)[number])
    : "PENDING"

  // Best-effort, never fatal, and deliberately awaited rather than fired and
  // forgotten: a floating promise in a server component is a promise the render
  // may outlive.
  const sweep = await sweepUndeletedIdImages()

  const [rows, counts, staleImages] = await Promise.all([
    prisma.idVerification.findMany({
      where: { status },
      select: {
        id: true,
        idType: true,
        status: true,
        rejectionReason: true,
        submittedAt: true,
        reviewedAt: true,
        attemptCount: true,
        imagePublicId: true,
        user: { select: { id: true, name: true, email: true, createdAt: true } },
        reviewedBy: { select: { name: true } },
      },
      // Oldest first for PENDING — see the header. Decided rows read better
      // newest-first, because there you are looking for what just happened.
      orderBy: status === "PENDING" ? { submittedAt: "asc" } : { reviewedAt: "desc" },
      take: 100,
    }),
    prisma.idVerification.groupBy({ by: ["status"], _count: { id: true } }),
    // The retry backlog, surfaced rather than hidden. An ID photo that Cloudinary
    // would not delete is the one failure in this feature that a user cannot see
    // and would care most about, so it goes at the top of the staff page.
    prisma.idVerification.count({
      where: { status: { in: ["APPROVED", "REJECTED"] }, imagePublicId: { not: null } },
    }),
  ])

  const countFor = (s: string) => counts.find((c) => c.status === s)?._count.id ?? 0

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 20, fontWeight: 800 }}>ID verification</h1>
        <span style={{ fontSize: 13, color: "#888" }}>
          {countFor("PENDING")} waiting · oldest first
        </span>
      </div>

      <p style={{ fontSize: 13, color: "#666", marginTop: 6, maxWidth: 760 }}>
        Approving unlocks posting and proposing deferred agreements for that account. Either
        decision destroys the uploaded photo and writes an audit row naming you.
      </p>

      {staleImages > 0 && (
        <div
          style={{
            marginTop: 14,
            padding: "12px 14px",
            borderRadius: 12,
            background: "rgba(229,72,77,.08)",
            border: "1px solid rgba(229,72,77,.3)",
            fontSize: 13,
            color: "#991b1b",
          }}
        >
          <strong>{staleImages} decided submission{staleImages === 1 ? "" : "s"}</strong> still
          have an ID photo on Cloudinary that would not delete. They are retried every time this
          page loads
          {sweep.swept > 0 ? ` — ${sweep.swept} cleared just now.` : "."}
          {sweep.failed > 0 && ` ${sweep.failed} failed again; check the Cloudinary credentials.`}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, margin: "16px 0", flexWrap: "wrap" }}>
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={`/admin/id-verification?status=${s}`}
            style={chipStyle(status === s)}
          >
            {s[0] + s.slice(1).toLowerCase()} ({countFor(s)})
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <p style={{ fontSize: 14, color: "#888", padding: "32px 0" }}>
          {status === "PENDING"
            ? "Nothing waiting. Everyone who has submitted an ID has an answer."
            : "Nothing here."}
        </p>
      ) : (
        <div
          style={{
            background: "#fff",
            borderRadius: 14,
            border: "1px solid rgba(0,0,0,.08)",
            overflow: "hidden",
          }}
        >
          {rows.map((r, i) => {
            const accountAgeDays = Math.floor(
              (Date.now() - r.user.createdAt.getTime()) / 86_400_000,
            )
            return (
              <Link
                key={r.id}
                href={`/admin/id-verification/${r.id}`}
                style={{
                  display: "flex",
                  gap: 14,
                  alignItems: "center",
                  padding: "14px 18px",
                  borderTop: i === 0 ? "none" : "1px solid rgba(0,0,0,.06)",
                  textDecoration: "none",
                  color: "inherit",
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 800,
                    letterSpacing: ".04em",
                    color: STATUS_COLOR[r.status],
                    minWidth: 74,
                  }}
                >
                  {r.status}
                </span>

                <span style={{ fontSize: 14, fontWeight: 700, minWidth: 170 }}>
                  {r.user.name}
                </span>

                <span style={{ fontSize: 13, color: "#555", minWidth: 160 }}>
                  {ID_TYPE_LABEL[toWireIdType(r.idType)]}
                </span>

                <span style={{ fontSize: 12, color: "#888" }}>
                  attempt {r.attemptCount} · account {accountAgeDays}d old
                </span>

                <span style={{ marginLeft: "auto", fontSize: 12, color: "#888" }}>
                  {r.status === "PENDING"
                    ? `waiting ${ageOf(r.submittedAt)}`
                    : r.rejectionReason
                      ? REJECTION_LABEL[toWireRejectionReason(r.rejectionReason)]
                      : `by ${r.reviewedBy?.name ?? "—"}`}
                </span>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
