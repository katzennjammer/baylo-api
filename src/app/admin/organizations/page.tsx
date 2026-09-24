import Link from "next/link"
import prisma from "@/lib/prisma"
import { sweepUndeletedOrgDocuments } from "@/lib/org-document"
import { DocumentQueueTabs } from "../_components/DocumentQueueTabs"
import { BUSINESS_CATEGORY_LABEL } from "@/app/api/v1/organizations/route"

export const dynamic = "force-dynamic"
export const revalidate = 0

/**
 * /admin/organizations — the business-document review queue.
 *
 * The sibling of /admin/id-verification and deliberately the same page: oldest
 * first while PENDING, newest first once decided, the same chips, the same
 * stranded-document banner. Read that file's header for the reasoning — all of
 * it applies, including why the sweep runs on a page load rather than a cron
 * this deployment does not have.
 *
 * ── ONE DIFFERENCE IN THE COPY, AND IT MATTERS ──────────────────────────────
 *
 * The ID queue's subtitle says approving "unlocks posting". This one must not
 * say anything of the kind, because a PENDING organisation is already posting
 * and trading — what the review decides is a badge. A reviewer who believes
 * businesses are blocked while they wait will work this queue with an urgency
 * the situation does not have, and will feel differently about rejecting than
 * they should. The subtitle says what is actually true.
 */

const STATUSES = ["PENDING", "VERIFIED", "REJECTED"] as const

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
  VERIFIED: "#15803d",
  REJECTED: "#6b7280",
}

function ageOf(d: Date): string {
  const ms = Date.now() - d.getTime()
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))}m`
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export default async function OrganizationQueuePage({ searchParams }: Props) {
  const sp = await searchParams

  // Unknown values are dropped rather than handed to Prisma as an enum. A
  // hand-edited URL is the normal way this page gets a bad parameter.
  const status = (STATUSES as readonly string[]).includes(sp.status ?? "")
    ? (sp.status as (typeof STATUSES)[number])
    : "PENDING"

  // Best-effort, never fatal, and awaited rather than fired and forgotten: a
  // floating promise in a server component is one the render may outlive.
  const sweep = await sweepUndeletedOrgDocuments()

  const [rows, counts, staleDocs, idPending] = await Promise.all([
    prisma.organization.findMany({
      where: { verificationStatus: status },
      select: {
        id: true,
        name: true,
        businessCategory: true,
        dtiRegistrationNumber: true,
        verificationStatus: true,
        rejectionReason: true,
        createdAt: true,
        reviewedAt: true,
        businessDocPublicId: true,
        reviewedBy: { select: { name: true } },
        _count: { select: { members: true } },
        members: {
          where: { role: "OWNER", status: "ACTIVE" },
          select: { user: { select: { id: true, name: true, email: true } } },
          take: 1,
        },
      },
      // Oldest first while waiting — somebody is waiting, and newest-first
      // starves the first person in the queue indefinitely.
      orderBy: status === "PENDING" ? { createdAt: "asc" } : { reviewedAt: "desc" },
      take: 100,
    }),
    prisma.organization.groupBy({ by: ["verificationStatus"], _count: { id: true } }),
    // The retry backlog, surfaced rather than hidden. A business document
    // Cloudinary would not delete is the failure nobody outside this page can
    // see and the applicant would care most about.
    prisma.organization.count({
      where: {
        verificationStatus: { in: ["VERIFIED", "REJECTED"] },
        businessDocPublicId: { not: null },
      },
    }),
    prisma.idVerification.count({ where: { status: "PENDING" } }),
  ])

  const countFor = (s: string) =>
    counts.find((c) => c.verificationStatus === s)?._count.id ?? 0

  return (
    <div>
      <DocumentQueueTabs
        active="organization"
        idPending={idPending}
        orgPending={countFor("PENDING")}
      />

      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 20, fontWeight: 800 }}>Business documents</h1>
        <span style={{ fontSize: 13, color: "#888" }}>
          {countFor("PENDING")} waiting · oldest first
        </span>
      </div>

      <p style={{ fontSize: 13, color: "#666", marginTop: 6, maxWidth: 760 }}>
        Verifying puts the checkmark on that organisation&rsquo;s profile.{" "}
        <strong>They can already post and trade either way</strong> — a rejection removes a badge,
        not an account. Either decision destroys the uploaded document and writes an audit row
        naming you.
      </p>

      {staleDocs > 0 && (
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
          <strong>
            {staleDocs} decided application{staleDocs === 1 ? "" : "s"}
          </strong>{" "}
          still have a business document on Cloudinary that would not delete. They are retried
          every time this page loads
          {sweep.swept > 0 ? ` — ${sweep.swept} cleared just now.` : "."}
          {sweep.failed > 0 && ` ${sweep.failed} failed again; check the Cloudinary credentials.`}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, margin: "16px 0", flexWrap: "wrap" }}>
        {STATUSES.map((s) => (
          <Link key={s} href={`/admin/organizations?status=${s}`} style={chipStyle(status === s)}>
            {s[0] + s.slice(1).toLowerCase()} ({countFor(s)})
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <p style={{ fontSize: 14, color: "#888", padding: "32px 0" }}>
          {status === "PENDING"
            ? "Nothing waiting. Every organisation that has applied has an answer."
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
            const owner = r.members[0]?.user
            return (
              <Link
                key={r.id}
                href={`/admin/organizations/${r.id}`}
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
                    color: STATUS_COLOR[r.verificationStatus],
                    minWidth: 74,
                  }}
                >
                  {r.verificationStatus}
                </span>

                <span style={{ flex: "1 1 220px", minWidth: 0 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, display: "block" }}>{r.name}</span>
                  <span style={{ fontSize: 12, color: "#888" }}>
                    {BUSINESS_CATEGORY_LABEL[
                      r.businessCategory as keyof typeof BUSINESS_CATEGORY_LABEL
                    ] ?? r.businessCategory}
                    {owner ? ` · ${owner.name}` : " · no active owner"}
                  </span>
                  <span style={{ fontSize: 12, color: "#555", display: "block" }}>
                    DTI no.{" "}
                    <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontWeight: 700 }}>
                      {r.dtiRegistrationNumber ?? "—"}
                    </span>
                  </span>
                </span>

                <span style={{ fontSize: 12, color: "#888", minWidth: 90 }}>
                  {r._count.members} member{r._count.members === 1 ? "" : "s"}
                </span>

                <span style={{ fontSize: 12, color: "#888", minWidth: 60, textAlign: "right" }}>
                  {ageOf(r.createdAt)}
                </span>

                {r.reviewedBy && (
                  <span style={{ fontSize: 12, color: "#aaa", minWidth: 120, textAlign: "right" }}>
                    by {r.reviewedBy.name}
                  </span>
                )}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
