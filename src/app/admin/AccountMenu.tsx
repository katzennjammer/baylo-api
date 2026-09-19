"use client"

import { useState } from "react"
import { signOut } from "next-auth/react"

export default function AccountMenu({
  name,
  role,
}: {
  name: string | null
  role: "ADMIN"
}) {
  const [open, setOpen] = useState(false)
  const displayName = name?.trim() || "Account"

  async function leaveAdmin() {
    await signOut({ callbackUrl: "/auth/login" })
  }

  return (
    <div style={{ position: "relative", whiteSpace: "nowrap" }}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="menu"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          border: 0,
          background: "transparent",
          color: "#536159",
          cursor: "pointer",
          padding: "7px 4px",
        }}
      >
        <span style={{ fontSize: 12 }}>{displayName}</span>
        <span style={{ padding: "5px 9px", borderRadius: 999, background: "#e4f2e8", color: "#21643d", fontSize: 10, fontWeight: 800, letterSpacing: ".08em" }}>
          {role}
        </span>
        <span aria-hidden="true" style={{ fontSize: 12 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            minWidth: 180,
            padding: 6,
            borderRadius: 10,
            background: "#fff",
            border: "1px solid rgba(0,0,0,.1)",
            boxShadow: "0 12px 30px rgba(0,0,0,.14)",
            zIndex: 20,
          }}
        >
          <button type="button" role="menuitem" onClick={leaveAdmin} style={menuButtonStyle}>
            Switch account
          </button>
          <button type="button" role="menuitem" onClick={leaveAdmin} style={{ ...menuButtonStyle, color: "#a12626" }}>
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

const menuButtonStyle = {
  display: "block",
  width: "100%",
  padding: "10px 12px",
  border: 0,
  borderRadius: 7,
  background: "transparent",
  textAlign: "left" as const,
  color: "#17201b",
  cursor: "pointer",
  fontSize: 13,
}
