import Link from "next/link"
import { notFound } from "next/navigation"
import prisma from "@/lib/prisma"
import { ORG_DOC_URL_TTL_S, signOrgDocumentUrl } from "@/lib/org-document"
import {
  ORG_REJECTION_LABEL,
  ORG_REJECTION_REASONS,
} from "@/app/api/admin/organizations/[id]/route"
import { BUSINESS_CATEGORY_LABEL } from "@/app/api/v1/organizations/route"
import OrgDecisionActions from "./OrgDecisionActions"

export const dynamic = "force-dynamic"
export const revalidate = 0

/**
 * One business-document application, and the decision on it.
 *
 * ── WHAT THE REVIEWER IS GIVEN, AND WHY THAT IS ALL ─────────────────────────
 *
 * The document, the organisation's name and category, who owns it, how old the
 * owner's account is, and how many listings the org has already posted. Enough
 * to answer the three questions this review actually is:
 *
 *   1  is this a real DTI/SEC registration or barangay permit?
 *   2  is it readable and current?
 *   3  does the business name on it match the name on Baylo?
 *   4  does the registration number on it match the one the applicant typed?
 *
 * The typed DTI number sits DIRECTLY ABOVE the document, not in the side card,
 * because question 4 is a character-by-character comparison and the reviewer
 * should not have to move their eyes across the page to make it. It is never
 * checked against any DTI registry; this comparison is the whole check.
 *
 * The listing count is here and is not decoration: an organisation applying for
 * a badge with forty listings already up is a different risk from one applying
 * with none, in both directions, and it is the only signal on this page that
 * comes from behaviour rather than from the document.
 *
 * ── THE DOCUMENT URL IS MINTED HERE AND EXPIRES ─────────────────────────────
 *
 * The asset is an `authenticated`-type Cloudinary upload, so its plain URL
 * 404s. signOrgDocumentUrl() produces a signed one good for five minutes, on
 * every page load, and it is never written anywhere. A signed URL in a column
 * would be a durable credential to a document carrying somebody's home address.
 */

interface Props {
  params: Promise<{ id: string }>
}

const card: React.CSSProperties = {
  background: "#fff",
  borderRadius: 14,
  border: "1px solid rgba(0,0,0,.08)",
  padding: 20,
}

const STATUS_COLOR: Record<string, string> = {
  PENDING: "#b45309",
  VERIFIED: "#15803d",
  REJECTED: "#6b7280",
}

/**
 * Account age in whole days.
 *
 * MODULE LEVEL, not inline in the component, and that is not a style choice:
 * `react-hooks/purity` refuses `Date.now()` during render, and the sibling ID
 * pages trip it today for exactly this calculation. Reading the clock in a
 * helper the render calls is the same clock read, but it keeps the new file
 * clean rather than adding a third instance of an error already in the tree.
 */
function accountAgeDays(createdAt: Date): number {
  return Math.floor((Date.now() - createdAt.getTime()) / 86_400_000)
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 10, fontSize: 13, padding: "5px 0" }}>
      <span style={{ color: "#888", minWidth: 150 }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  )
}

