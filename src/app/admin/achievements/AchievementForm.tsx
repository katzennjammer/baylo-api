"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import toast from "react-hot-toast"

const CRITERIA = [
  ["VERIFIED_ACCOUNT", "Verified account"],
  ["ID_VERIFIED", "Government ID verified"],
  ["FIRST_LISTING", "First listing"],
  ["COMPLETED_TRADES", "Completed trades"],
] as const

type Achievement = {
  id?: string
  key: string
  name: string
  description: string
  icon: string
  criterion: (typeof CRITERIA)[number][0]
  threshold: number
  isActive: boolean
}

const empty: Achievement = { key: "", name: "", description: "", icon: "🏆", criterion: "VERIFIED_ACCOUNT", threshold: 1, isActive: true }
const input: React.CSSProperties = { width: "100%", boxSizing: "border-box", border: "1px solid rgba(0,0,0,.15)", borderRadius: 8, padding: "9px 10px", font: "inherit" }

export default function AchievementForm({ initial }: { initial?: Achievement & { unlockCount?: number } }) {
  const router = useRouter()
  const [open, setOpen] = useState(Boolean(initial))
  const [form, setForm] = useState<Achievement>(initial ?? empty)
  const [busy, setBusy] = useState(false)

  function update<K extends keyof Achievement>(key: K, value: Achievement[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function submit() {
    if (!form.name.trim() || !form.description.trim() || (!initial && !form.key.trim())) {
      toast.error("Name, description, and key are required.")
      return
    }
    setBusy(true)
    try {
      const response = await fetch(initial ? `/api/admin/achievements/${initial.id}` : "/api/admin/achievements", {
        method: initial ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(initial ? {} : { key: form.key.trim().toUpperCase() }),
          name: form.name,
          description: form.description,
          icon: form.icon,
          criterion: form.criterion,
          threshold: Number(form.threshold),
          isActive: form.isActive,
        }),
      })
      const payload = await response.json()
      if (!response.ok) {
        toast.error(payload?.error?.message ?? "That action failed.")
        return
      }
      toast.success(initial ? "Achievement updated." : "Achievement created.")
      setOpen(false)
      router.refresh()
    } catch {
      toast.error("That action failed.")
    } finally {
      setBusy(false)
    }
  }

  if (!open) return <button type="button" onClick={() => setOpen(true)} style={{ padding: "9px 14px", border: 0, borderRadius: 9, background: "#17201b", color: "#fff", fontWeight: 700 }}>{initial ? "Edit" : "Create achievement"}</button>

  return (
    <div style={{ display: "grid", gap: 8, padding: 14, borderRadius: 10, background: "#f7f9f7", minWidth: 300 }}>
      {!initial && <input value={form.key} onChange={(e) => update("key", e.target.value)} placeholder="Key, e.g. FIRST_LISTING" style={input} />}
      <input value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="Name" style={input} />
      <textarea value={form.description} onChange={(e) => update("description", e.target.value)} placeholder="Description shown to users" style={{ ...input, minHeight: 70 }} />
      <input value={form.icon} onChange={(e) => update("icon", e.target.value)} placeholder="Icon or emoji" style={input} />
      <select value={form.criterion} onChange={(e) => update("criterion", e.target.value as Achievement["criterion"])} style={input}>
        {CRITERIA.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <input type="number" min={1} value={form.threshold} onChange={(e) => update("threshold", Number(e.target.value))} placeholder="Threshold" style={input} />
      {initial && <label style={{ fontSize: 13 }}><input type="checkbox" checked={form.isActive} onChange={(e) => update("isActive", e.target.checked)} /> Active</label>}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={submit} disabled={busy} style={{ padding: "9px 14px", border: 0, borderRadius: 8, background: "#4CAF50", color: "#fff", fontWeight: 700 }}>{busy ? "Saving..." : "Save"}</button>
        <button type="button" onClick={() => setOpen(false)} disabled={busy} style={{ padding: "9px 14px", border: "1px solid rgba(0,0,0,.15)", borderRadius: 8, background: "#fff" }}>Cancel</button>
      </div>
    </div>
  )
}
