"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import toast from "react-hot-toast"

/** Grant / end Premium (beta: lifetime) via POST /api/admin/users/[id]/premium. */
export default function PremiumToggle({ userId, premium }: { userId: string; premium: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (premium && !confirm("End this account's Premium?")) return
    setBusy(true)
    try {
      const response = await fetch(`/api/admin/users/${userId}/premium`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: premium ? "end" : "grant" }),
      })
      const payload = await response.json()
      if (!response.ok) {
        toast.error(payload?.error?.message ?? "That action failed.")
        return
      }
      toast.success(premium ? "Premium ended." : "Premium granted (lifetime, beta).")
      router.refresh()
    } catch {
      toast.error("That action failed.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={submit}
      disabled={busy}
      className="admin-btn-press"
      style={{
        marginTop: 8,
        padding: "6px 10px",
        borderRadius: 7,
        border: "1px solid var(--adm-border-control)",
        background: "var(--adm-panel)",
        color: "var(--adm-text-secondary)",
        fontSize: 12,
        fontWeight: 700,
        cursor: busy ? "not-allowed" : "pointer",
      }}
    >
      {busy ? "Saving…" : premium ? "End Premium" : "Grant Premium"}
    </button>
  )
}
