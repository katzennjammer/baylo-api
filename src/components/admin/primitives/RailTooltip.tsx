"use client"

import { useEffect, useId, useRef, useState } from "react"
import { motion, useReducedMotion } from "framer-motion"

/**
 * Wraps a collapsed rail item so its label is still available on hover
 * (after a short delay, to avoid flicker while scanning down the rail)
 * and immediately on keyboard focus, since a collapsed item has no
 * visible label at all otherwise.
 */
export default function RailTooltip({
  label,
  children,
}: {
  label: string
  children: (describedById: string) => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reduce = useReducedMotion()
  const id = useId()

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  function showOnHover() {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => setOpen(true), 300)
  }
  function showNow() {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    setOpen(true)
  }
  function hide() {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    setOpen(false)
  }

  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={showOnHover}
      onMouseLeave={hide}
      onFocus={showNow}
      onBlur={hide}
    >
      {children(id)}
      {open ? (
        <motion.span
          role="tooltip"
          id={id}
          initial={reduce ? false : { opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
          style={{
            position: "absolute",
            left: "calc(100% + 12px)",
            top: "50%",
            transform: "translateY(-50%)",
            zIndex: 60,
            background: "var(--adm-tooltip-bg)",
            color: "var(--adm-text)",
            font: "600 13px/1.2 var(--adm-font-sans)",
            padding: "6px 10px",
            borderRadius: 10,
            border: "1px solid var(--adm-border-input)",
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          {label}
        </motion.span>
      ) : null}
    </div>
  )
}
