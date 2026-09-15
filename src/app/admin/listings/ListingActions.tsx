"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import toast from "react-hot-toast"

export default function ListingActions({
  listingId,
  hidden,
  canAct,
}: {
  listingId: string
  hidden: boolean
  canAct: boolean
}) {
  const router = useRouter()
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!reason.trim()) {
      toast.error("A reason is required.")
      return
    }
    setBusy(true)
    try {
      const response = await fetch(`/api/admin/listings/${listingId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: hidden ? "unhide" : "hide", reason }),
      })
      const payload = await response.json()
      if (!response.ok) {
        toast.error(payload?.error?.message ?? "That action failed.")
        return
      }
      toast.success(hidden ? "Listing restored." : "Listing hidden.")
      setReason("")
      router.refresh()
    } catch {
      toast.error("That action failed.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 180 }}>
      <input
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Reason required"
        maxLength={1000}
        disabled={!canAct || busy}
        style={{ padding: "7px 9px", borderRadius: 7, border: "1px solid rgba(0,0,0,.16)", fontSize: 12 }}
      />
      <button
        type="button"
        onClick={submit}
        disabled={!canAct || busy || !reason.trim()}
        title={canAct ? undefined : "Moderators can manage listings"}
        style={{
          padding: "8px 10px",
          border: 0,
          borderRadius: 7,
          background: hidden ? "#e4f2e8" : "#fee2e2",
          color: hidden ? "#21643d" : "#991b1b",
          fontWeight: 700,
          cursor: canAct && !busy ? "pointer" : "not-allowed",
          opacity: canAct ? 1 : 0.55,
        }}
      >
        {busy ? "Saving…" : hidden ? "Restore listing" : "Hide listing"}
      </button>
    </div>
  )
}
