"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import toast from "react-hot-toast"

/**
 * Verify, or reject with a reason from the list.
 *
 * The sibling of IdDecisionActions, with two differences that follow from what
 * the two reviews actually decide.
 *
 * ── THERE IS NO NUMBER TO TYPE ──────────────────────────────────────────────
 *
 * Approving an ID demands the reviewer type the number off the photo, because
 * that is how the one-ID-one-account claim gets tied to a document a human
 * looked at. A business document carries no equivalent claim — there is no
 * uniqueness constraint on a DTI number here and no digest to check against —
 * so demanding a transcription would be ceremony that verifies nothing. What
 * the reviewer is checking is that the document is real, current, and names
 * this organisation, and the buttons say so.
 *
 * ── BOTH DECISIONS DEMAND A TYPED REASON ────────────────────────────────────
 *
 * IdDecisionActions makes the reason optional on approve, because the ID
 * vocabulary IS the reason. Here AdminAction.reason is required by the API on
 * both paths, so both buttons stay disabled until something is typed. That is
 * the stricter shape and it is the right one for a decision with no attempt
 * cap: nothing here forces a reviewer to slow down except this box.
 *
 * ── AND NO window.confirm ON REJECT ─────────────────────────────────────────
 *
 * The ID reject confirms because it burns one of three attempts. This one does
 * not: the organisation keeps trading, and may fix the photo and reapply as
 * often as it likes. A confirm dialog whose warning is "nothing much happens"
 * trains people to dismiss confirm dialogs.
 *
 * The reason list arrives as a PROP rather than as an import, for the reason
 * IdDecisionActions records at length: this is a "use client" module and the
 * route it would import from pulls prisma into the browser bundle.
 */

interface Props {
  organizationId: string
  organizationName: string
  /** The closed rejection list, read server-side. */
  reasons: { value: string; label: string }[]
}

const btn: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: 9,
  fontSize: 13,
  fontWeight: 700,
  border: "1px solid rgba(0,0,0,.14)",
  background: "#fff",
  color: "#333",
  cursor: "pointer",
}
const solid: React.CSSProperties = { ...btn, background: "#4CAF50", color: "#1A3520", border: 0 }
const danger: React.CSSProperties = { ...btn, background: "#e5484d", color: "#fff", border: 0 }

const input: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  fontSize: 13,
  border: "1.5px solid rgba(0,0,0,.15)",
  background: "#fff",
  color: "#111",
  width: "100%",
  fontFamily: "inherit",
}

export default function OrgDecisionActions({
  organizationId,
  organizationName,
  reasons,
}: Props) {
  const router = useRouter()
  const [reason, setReason] = useState("")
  const [rejectionReason, setRejectionReason] = useState("")
  const [busy, setBusy] = useState(false)

  async function decide(body: Record<string, unknown>, okMsg: string) {
    setBusy(true)
    try {
      const res = await fetch(`/api/admin/organizations/${organizationId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const payload = await res.json()
      if (res.ok) {
        toast.success(okMsg)
        router.push("/admin/organizations")
        router.refresh()
      } else {
        // The v1 envelope: { data, error: { code, message }, meta }.
        toast.error(payload?.error?.message ?? "That did not work.")
      }
    } catch {
      toast.error("That did not work.")
    } finally {
      setBusy(false)
    }
  }

  const canAct = reason.trim().length >= 3 && !busy

  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 14,
        border: "1px solid rgba(0,0,0,.08)",
        padding: 20,
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <div>
        <p style={{ fontSize: 15, fontWeight: 800 }}>Decide</p>
        <p style={{ fontSize: 12, color: "#888", marginTop: 3 }}>
          Either decision destroys the document and writes an audit row naming you. Every active
          owner is notified. {organizationName} keeps trading either way.
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <label style={{ fontSize: 13, fontWeight: 700 }}>Your note for the audit row</label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="What you checked and what you concluded."
          style={{ ...input, resize: "vertical" }}
        />
        <p style={{ fontSize: 12, color: "#888" }}>
          Goes to the audit log, not to the applicant — they read the reason below. Required on
          both decisions: this row is the only durable record, because the document is destroyed
          by the same transaction that writes it.
        </p>
      </div>

      {/* ── Verify ── */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          borderTop: "1px solid rgba(0,0,0,.07)",
          paddingTop: 16,
        }}
      >
        <label style={{ fontSize: 13, fontWeight: 700 }}>
          The document is real, current, and names this organisation
        </label>
        <button
          type="button"
          style={{ ...solid, opacity: canAct ? 1 : 0.5 }}
          disabled={!canAct}
          onClick={() =>
            decide({ decision: "verify", reason: reason.trim() }, "Verified. The badge is live.")
          }
        >
          Verify {organizationName}
        </button>
      </div>

      {/* ── Reject ── */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          borderTop: "1px solid rgba(0,0,0,.07)",
          paddingTop: 16,
        }}
      >
        <label style={{ fontSize: 13, fontWeight: 700 }}>Or reject, with a reason</label>
        <select
          value={rejectionReason}
          onChange={(e) => setRejectionReason(e.target.value)}
          style={{ ...input, cursor: "pointer" }}
        >
          <option value="">Pick a reason…</option>
          {reasons.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <p style={{ fontSize: 12, color: "#888" }}>
          This is what the owners read, with a sentence telling them how to fix it. There is no
          attempt cap — they can correct the document and apply again.
        </p>
        <button
          type="button"
          style={{ ...danger, opacity: canAct && rejectionReason ? 1 : 0.5 }}
          disabled={!canAct || !rejectionReason}
          onClick={() =>
            decide(
              { decision: "reject", reason: reason.trim(), rejectionReason },
              "Rejected. They keep trading without the badge.",
            )
          }
        >
          Reject
        </button>
      </div>
    </div>
  )
}
