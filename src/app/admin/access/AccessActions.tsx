"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import toast from "react-hot-toast"
import { StaggerGroup, StaggerItem } from "@/components/admin/Stagger"

type User = { id: string; name: string; email: string; role: string; deletedAt: Date | null }

export default function AccessActions({ users }: { users: User[] }) {
  const router = useRouter()
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [draftRoles, setDraftRoles] = useState<Record<string, string>>({})
  // Flashes green briefly after a save -- a role change updates the row in
  // place rather than removing it, so the feedback is a highlight rather
  // than the fade-and-collapse used where an action removes a row from a
  // queue (see rowCollapse.ts).
  const [justSaved, setJustSaved] = useState<string | null>(null)
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
      setJustSaved(userId)
      window.setTimeout(() => setJustSaved((current) => (current === userId ? null : current)), 900)
      router.refresh()
    } catch {
      toast.error("Role change failed.")
    } finally {
      setBusy(null)
    }
  }
  return <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    <div style={{ background: "var(--adm-panel)", padding: 20, borderRadius: "var(--adm-radius-panel)", border: "1px solid var(--adm-border)" }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: "var(--adm-text)" }}>Assign an existing account</div>
      <p style={{ color: "var(--adm-text-muted)", fontSize: 13, margin: "6px 0 14px" }}>Register the person first, then assign USER or ADMIN here.</p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name or email"
          style={{ ...fieldStyle, flex: 1, minWidth: 200 }}
        />
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason required"
          style={{ ...fieldStyle, flex: 1, minWidth: 200 }}
        />
      </div>
    </div>
    <StaggerGroup as="div" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
    {filteredUsers.map((user, index) => {
      const selectedRole = draftRoles[user.id] ?? user.role
      const roleTone = user.role === "ADMIN" ? { fg: "var(--adm-info)", bg: "var(--adm-info-bg)" } : { fg: "var(--adm-neutral)", bg: "var(--adm-neutral-bg)" }
      return <StaggerItem as="div" index={index} key={user.id}>
        <div
          className="adm-row-hover"
          style={{
            background: justSaved === user.id ? "var(--adm-good-bg)" : "var(--adm-panel-flat)",
            border: "1px solid var(--adm-border)",
            padding: "14px 18px",
            borderRadius: "var(--adm-radius-tile)",
            display: "flex",
            gap: 14,
            alignItems: "center",
            flexWrap: "wrap",
            transition: "background 400ms ease-out",
            opacity: user.deletedAt ? 0.55 : 1,
          }}
        >
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: "var(--adm-text)" }}>{user.name}</div>
          <div style={{ color: "var(--adm-text-muted)", fontSize: 12, marginTop: 2 }}>{user.email}</div>
        </div>
        <span
          style={{
            padding: "4px 10px",
            borderRadius: 999,
            background: roleTone.bg,
            color: roleTone.fg,
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: "0.04em",
            flexShrink: 0,
          }}
        >
          {user.role}
        </span>
        <select
          value={selectedRole}
          disabled={!!user.deletedAt || busy === user.id}
          onChange={(e) => setDraftRoles((current) => ({ ...current, [user.id]: e.target.value }))}
          style={{ ...fieldStyle, width: "auto", padding: "9px 34px 9px 14px", borderRadius: 999, fontWeight: 600, flexShrink: 0 }}
        >
          <option value="USER">USER</option><option value="ADMIN">ADMIN</option>
        </select>
        <button
          type="button"
          disabled={!!user.deletedAt || busy === user.id || selectedRole === user.role || !reason.trim()}
          onClick={() => changeRole(user.id, user.role)}
          className="admin-btn-press"
          style={{
            padding: "9px 16px",
            border: 0,
            borderRadius: 999,
            background: "var(--adm-accent)",
            color: "var(--adm-text-on-accent)",
            fontWeight: 700,
            fontSize: 13,
            flexShrink: 0,
            cursor: selectedRole === user.role || !reason.trim() ? "not-allowed" : "pointer",
            opacity: selectedRole === user.role || !reason.trim() ? 0.45 : 1,
          }}
        >
          {busy === user.id ? "Saving..." : "Save"}
        </button>
        </div>
      </StaggerItem>
    })}
    </StaggerGroup>
    {filteredUsers.length === 0 && (
      <p style={{ padding: 32, textAlign: "center", color: "var(--adm-text-muted)", background: "var(--adm-panel-flat)", border: "1px dashed var(--adm-border-empty)", borderRadius: "var(--adm-radius-panel)" }}>
        No matching accounts.
      </p>
    )}
  </div>
}

const fieldStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: "var(--adm-radius-input)",
  border: "1px solid var(--adm-border-input)",
  background: "var(--adm-input)",
  color: "var(--adm-text)",
  fontSize: 13,
}
