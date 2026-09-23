"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { motion } from "framer-motion"

/**
 * The report's controls: which window to view.
 *
 * ── WHY THE WINDOW LIVES IN THE URL ─────────
 *
 * A report is something people link to. "Look at the last 7 days" has to be a
 * URL somebody can paste into a chat, and the printed export has to be
 * reproducible from the same address. So the window is a search parameter, the
 * page reads it server-side, and this component only rewrites it.
 *
 * ── WHY A CLIENT COMPONENT FOR ONE CONTROL ─────────────────
 *
 * Selecting a window means navigating, which is a browser concern. The report
 * body stays a server component, so the figures are always rendered from a
 * fresh database read rather than computed in the browser -- which is the
 * property that keeps the screen and the PDF honest.
 *
 * ── NO LIVE / REFRESH CONTROLS, ON PURPOSE ─────────────────
 *
 * This page is `force-dynamic` with `revalidate: 0`, so navigating here (or
 * re-picking the current window) always reads current figures -- an
 * auto-refresh timer or a soft-refresh button was a convenience on top of
 * that, not the only way to see current data. Removed at the user's request;
 * see the git history for this file if a live view is wanted back.
 */

export interface WindowOption {
  days: number
  label: string
}

export default function ReportControls({
  options,
  activeDays,
}: {
  options: WindowOption[]
  activeDays: number
}) {
  const router = useRouter()
  const searchParams = useSearchParams()

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
    </div>
  )
}
