"use client"

import { useEffect, useRef, useState } from "react"
import { signOut } from "next-auth/react"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { ChevronDown } from "lucide-react"

export default function AccountMenu({
  name,
  role,
}: {
  name: string | null
  role: "ADMIN"
}) {
  const [open, setOpen] = useState(false)
  const displayName = name?.trim() || "Account"
  const reduce = useReducedMotion()
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  async function leaveAdmin() {
    await signOut({ callbackUrl: "/auth/login" })
  }

  // Outside-click and Escape close the menu; closing on Escape returns
  // focus to the trigger. Side effects on the document, so this belongs
  // in an effect, and only runs its setState from the event callbacks.
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  return (
    <div ref={containerRef} style={{ position: "relative", whiteSpace: "nowrap", marginLeft: 12 }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Account menu for ${displayName}`}
        className="adm-press"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          border: 0,
          background: "transparent",
          cursor: "pointer",
          padding: 4,
          borderRadius: 999,
        }}
      >
        <span
          className="adm-account-text"
          style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.25 }}
        >
          <span style={{ fontSize: 15, fontWeight: 700, color: "var(--adm-text)" }}>{displayName}</span>
          <span style={{ fontSize: 12, fontWeight: 500, color: "var(--adm-text-muted)", textTransform: "capitalize" }}>
            {role.toLowerCase()}
          </span>
        </span>
        <span
          aria-hidden="true"
          style={{
            width: 44,
            height: 44,
            borderRadius: "999px",
            background: "var(--adm-highlight)",
            color: "var(--adm-text-on-soft)",
            display: "grid",
            placeItems: "center",
            fontSize: 14,
            fontWeight: 800,
            flex: "none",
          }}
        >
          {initials(displayName)}
        </span>
        <span
          aria-hidden="true"
          style={{
            color: "var(--adm-text-muted)",
            display: "flex",
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform 200ms var(--adm-ease-standard)",
          }}
        >
          <ChevronDown size={16} />
        </span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={reduce ? false : { opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.98 }}
            transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 600, damping: 30 }}
            style={{
              position: "absolute",
              top: "calc(100% + 8px)",
              right: 0,
              minWidth: 200,
              padding: 6,
              borderRadius: 16,
              background: "var(--adm-panel-flat)",
              border: "1px solid var(--adm-border-input)",
              boxShadow: "var(--adm-shadow-overlay)",
              zIndex: 30,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <button type="button" role="menuitem" onClick={leaveAdmin} className="admin-btn-press" style={menuButtonStyle}>
              Switch account
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={leaveAdmin}
              className="admin-btn-press"
              style={{ ...menuButtonStyle, color: "var(--adm-warn)" }}
            >
              Sign out
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "—"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

const menuButtonStyle = {
  display: "block",
  width: "100%",
  padding: "12px 14px",
  border: 0,
  borderRadius: 10,
  background: "transparent",
  textAlign: "left" as const,
  color: "var(--adm-text)",
  cursor: "pointer",
  fontSize: 14,
  fontWeight: 600,
}
