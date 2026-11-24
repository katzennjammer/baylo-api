"use client"

import { useRouter, useSearchParams } from "next/navigation"

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
 * ── PRESETS AND A DATE RANGE ───────────────────────────────
 *
 * The select sets ?days= (one control, not a chip per preset, so the bar has
 * room for the dates); the two date fields set ?from=&to= (whole days in the
 * report's time zone) and win when both are valid. Native date inputs, so the
 * picker, keyboard entry and locale formatting are the browser's. The fields
 * always show the window on screen, so a preset can be nudged by a day rather
 * than retyped.
 *
 * A preset is a ROLLING window -- its link means "the last 30 days" whenever it
 * is opened -- where a date range is fixed. That is why both exist.
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
  from,
  to,
  max,
}: {
  options: WindowOption[]
  /** The active preset, or 0 when a date range is in force. */
  activeDays: number
  /** The window on screen, as YYYY-MM-DD in the report's time zone. */
  from: string
  to: string
  /** Today in the report's time zone; neither field goes past it. */
  max: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()

  function selectWindow(days: number) {
    const next = new URLSearchParams(searchParams.toString())
    next.set("days", String(days))
    next.delete("from")
    next.delete("to")
    router.push("/admin/reports?" + next.toString())
  }

  function applyRange(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const next = new URLSearchParams({ from: String(data.get("from")), to: String(data.get("to")) })
    router.push("/admin/reports?" + next.toString())
  }

  const dateInput: React.CSSProperties = {
    background: "var(--adm-input)",
    border: "1px solid var(--adm-border-input)",
    borderRadius: "var(--adm-radius-input)",
    color: "var(--adm-text)",
    padding: "6px 10px",
    fontSize: 13,
    fontFamily: "inherit",
  }
  const fieldLabel: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "var(--adm-text-muted)" }

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
      <select
        aria-label="Period"
        value={activeDays}
        onChange={(event) => selectWindow(Number(event.target.value))}
        style={{ ...dateInput, fontWeight: 600, cursor: "pointer" }}
      >
        {/* Shown only while a date range is in force, so the select never
            claims a preset that is not the one on screen. */}
        {activeDays === 0 ? (
          <option value={0} disabled>
            Custom dates
          </option>
        ) : null}
        {options.map((option) => (
          <option key={option.days} value={option.days}>
            {option.label}
          </option>
        ))}
      </select>

      {/* Keyed on the window so the fields follow a preset click. */}
      <form key={from + to} onSubmit={applyRange} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <label style={fieldLabel}>
          From
          <input type="date" name="from" defaultValue={from} max={max} required style={dateInput} />
        </label>
        <label style={fieldLabel}>
          To
          <input type="date" name="to" defaultValue={to} max={max} required style={dateInput} />
        </label>
        <button
          type="submit"
          className="admin-chip admin-btn-press"
          data-active={activeDays === 0}
          style={{
            border: "1px solid " + (activeDays === 0 ? "var(--adm-accent-soft)" : "var(--adm-border-chip)"),
            background: activeDays === 0 ? "var(--adm-accent-soft)" : "transparent",
            color: activeDays === 0 ? "var(--adm-text-on-soft)" : "var(--adm-text)",
            cursor: "pointer",
          }}
        >
          <span className="admin-chip-label">Apply</span>
        </button>
      </form>
    </div>
  )
}
