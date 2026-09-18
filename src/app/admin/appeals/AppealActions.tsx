"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

/**
 * Uphold or overturn one appeal.
 *
 * ── SAME REVIEWER: A WARNING, THEN A SECOND CLICK ───────────────────────────
 *
 * When the signed-in admin made the decision being appealed, the row says so
 * and the confirm button asks once more before sending. It is not a block: a
 * one-admin deployment would otherwise have an appeals queue nobody could
 * empty. The server records `sameReviewer: true` in the audit row either way,
 * so the log shows that the warning was seen and the decision made anyway.
 *
 * A typed reason is required for both outcomes, like every other admin
 * decision: "upheld" with no reason is exactly the rubber stamp an appeal
 * exists to prevent.
 */
export function AppealActions({ appealId, sameReviewer }: { appealId: string; sameReviewer: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState<null | "uphold" | "overturn">(null)
  const [reason, setReason] = useState("")
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (sameReviewer && !armed) {
      setArmed(true)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/appeals/${appealId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: open, reason: reason.trim() }),
      })
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
        setError(payload?.error?.message ?? `Failed (${res.status})`)
        return
      }
      setOpen(null)
      setReason("")
      setArmed(false)
      router.refresh()
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
  const color = open === "overturn" ? "#15803d" : "#7c2d12"
  const canSubmit = reason.trim().length > 0

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 240 }}>
      {sameReviewer ? (
        <div style={{ fontSize: 12, color: "#92400e", background: "#fef3c7", border: "1px solid #fcd34d", borderRadius: 7, padding: "6px 8px" }}>
          You made the decision being appealed. Prefer a colleague; if you decide it anyway, the audit row records that.
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          type="button"
          style={{ ...btn, borderColor: "#7c2d12", color: "#7c2d12", opacity: open === "overturn" ? 0.5 : 1 }}
          disabled={busy}
          onClick={() => { setOpen(open === "uphold" ? null : "uphold"); setArmed(false); setError(null) }}
        >
          Uphold
        </button>
        <button
          type="button"
          style={{ ...btn, borderColor: "#15803d", color: "#15803d", opacity: open === "uphold" ? 0.5 : 1 }}
          disabled={busy}
          onClick={() => { setOpen(open === "overturn" ? null : "overturn"); setArmed(false); setError(null) }}
        >
          Overturn
        </button>
      </div>
      {open ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <input
            value={reason}
            onChange={(e) => { setReason(e.target.value); setArmed(false) }}
            placeholder={open === "uphold" ? "Why the decision stands (audit log)" : "Why the decision was wrong (audit log)"}
            maxLength={1000}
            disabled={busy}
            autoFocus
            style={{ padding: "7px 9px", borderRadius: 7, border: "1px solid rgba(0,0,0,.16)", fontSize: 12, width: "100%" }}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              onClick={submit}
              disabled={busy || !canSubmit}
              style={{
                flex: 1, padding: "7px 10px", border: 0, borderRadius: 7, background: armed ? "#b45309" : color, color: "#fff",
                fontWeight: 700, fontSize: 12, cursor: busy || !canSubmit ? "not-allowed" : "pointer", opacity: busy || !canSubmit ? 0.55 : 1,
              }}
            >
              {busy
                ? "Saving…"
                : armed
                  ? "Yes, decide my own decision"
                  : open === "uphold"
                    ? "Uphold — stays rejected"
                    : "Overturn — publish as asked"}
            </button>
            <button
              type="button"
              onClick={() => { setOpen(null); setArmed(false) }}
              disabled={busy}
              style={{ padding: "7px 10px", border: "1px solid rgba(0,0,0,.12)", borderRadius: 7, background: "#fff", fontSize: 12, cursor: "pointer" }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {error ? <span style={{ fontSize: 11, color: "#b91c1c" }}>{error}</span> : null}
    </div>
  )
}
