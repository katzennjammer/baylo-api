"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import toast from "react-hot-toast"

/**
 * Approve, or reject with a reason from the list.
 *
 * ── WHY THIS ONE DOES NOT DEMAND A TYPED REASON ─────────────────────────────
 *
 * ModerationActions next door disables every button until a reason is typed,
 * because for a takedown or a suspension only prose can say which listing and
 * why. Here the vocabulary IS the reason: "photo too blurry to read" is the
 * complete account of the decision, it is exactly what the submitter is told,
 * and a free-text box would let a tired reviewer type "no" at 1am and burn one
 * of the three attempts a real person gets. The note is optional and appended.
 *
 * ── WHAT APPROVE DOES DEMAND ────────────────────────────────────────────────
 *
 * The number, read off the photo. The server hashes it and checks it against
 * the digest the submitter produced; that check is what ties the one-ID-one-
 * account constraint to a document a human looked at rather than to a string
 * somebody typed. Nothing is stored — not here, not there. A mismatch comes
 * back as a 409 saying so, which is a rejection, not a retry.
 *
 * The confirm step on reject is a `window.confirm` and stays one: a rejection
 * costs somebody a third of their attempts, and the misclick this guards
 * against is real — the two buttons are next to each other by necessity.
 *
 * ── THE REASON LIST ARRIVES AS A PROP, AND HAS TO ───────────────────────────
 *
 * It would read better imported straight from @/lib/id-verification, and that
 * does not build: this is a "use client" module, and that library imports
 * `crypto` and `@/lib/prisma` to do the hashing and the gate. Importing it here
 * pulls both into the browser bundle, which fails the production build with a
 * chunking error about external modules — dev never notices, because dev does
 * not chunk the same way.
 *
 * So the server page, which may import it freely, reads the list and passes it
 * down. There is still exactly one definition of the vocabulary; it just
 * crosses the boundary as data instead of as an import.
 */

interface Props {
  submissionId: string
  accountName: string
  /** The closed rejection list, read server-side from @/lib/id-verification. */
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

export default function IdDecisionActions({ submissionId, accountName, reasons }: Props) {
  const router = useRouter()
  const [idNumber, setIdNumber] = useState("")
  const [reason, setReason] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)

  async function decide(body: Record<string, unknown>, okMsg: string) {
    setBusy(true)
    try {
      const res = await fetch(`/api/admin/id-verification/${submissionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const payload = await res.json()
      if (res.ok) {
        toast.success(okMsg)
        router.push("/admin/id-verification")
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
          Either decision destroys the photo and writes an audit row naming you. The submitter is
          notified.
        </p>
      </div>

      {/* ── Approve ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <label style={{ fontSize: 13, fontWeight: 700 }}>
          Type the number you can read on the ID
        </label>
        <input
          value={idNumber}
          onChange={(e) => setIdNumber(e.target.value)}
          placeholder="e.g. 1234-5678-9012"
          autoComplete="off"
          spellCheck={false}
          style={input}
        />
        <p style={{ fontSize: 12, color: "#888" }}>
          Checked against what {accountName} submitted. We never stored their number, only its
          digest — this is how the two get compared. Spaces and dashes do not matter.
        </p>
        <button
          type="button"
          style={{ ...solid, opacity: idNumber.trim() && !busy ? 1 : 0.5 }}
          disabled={busy || !idNumber.trim()}
          onClick={() =>
            decide(
              { action: "approve", idNumber: idNumber.trim(), ...(note.trim() ? { note: note.trim() } : {}) },
              "Approved. They can post now.",
            )
          }
        >
          Approve
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
          value={reason}
          onChange={(e) => setReason(e.target.value)}
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
          This is what they read, with a sentence telling them how to fix it. Pick the one that is
          actually true — a wrong reason sends them off to correct something that was fine, and
          they only get three tries.
        </p>
        <button
          type="button"
          style={{ ...danger, opacity: reason && !busy ? 1 : 0.5 }}
          disabled={busy || !reason}
          onClick={() => {
            if (
              !window.confirm(
                `Reject ${accountName}'s ID as "${reasons.find((r) => r.value === reason)?.label ?? reason}"? This uses one of their three attempts.`,
              )
            ) {
              return
            }
            decide(
              { action: "reject", reason, ...(note.trim() ? { note: note.trim() } : {}) },
              "Rejected. They have been told why.",
            )
          }}
        >
          Reject
        </button>
      </div>

      {/* ── The optional note, shared by both ── */}
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
          Note for the audit log <span style={{ color: "#999", fontWeight: 500 }}>(optional)</span>
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={1000}
          placeholder="Anything the next person reading this log would want to know."
          style={{ ...input, minHeight: 64, resize: "vertical" }}
        />
        <p style={{ fontSize: 12, color: "#888" }}>
          Goes in the audit row, not to the user.
        </p>
      </div>
    </div>
  )
}
