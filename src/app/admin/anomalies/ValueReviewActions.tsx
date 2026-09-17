"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

/**
 * Approve or reject one value review.
 *
 * ── A REASON IS TYPED, NOT OPTIONAL ─────────────────────────────────────────
 *
 * Same rule as every other admin action: the reason goes into the AdminAction
 * row, and a decision with no reason behind it is the unaccountable moderation
 * the audit log exists to prevent. The prompt is crude and deliberate — the
 * point is that a decision costs a sentence.
 *
 * ── WHAT EACH BUTTON MEANS, IN THE OWNER'S TERMS ────────────────────────────
 *
 *   Approve   the listing goes live AT THE VALUE THEY ASKED FOR. Approving is
 *             deciding the model was wrong about this item, so the number is
 *             not adjusted on the way through.
 *   Reject    the listing stays hidden. It is NOT republished at the
 *             suggestion, because that would put it on the market at a price
 *             its owner never agreed to. They are told, and they choose: relist
 *             at the suggestion, edit within the cap, or delete.
 */
export function ValueReviewActions({ itemId }: { itemId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState<null | "approve-value" | "reject-value">(null)
  const [error, setError] = useState<string | null>(null)

  async function act(action: "approve-value" | "reject-value") {
    const reason = window.prompt(
      action === "approve-value"
        ? "Why is this value right? (written to the audit log)"
        : "Why is this value not right? (written to the audit log, and the owner is told)",
    )
    if (!reason?.trim()) return

    setBusy(action)
    setError(null)
    try {
      const res = await fetch(`/api/admin/listings/${itemId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, reason: reason.trim() }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
        setError(body?.error?.message ?? `Failed (${res.status})`)
        return
      }
      router.refresh()
    } catch {
      setError("The request did not reach the server.")
    } finally {
      setBusy(null)
    }
  }

  const btn: React.CSSProperties = {
    borderRadius: 8, border: "1px solid rgba(0,0,0,.12)", padding: "6px 10px",
    fontSize: 12, fontWeight: 700, cursor: "pointer", background: "#fff",
  }

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <button
        style={{ ...btn, borderColor: "#15803d", color: "#15803d" }}
        disabled={busy !== null}
        onClick={() => act("approve-value")}
      >
        {busy === "approve-value" ? "…" : "Approve"}
      </button>
      <button
        style={{ ...btn, borderColor: "#b91c1c", color: "#b91c1c" }}
        disabled={busy !== null}
        onClick={() => act("reject-value")}
      >
        {busy === "reject-value" ? "…" : "Reject"}
      </button>
      {error ? <span style={{ fontSize: 11, color: "#b91c1c" }}>{error}</span> : null}
    </div>
  )
}
