"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { motion } from "framer-motion"

/**
 * The report's controls: which window, and whether it refreshes itself.
 *
 * ── WHY THE WINDOW LIVES IN THE URL ─────────
 *
 * A report is something people link to. "Look at the last 7 days" has to be a
 * URL somebody can paste into a chat, and the printed export has to be
 * reproducible from the same address. So the window is a search parameter, the
 * page reads it server-side, and this component only rewrites it.
 *
 * ── WHY A CLIENT COMPONENT FOR TWO CONTROLS ─────────────────
 *
 * Selecting a window means navigating, and auto-refresh means a timer. Both are
 * browser concerns. The report body stays a server component, so the figures
 * are always rendered from a fresh database read rather than computed in the
 * browser -- which is the property that keeps the screen and the PDF honest.
 *
 * ── AUTO-REFRESH AND WHY IT IS OFF BY DEFAULT ────────────────
 *
 * router.refresh() re-runs the server component without losing scroll position.
 * It is off by default because a report that silently reloads under somebody
 * mid-read is a report they cannot finish reading, and on a page that is meant
 * to be printed a moving target is worse than a stale one. The timestamp at the
 * top always says when the figures were read, so a stale page is never
 * mistaken for a live one.
 */

export interface WindowOption {
  days: number
  label: string
}

const REFRESH_INTERVAL_MS = 30_000

export default function ReportControls({
  options,
  activeDays,
}: {
  options: WindowOption[]
  activeDays: number
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [live, setLive] = useState(false)
  const wasLiveBeforePrint = useRef(false)

  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(() => {
      router.refresh()
    }, REFRESH_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [live, router])

  useEffect(() => {
    const handleBeforePrint = () => {
      if (live) {
        wasLiveBeforePrint.current = true
        setLive(false)
      }
    }

    const handleAfterPrint = () => {
      if (wasLiveBeforePrint.current) {
        wasLiveBeforePrint.current = false
        setLive(true)
      }
    }

    window.addEventListener("beforeprint", handleBeforePrint)
    window.addEventListener("afterprint", handleAfterPrint)

    return () => {
      window.removeEventListener("beforeprint", handleBeforePrint)
      window.removeEventListener("afterprint", handleAfterPrint)
    }
  }, [live])

  function selectWindow(days: number) {
    const next = new URLSearchParams(searchParams.toString())
    next.set("days", String(days))
    router.push("/admin/reports?" + next.toString())
  }

  return (
    <div
      className="no-print"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        background: "var(--adm-panel-flat)",
        borderRadius: 16,
        padding: "10px 12px",
      }}
    >
      <span style={{ fontSize: 12, color: "var(--adm-text-muted)", fontWeight: 700, marginRight: 2 }}>Period</span>
      {options.map((option) => {
        const active = option.days === activeDays
        return (
          <button
            key={option.days}
            type="button"
            onClick={() => selectWindow(option.days)}
            className="admin-chip admin-btn-press"
            data-active={active}
            style={{
              border: "1px solid " + (active ? "var(--adm-accent-soft)" : "var(--adm-border-chip)"),
              color: active ? "var(--adm-text-on-soft)" : "var(--adm-text)",
              background: active ? undefined : "transparent",
              cursor: "pointer",
            }}
          >
            {active ? (
              <motion.span
                layoutId="chip-pill-report-window"
                className="admin-chip-pill"
                style={{ background: "var(--adm-accent-soft)" }}
                transition={{ type: "spring", stiffness: 500, damping: 40, mass: 0.6 }}
              />
            ) : null}
            <span className="admin-chip-label">{option.label}</span>
          </button>
        )
      })}

      <button
        type="button"
        onClick={() => setLive(!live)}
        title={
          live
            ? "Live view on -- the figures re-read every 30 seconds"
            : "Turn on a live view that re-reads every 30 seconds"
        }
        className="admin-btn-press"
        style={{
          marginLeft: 6,
          padding: "9px 16px",
          borderRadius: 999,
          fontSize: 13,
          fontWeight: 700,
          cursor: "pointer",
          border: "1px solid " + (live ? "var(--adm-good)" : "var(--adm-border-control)"),
          background: live ? "var(--adm-good-bg)" : "transparent",
          color: live ? "var(--adm-good)" : "var(--adm-text)",
        }}
      >
        {live ? "● Live" : "○ Live"}
      </button>

      <button
        type="button"
        onClick={() => router.refresh()}
        className="admin-btn-press"
        style={{
          padding: "9px 16px",
          borderRadius: 999,
          fontSize: 13,
          fontWeight: 700,
          cursor: "pointer",
          border: "1px solid var(--adm-border-secondary)",
          background: "transparent",
          color: "var(--adm-text)",
        }}
      >
        Refresh now
      </button>
    </div>
  )
}
