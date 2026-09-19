"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import toast from "react-hot-toast"

/**
 * Activate / deactivate one achievement.
 *
 * A reason is required and the submit is disabled until one exists -- the same
 * rule as every other admin action here, because the reason IS the audit row.
 * There is no delete: deactivating stops new grants and hides the badge from
 * the shelf, while the copies people already earned stay on their profiles.
 */
export default function AchievementToggle({
  id,
  isActive,
  earnedCount,
}: {
  id: string
  isActive: boolean
  earnedCount: number
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!reason.trim()) {
      toast.error("A reason is required.")
      return
    }
    setBusy(true)
    try {
      const response = await fetch(`/api/admin/achievements/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !isActive, reason: reason.trim() }),
      })
      const payload = await response.json()
      if (!response.ok) {
        toast.error(payload?.error?.message ?? payload?.error ?? "That did not work.")
        return
      }
      toast.success(isActive ? "Achievement deactivated." : "Achievement reactivated.")
      setReason("")
      setOpen(false)
      router.refresh()
    } catch {
      toast.error("That did not work.")
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{
            padding: "7px 10px", border: "1px solid rgba(0,0,0,.12)", borderRadius: 7,
            background: isActive ? "#fee2e2" : "#e4f2e8",
            color: isActive ? "#991b1b" : "#21643d", fontWeight: 700, fontSize: 12, cursor: "pointer",
          }}
        >
          {isActive ? "Deactivate" : "Reactivate"}
        </button>
        {isActive && earnedCount > 0 ? (
          <span style={{ fontSize: 11, color: "#888" }}>
            {earnedCount} user{earnedCount === 1 ? "" : "s"} keep it
          </span>
        ) : null}
      </div>
    )
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 200 }}>
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason required"
        maxLength={1000}
        disabled={busy}
        style={{ padding: "7px 9px", borderRadius: 7, border: "1px solid rgba(0,0,0,.16)", fontSize: 12 }}
      />
      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          onClick={submit}
          disabled={busy || !reason.trim()}
          style={{
            flex: 1, padding: "7px 10px", border: 0, borderRadius: 7,
            background: isActive ? "#e5484d" : "#4CAF50", color: "#fff",
            fontWeight: 700, fontSize: 12, opacity: busy || !reason.trim() ? 0.55 : 1,
          }}
        >
          {busy ? "Saving…" : isActive ? "Deactivate" : "Reactivate"}
        </button>
        <button type="button" onClick={() => { setOpen(false); setReason("") }} disabled={busy} style={{ padding: "7px 10px", border: "1px solid rgba(0,0,0,.12)", borderRadius: 7, background: "#fff", fontSize: 12, cursor: "pointer" }}>
          Cancel
        </button>
      </div>
    </div>
  )
}
