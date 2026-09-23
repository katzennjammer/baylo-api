"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import toast from "react-hot-toast"
import { collapseRowThen } from "@/components/admin/rowCollapse"

export default function UserActions({
  userId,
  suspended,
  canSuspend,
}: {
  userId: string
  suspended: boolean
  canSuspend: boolean
}) {
  const router = useRouter()
  const [reason, setReason] = useState("")
  const [days, setDays] = useState("")
  const [busy, setBusy] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  async function submit() {
    if (!reason.trim()) {
      toast.error("A reason is required.")
      return
    }
    setBusy(true)
    try {
      const body = suspended
        ? { action: "unsuspend", reason }
        : { action: "suspend", reason, ...(days ? { days: Number(days) } : {}) }
      const response = await fetch(`/api/admin/users/${userId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const payload = await response.json()
      if (!response.ok) {
        toast.error(payload?.error?.message ?? "That action failed.")
        return
      }
      toast.success(suspended ? "Account restored." : "Account suspended.")
      setReason("")
      setDays("")
      collapseRowThen(buttonRef.current, () => router.refresh())
    } catch {
      toast.error("That action failed.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 190 }}>
      <input
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Reason required"
        maxLength={1000}
        disabled={!canSuspend || busy}
        style={{ padding: "7px 9px", borderRadius: 7, border: "1px solid rgba(0,0,0,.16)", fontSize: 12 }}
      />
      {!suspended && (
        <input
          type="number"
          min={1}
          max={3650}
          value={days}
          onChange={(event) => setDays(event.target.value)}
          placeholder="Days; blank = indefinite"
          disabled={!canSuspend || busy}
          style={{ padding: "7px 9px", borderRadius: 7, border: "1px solid rgba(0,0,0,.16)", fontSize: 12 }}
        />
      )}
      <button
        ref={buttonRef}
        type="button"
        onClick={submit}
        disabled={!canSuspend || busy || !reason.trim()}
        title={canSuspend ? undefined : "Only ADMIN can suspend accounts"}
        className="admin-btn-press"
        style={{
          padding: "8px 10px",
          border: 0,
          borderRadius: 7,
          background: suspended ? "#e4f2e8" : "#fee2e2",
          color: suspended ? "#21643d" : "#991b1b",
          fontWeight: 700,
          cursor: canSuspend && !busy ? "pointer" : "not-allowed",
          opacity: canSuspend ? 1 : 0.55,
        }}
      >
        {busy ? "Saving…" : suspended ? "Unsuspend" : "Suspend"}
      </button>
    </div>
  )
}
