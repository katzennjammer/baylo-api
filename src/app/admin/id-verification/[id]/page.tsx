import Link from "next/link"
import { notFound } from "next/navigation"
import prisma from "@/lib/prisma"
import {
  ID_TYPE_LABEL,
  MAX_ID_SUBMISSIONS,
  REJECTION_LABEL,
  REJECTION_REASONS,
  toWireIdType,
  toWireRejectionReason,
} from "@/lib/id-verification"
import { SIGNED_URL_TTL_S, signIdImageUrl } from "@/lib/id-verification-image"
import IdDecisionActions from "./IdDecisionActions"

export const dynamic = "force-dynamic"
export const revalidate = 0

/**
 * One submission, and the decision on it.
 *
 * ── WHAT THE REVIEWER IS GIVEN, AND WHY THAT IS ALL ─────────────────────────
 *
 * The photo, the ID type, the account's name and age, and the submission
 * history. Enough to answer the three questions this review actually is:
 *
 *   1  is this a real government ID of an accepted type?
 *   2  is it readable and unexpired?
 *   3  does the name on it match the name on the account?
 *
 * THE SUBMITTED ID NUMBER IS NOT SHOWN, because it was never stored — only its
 * SHA-256 digest was. The spec asked for both "hashed only, never plaintext"
 * and "the detail shows the submitted number", which cannot both hold, and the
 * retention rule won. The comparison still happens, in the direction that needs
 * no storage: the reviewer types the number they can read on the photo, and the
 * server checks it against the digest. See the long note on decisionSchema in
 * /api/admin/id-verification/[id].
 *
 * ── THE IMAGE URL IS MINTED HERE AND EXPIRES ────────────────────────────────
 *
 * The asset is an `authenticated`-type Cloudinary upload, so its plain URL 404s.
 * signIdImageUrl() produces a signed one good for five minutes, on every page
 * load, and it is never written anywhere. A signed URL stored in a column would
 * be a durable credential to a photograph of somebody's passport.
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
  APPROVED: "#15803d",
  REJECTED: "#6b7280",
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 10, fontSize: 13, padding: "5px 0" }}>
      <span style={{ color: "#888", minWidth: 130 }}>{label}</span>
      <span style={{ fontWeight: 600, color: "#222" }}>{value}</span>
    </div>
  )
}

export default async function IdVerificationDetailPage({ params }: Props) {
  const { id } = await params

  const row = await prisma.idVerification.findUnique({
    where: { id },
    select: {
      id: true,
      idType: true,
      status: true,
      rejectionReason: true,
      submittedAt: true,
      reviewedAt: true,
      attemptCount: true,
      imagePublicId: true,
      imageDeletedAt: true,
      imageDeleteFailedAt: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          createdAt: true,
          dateOfBirth: true,
          totalTrades: true,
          suspendedAt: true,
          idVerifiedGrandfatheredAt: true,
          _count: { select: { items: true } },
        },
      },
      reviewedBy: { select: { name: true } },
    },
  })
  if (!row) notFound()

  // Their other submissions, so a reviewer can see a pattern — three near-
  // identical rejections in an hour reads very differently from one retry a
  // week later.
  const history = await prisma.idVerification.findMany({
    where: { userId: row.user.id, id: { not: row.id } },
    select: {
      id: true,
      idType: true,
      status: true,
      rejectionReason: true,
      submittedAt: true,
      attemptCount: true,
    },
    orderBy: { submittedAt: "desc" },
  })

  const accountAgeDays = Math.floor((Date.now() - row.user.createdAt.getTime()) / 86_400_000)
  // Signed only while the row is PENDING. A decided row has had its imageUrl
  // nulled and its asset destroyed; if imagePublicId is still set, that is the
  // retry backlog and the file must not be rendered regardless.
  const imageUrl =
    row.status === "PENDING" && row.imagePublicId ? signIdImageUrl(row.imagePublicId) : null

  return (
    <div>
      <Link href="/admin/id-verification" style={{ fontSize: 13, color: "#4CAF50" }}>
        ← Back to the queue
      </Link>

      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 10 }}>
        <h1 style={{ fontSize: 20, fontWeight: 800 }}>{row.user.name}</h1>
        <span
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: ".04em",
            color: STATUS_COLOR[row.status],
          }}
        >
          {row.status}
        </span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(320px, 1fr) minmax(340px, 420px)",
          gap: 20,
          marginTop: 16,
          alignItems: "start",
        }}
      >
        {/* ── The photo ── */}
        <div style={card}>
          <p style={{ fontSize: 15, fontWeight: 800, marginBottom: 10 }}>The ID</p>

          {imageUrl ? (
            <>
              {/*
                A plain <img>, not next/image. next/image proxies through the
                Next.js optimiser, which would fetch and CACHE this file on our
                own server — a second copy of a government ID, in a cache
                directory, outliving the destroy that is the whole point of the
                feature. It is loaded directly from Cloudinary, once, with a
                signed URL that expires.
              */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl}
                alt="Submitted government ID"
                style={{
                  width: "100%",
                  borderRadius: 10,
                  border: "1px solid rgba(0,0,0,.1)",
                  background: "#f2f2f2",
                }}
              />
              <p style={{ fontSize: 12, color: "#999", marginTop: 8 }}>
                This link expires in {Math.round(SIGNED_URL_TTL_S / 60)} minutes. Reload the page
                for a fresh one. Do not save or forward it.
              </p>
            </>
          ) : (
            <p style={{ fontSize: 13, color: "#888" }}>
              {row.status === "PENDING"
                ? "No image on this submission."
                : row.imageDeletedAt
                  ? `Destroyed on decision, ${row.imageDeletedAt.toLocaleString()}.`
                  : row.imagePublicId
                    ? "Decided, but Cloudinary would not delete the file yet. It is retried on every queue page load."
                    : "Destroyed on decision."}
            </p>
          )}
        </div>

        {/* ── Facts and actions ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={card}>
            <p style={{ fontSize: 15, fontWeight: 800, marginBottom: 8 }}>Submission</p>
            <Field label="ID type" value={ID_TYPE_LABEL[toWireIdType(row.idType)]} />
            <Field
              label="ID number"
              value={
                <span style={{ color: "#888", fontWeight: 500 }}>
                  not stored — read it off the photo
                </span>
              }
            />
            <Field
              label="Attempt"
              value={`${row.attemptCount} of ${MAX_ID_SUBMISSIONS}`}
            />
            <Field label="Submitted" value={row.submittedAt.toLocaleString()} />
            {row.reviewedAt && (
              <Field
                label="Decided"
                value={`${row.reviewedAt.toLocaleString()} by ${row.reviewedBy?.name ?? "—"}`}
              />
            )}
            {row.rejectionReason && (
              <Field
                label="Reason"
                value={REJECTION_LABEL[toWireRejectionReason(row.rejectionReason)]}
              />
            )}
          </div>

          <div style={card}>
            <p style={{ fontSize: 15, fontWeight: 800, marginBottom: 8 }}>The account</p>
            <Field label="Name on account" value={row.user.name} />
            <Field label="Email" value={row.user.email} />
            <Field
              label="Account age"
              value={`${accountAgeDays} day${accountAgeDays === 1 ? "" : "s"}`}
            />
            <Field
              label="Date of birth"
              value={row.user.dateOfBirth ? row.user.dateOfBirth.toISOString().slice(0, 10) : "—"}
            />
            <Field label="Listings" value={row.user._count.items} />
            <Field label="Completed trades" value={row.user.totalTrades} />
            {row.user.suspendedAt && (
              <Field
                label="Suspended"
                value={<span style={{ color: "#b91c1c" }}>yes — since {row.user.suspendedAt.toLocaleDateString()}</span>}
              />
            )}
            {row.user.idVerifiedGrandfatheredAt && (
              <Field
                label="Grandfathered"
                value={`yes, ${row.user.idVerifiedGrandfatheredAt.toLocaleDateString()} — already past the gate`}
              />
            )}
          </div>

          {row.status === "PENDING" && (
            <IdDecisionActions
              submissionId={row.id}
              accountName={row.user.name}
              // Read here, where importing the library is free, and handed
              // across the boundary as data. See the note in the component.
              reasons={REJECTION_REASONS.map((r) => ({ value: r, label: REJECTION_LABEL[r] }))}
            />
          )}
        </div>
      </div>

      {history.length > 0 && (
        <div style={{ ...card, marginTop: 20 }}>
          <p style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>
            Their other submissions
          </p>
          <p style={{ fontSize: 12, color: "#888", marginBottom: 10 }}>
            Three near-identical rejections in an hour reads very differently from one retry a
            week later.
          </p>
          {history.map((h) => (
            <div key={h.id} style={{ display: "flex", gap: 12, fontSize: 13, padding: "6px 0" }}>
              <span style={{ color: STATUS_COLOR[h.status], fontWeight: 700, minWidth: 74 }}>
                {h.status}
              </span>
              <span style={{ minWidth: 60, color: "#888" }}>#{h.attemptCount}</span>
              <span style={{ minWidth: 160 }}>{ID_TYPE_LABEL[toWireIdType(h.idType)]}</span>
              <span style={{ color: "#888" }}>{h.submittedAt.toLocaleDateString()}</span>
              {h.rejectionReason && (
                <span style={{ color: "#888" }}>
                  {REJECTION_LABEL[toWireRejectionReason(h.rejectionReason)]}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
