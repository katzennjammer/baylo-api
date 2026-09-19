"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import toast from "react-hot-toast"

type User = { id: string; name: string; email: string; role: string; deletedAt: Date | null }

export default function AccessActions({ users }: { users: User[] }) {
  const router = useRouter()
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [draftRoles, setDraftRoles] = useState<Record<string, string>>({})
  const filteredUsers = users.filter((user) => {
    const needle = query.trim().toLowerCase()
    return !needle || user.name.toLowerCase().includes(needle) || user.email.toLowerCase().includes(needle)
  })

  async function changeRole(userId: string, currentRole: string) {
    const role = draftRoles[userId] ?? currentRole
    if (role === currentRole) return
    if (!reason.trim()) return
    setBusy(userId)
    try {
      const response = await fetch("/api/admin/access", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId, role, reason }) })
      const payload = await response.json()
      if (!response.ok) {
        toast.error(payload?.error ?? "Role change failed.")
        return
      }
      toast.success("Role updated.")
      setReason("")
      setDraftRoles((current) => {
        const next = { ...current }
        delete next[userId]
        return next
      })
      router.refresh()
    } catch {
      toast.error("Role change failed.")
    } finally {
      setBusy(null)
    }
  }
  return <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
    <div style={{ background: "#fff", padding: 16, borderRadius: 10, border: "1px solid rgba(0,0,0,.08)" }}>
      <strong>Assign an existing account</strong>
      <p style={{ color: "#777", fontSize: 12, margin: "5px 0 12px" }}>Register the person first, then assign USER or ADMIN here.</p>
      <div style={{ display: "flex", gap: 8 }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or email" style={{ flex: 1, padding: 10, borderRadius: 8, border: "1px solid #ccc" }} />
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason required" style={{ flex: 1, padding: 10, borderRadius: 8, border: "1px solid #ccc" }} />
      </div>
    </div>
    {filteredUsers.map((user) => {
      const selectedRole = draftRoles[user.id] ?? user.role
      return <div key={user.id} style={{ background: "#fff", padding: 14, borderRadius: 10, display: "flex", gap: 12, alignItems: "center" }}>
        <div style={{ flex: 1 }}><strong>{user.name}</strong><div style={{ color: "#777", fontSize: 12 }}>{user.email} · Current: {user.role}</div></div>
        <select value={selectedRole} disabled={!!user.deletedAt || busy === user.id} onChange={(e) => setDraftRoles((current) => ({ ...current, [user.id]: e.target.value }))} style={{ padding: 8, borderRadius: 7 }}>
          <option value="USER">USER</option><option value="ADMIN">ADMIN</option>
        </select>
        <button type="button" disabled={!!user.deletedAt || busy === user.id || selectedRole === user.role || !reason.trim()} onClick={() => changeRole(user.id, user.role)} style={{ padding: "8px 12px", border: 0, borderRadius: 7, background: "#17201b", color: "#fff", fontWeight: 700, opacity: selectedRole === user.role || !reason.trim() ? 0.45 : 1 }}>
          {busy === user.id ? "Saving..." : "Save"}
        </button>
      </div>
    })}
    {filteredUsers.length === 0 && <p style={{ padding: 24, textAlign: "center", color: "#777" }}>No matching accounts.</p>}
  </div>
}
