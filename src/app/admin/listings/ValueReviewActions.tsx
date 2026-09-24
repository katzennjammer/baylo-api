"use client"

import { useRouter } from "next/navigation"
import { useRef, useState } from "react"
import { VALUE_REJECTION_REASONS, VALUE_REJECTION_NOTE_MAX } from "@/lib/value-rejection"
import { collapseRowThen } from "@/components/admin/rowCollapse"
import { Expandable } from "@/components/admin/Expandable"

/**
 * Approve or reject one value review. Shared by the Review queue and the
 * Listings page, so the two cannot drift: same endpoint, same reason rules,
 * same words.
 *
 * ── A REASON IS REQUIRED, AND WHAT KIND DEPENDS ON THE BUTTON ───────────────
 *
 *   Approve   a typed sentence. The reviewer is deciding the model was wrong
 *             about this item; the audit log wants to know why in their words.
 *
 *   Reject    a CODE from a closed list, plus an optional note. The code is
 *             what the OWNER is shown (see @/lib/value-rejection for why they
 *             are told at all); the note is the moderator's own words and
 *             goes to the audit row only. Two fields because they have two
 *             readers, and a sentence written for the log is not a sentence
 *             written for the person it is about.
 *
 * Inline forms, not window.prompt(): a prompt cannot offer a list, and the
 * list is the point of the reject side.
 *
 * ── WHAT EACH BUTTON MEANS, IN THE OWNER'S TERMS ────────────────────────────
 *
 *   Approve   the listing goes live AT THE VALUE THEY ASKED FOR. Nothing is
 *             re-derived; approving is saying the number is right.
 *   Reject    the listing moves to VALUE_REJECTED -- still visible to nobody
 *             but the owner, no longer in the queue. They are told the code's
 *             sentence and choose: relist at the suggestion, edit within the
 *             cap, delete, or appeal.
 */
export function ValueReviewActions({ itemId }: { itemId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState<null | "approve" | "reject">(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const [reasonCode, setReasonCode] = useState<string>("")
  const [note, setNote] = useState("")
  const submitRef = useRef<HTMLButtonElement>(null)

  async function submit() {
    const body =
      open === "approve"
        ? { action: "approve-value", reason: reason.trim() }
        : { action: "reject-value", reasonCode, ...(note.trim() ? { note: note.trim() } : {}) }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/listings/${itemId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
        setError(payload?.error?.message ?? `Failed (${res.status})`)
        return
      }
      setOpen(null)
      setReason("")
      setReasonCode("")
      setNote("")
      collapseRowThen(submitRef.current, () => router.refresh())
    } catch {
      setError("The request did not reach the server.")
    } finally {
      setBusy(false)
    }
  }

  const btn: React.CSSProperties = {
    borderRadius: 8, border: "1px solid rgba(0,0,0,.12)", padding: "6px 10px",
    fontSize: 12, fontWeight: 700, cursor: "pointer", background: "#fff",
  }
  const field: React.CSSProperties = {
    padding: "7px 9px", borderRadius: 7, border: "1px solid rgba(0,0,0,.16)", fontSize: 12, width: "100%",
  }

  const canSubmit = open === "approve" ? reason.trim().length > 0 : reasonCode.length > 0

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 220 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          className="admin-btn-press"
          style={{ ...btn, borderColor: "#15803d", color: "#15803d", opacity: open === "reject" ? 0.5 : 1 }}
          disabled={busy}
          onClick={() => { setOpen(open === "approve" ? null : "approve"); setError(null) }}
        >
          Approve value
        </button>
        <button
          type="button"
          className="admin-btn-press"
          style={{ ...btn, borderColor: "#b91c1c", color: "#b91c1c", opacity: open === "approve" ? 0.5 : 1 }}
          disabled={busy}
          onClick={() => { setOpen(open === "reject" ? null : "reject"); setError(null) }}
        >
          Reject value
        </button>
      </div>

      <Expandable open={open === "approve"}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this value right? (audit log)"
            maxLength={1000}
            disabled={busy}
            style={field}
            autoFocus
          />
          <ConfirmRow submitRef={submitRef} busy={busy} canSubmit={canSubmit} color="#15803d" label="Publish at requested value" onSubmit={submit} onCancel={() => setOpen(null)} />
        </div>
      </Expandable>

      <Expandable open={open === "reject"}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <select
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value)}
            disabled={busy}
            style={field}
            autoFocus
          >
            <option value="">Reason (the owner sees this)…</option>
            {Object.entries(VALUE_REJECTION_REASONS).map(([code, r]) => (
              <option key={code} value={code}>{r.label}</option>
            ))}
          </select>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note for the audit log (optional, never shown to the owner)"
            maxLength={VALUE_REJECTION_NOTE_MAX}
            disabled={busy}
            style={field}
          />
          <ConfirmRow submitRef={submitRef} busy={busy} canSubmit={canSubmit} color="#b91c1c" label="Reject — owner is told" onSubmit={submit} onCancel={() => setOpen(null)} />
        </div>
      </Expandable>

      {error ? <span style={{ fontSize: 11, color: "#b91c1c" }}>{error}</span> : null}
    </div>
  )
}

function ConfirmRow({
  busy, canSubmit, color, label, onSubmit, onCancel, submitRef,
}: {
  busy: boolean; canSubmit: boolean; color: string; label: string
  onSubmit: () => void; onCancel: () => void; submitRef?: React.RefObject<HTMLButtonElement | null>
}) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      <button
        ref={submitRef}
        type="button"
        onClick={onSubmit}
        disabled={busy || !canSubmit}
        className="admin-btn-press"
        style={{
          flex: 1, padding: "7px 10px", border: 0, borderRadius: 7, background: color, color: "#fff",
          fontWeight: 700, fontSize: 12, cursor: busy || !canSubmit ? "not-allowed" : "pointer",
          opacity: busy || !canSubmit ? 0.55 : 1,
        }}
      >
        {busy ? "Saving…" : label}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="admin-btn-press"
        style={{ padding: "7px 10px", border: "1px solid rgba(0,0,0,.12)", borderRadius: 7, background: "#fff", fontSize: 12, cursor: "pointer" }}
      >
        Cancel
      </button>
    </div>
  )
}
