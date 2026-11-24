"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import toast from "react-hot-toast"
import { Expandable } from "@/components/admin/Expandable"

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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 200 }}>
      {!open ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="admin-btn-press"
            style={{
              padding: "7px 10px", border: "1px solid var(--adm-border-input)", borderRadius: 7,
              background: isActive ? "var(--adm-warn-bg)" : "var(--adm-good-bg)",
              color: isActive ? "var(--adm-warn)" : "var(--adm-good)", fontWeight: 700, fontSize: 12, cursor: "pointer",
            }}
          >
            {isActive ? "Deactivate" : "Reactivate"}
          </button>
          {isActive && earnedCount > 0 ? (
            <span style={{ fontSize: 11, color: "var(--adm-text-muted)" }}>
              {earnedCount} user{earnedCount === 1 ? "" : "s"} keep it
            </span>
          ) : null}
        </div>
      ) : null}
      <Expandable open={open}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason required"
            maxLength={1000}
            disabled={busy}
            autoFocus
            style={{ padding: "7px 9px", borderRadius: 7, border: "1px solid var(--adm-border-control)", fontSize: 12 }}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              onClick={submit}
              disabled={busy || !reason.trim()}
              className="admin-btn-press"
              style={{
                flex: 1, padding: "7px 10px", border: 0, borderRadius: 7,
                background: isActive ? "var(--adm-danger)" : "var(--adm-accent)", color: "var(--adm-text-on-accent)",
                fontWeight: 700, fontSize: 12, opacity: busy || !reason.trim() ? 0.55 : 1,
              }}
            >
              {busy ? "Saving…" : isActive ? "Deactivate" : "Reactivate"}
            </button>
            <button
              type="button"
              onClick={() => { setOpen(false); setReason("") }}
              disabled={busy}
              className="admin-btn-press"
              style={{ padding: "7px 10px", border: "1px solid var(--adm-border-input)", borderRadius: 7, background: "var(--adm-panel)", fontSize: 12, cursor: "pointer" }}
            >
              Cancel
            </button>
          </div>
        </div>
      </Expandable>
    </div>
  )
}
