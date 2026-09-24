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
    <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span style={{ fontSize: 12, color: "#777", fontWeight: 700 }}>Period</span>
      {options.map((option) => {
        const active = option.days === activeDays
        return (
          <button
            key={option.days}
            type="button"
            onClick={() => selectWindow(option.days)}
            className="admin-chip admin-btn-press"
            data-active={active}
            style={{ border: "1px solid " + (active ? "#1f6b43" : "rgba(0,0,0,.14)"), color: active ? "#21643d" : "#555", cursor: "pointer" }}
          >
            {active ? (
              <motion.span
                layoutId="chip-pill-report-window"
                className="admin-chip-pill"
                style={{ background: "rgba(31,107,67,.10)" }}
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
          padding: "7px 13px",
          borderRadius: 999,
          fontSize: 13,
          fontWeight: 700,
          cursor: "pointer",
          border: "1px solid " + (live ? "#15803d" : "rgba(0,0,0,.14)"),
          background: live ? "rgba(21,128,61,.10)" : "#fff",
          color: live ? "#15803d" : "#555",
        }}
      >
        {live ? "● Live" : "○ Live"}
      </button>

      <button
        type="button"
        onClick={() => router.refresh()}
        className="admin-btn-press"
        style={{
          padding: "7px 13px",
          borderRadius: 999,
          fontSize: 13,
          fontWeight: 700,
          cursor: "pointer",
          border: "1px solid rgba(0,0,0,.14)",
          background: "#fff",
          color: "#555",
        }}
      >
        Refresh now
      </button>
    </div>
  )
}