export default async function OrganizationReviewPage({ params }: Props) {
  const { id } = await params

  const org = await prisma.organization.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      logoUrl: true,
      businessCategory: true,
      dtiRegistrationNumber: true,
      verificationStatus: true,
      rejectionReason: true,
      businessDocPublicId: true,
      businessDocUrl: true,
      docDeletedAt: true,
      docDeleteFailedAt: true,
      createdAt: true,
      reviewedAt: true,
      reviewedBy: { select: { name: true } },
      orgUser: { select: { id: true, _count: { select: { items: true } } } },
      members: {
        select: {
          id: true,
          role: true,
          status: true,
          joinedAt: true,
          user: { select: { id: true, name: true, email: true, createdAt: true } },
        },
        orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
      },
    },
  })

  if (!org) notFound()

  const pending = org.verificationStatus === "PENDING"
  const owner = org.members.find((m) => m.role === "OWNER" && m.status === "ACTIVE")?.user
  const ownerAgeDays = owner ? accountAgeDays(owner.createdAt) : null

  // Minted per render, never stored. Null once the document has been destroyed,
  // which is every decided row — and that is the steady state, not an error.
  const documentUrl = org.businessDocPublicId
    ? signOrgDocumentUrl(org.businessDocPublicId)
    : null

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <Link
        href="/admin/organizations"
        style={{ fontSize: 13, color: "#666", textDecoration: "none" }}
      >
        ← Business documents
      </Link>

      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 20, fontWeight: 800 }}>{org.name}</h1>
        <span
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: ".04em",
            color: STATUS_COLOR[org.verificationStatus],
          }}
        >
          {org.verificationStatus}
        </span>
      </div>

      <div style={{ display: "grid", gap: 18, gridTemplateColumns: "minmax(0,1fr) minmax(0,380px)" }}>
        {/* ── The document ── */}
        <div style={card}>
          <p style={{ fontSize: 15, fontWeight: 800, marginBottom: 12 }}>Business document</p>

          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 10,
              flexWrap: "wrap",
              padding: "10px 12px",
              marginBottom: 12,
              borderRadius: 10,
              background: "#f6f6f6",
              border: "1px solid rgba(0,0,0,.08)",
            }}
          >
            <span style={{ fontSize: 12, color: "#666" }}>DTI registration no. (as typed)</span>
            {org.dtiRegistrationNumber ? (
              <span
                style={{
                  fontSize: 16,
                  fontWeight: 800,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  letterSpacing: ".04em",
                }}
              >
                {org.dtiRegistrationNumber}
              </span>
            ) : (
              <span style={{ fontSize: 13, color: "#b45309", fontWeight: 600 }}>
                none on file — applied before the field existed
              </span>
            )}
          </div>

          {documentUrl ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={documentUrl}
                alt={`Business document for ${org.name}`}
                style={{
                  width: "100%",
                  borderRadius: 10,
                  border: "1px solid rgba(0,0,0,.1)",
                  background: "#f6f6f6",
                }}
              />
              <p style={{ fontSize: 12, color: "#888", marginTop: 8 }}>
                This link expires in {Math.round(ORG_DOC_URL_TTL_S / 60)} minutes and is re-minted
                on every page load. Reload if the image stops rendering.
              </p>
            </>
          ) : (
            <p style={{ fontSize: 13, color: "#888" }}>
              {org.docDeletedAt
                ? `Destroyed on ${org.docDeletedAt.toLocaleString()}, as every decision does.`
                : org.docDeleteFailedAt
                  ? "The decision is made, but Cloudinary would not delete the document. The queue page retries this on every load."
                  : "No document on file."}
            </p>
          )}
        </div>

        {/* ── The application ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={card}>
            <p style={{ fontSize: 15, fontWeight: 800, marginBottom: 6 }}>Application</p>
            <Field
              label="Business category"
              value={
                BUSINESS_CATEGORY_LABEL[
                  org.businessCategory as keyof typeof BUSINESS_CATEGORY_LABEL
                ] ?? org.businessCategory
              }
            />
            <Field label="DTI registration no." value={org.dtiRegistrationNumber ?? "—"} />
            <Field label="Applied" value={org.createdAt.toLocaleString()} />
            <Field
              label="Owner"
              value={owner ? `${owner.name} (${owner.email})` : "no active owner"}
            />
            {ownerAgeDays !== null && (
              <Field
                label="Owner's account"
                value={`${ownerAgeDays} day${ownerAgeDays === 1 ? "" : "s"} old`}
              />
            )}
            <Field
              label="Listings already posted"
              value={org.orgUser._count.items}
            />
            <Field
              label="Members"
              value={`${org.members.filter((m) => m.status === "ACTIVE").length} active, ${
                org.members.filter((m) => m.status === "PENDING").length
              } invited`}
            />
            {org.reviewedAt && (
              <>
                <Field label="Decided" value={org.reviewedAt.toLocaleString()} />
                <Field label="Decided by" value={org.reviewedBy?.name ?? "—"} />
                {org.rejectionReason && (
                  <Field
                    label="Reason given"
                    value={
                      ORG_REJECTION_LABEL[
                        org.rejectionReason as keyof typeof ORG_REJECTION_LABEL
                      ] ?? org.rejectionReason
                    }
                  />
                )}
              </>
            )}
          </div>

          {pending ? (
            <OrgDecisionActions
              organizationId={org.id}
              organizationName={org.name}
              reasons={ORG_REJECTION_REASONS.map((r) => ({
                value: r,
                label: ORG_REJECTION_LABEL[r],
              }))}
            />
          ) : (
            <div style={card}>
              <p style={{ fontSize: 13, color: "#888" }}>
                Already decided. A decision is not reversible from here — the document it was made
                against no longer exists, so a second look would be a different review of nothing.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── Staff ── */}
      <div style={card}>
        <p style={{ fontSize: 15, fontWeight: 800, marginBottom: 10 }}>Staff</p>
        {org.members.length === 0 ? (
          <p style={{ fontSize: 13, color: "#888" }}>Nobody. This organisation cannot be acted as.</p>
        ) : (
          org.members.map((m) => (
            <div
              key={m.id}
              style={{
                display: "flex",
                gap: 12,
                alignItems: "center",
                fontSize: 13,
                padding: "6px 0",
                borderTop: "1px solid rgba(0,0,0,.05)",
              }}
            >
              <span style={{ fontWeight: 700, minWidth: 60 }}>{m.role}</span>
              <span style={{ color: m.status === "ACTIVE" ? "#15803d" : "#b45309", minWidth: 70 }}>
                {m.status}
              </span>
              <span style={{ flex: 1 }}>
                {m.user.name}{" "}
                <span style={{ color: "#888" }}>{m.user.email}</span>
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
