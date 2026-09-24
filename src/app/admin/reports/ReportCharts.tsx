"use client"

import type { SeriesPoint } from "@/lib/admin-reports"
import { CountUp } from "@/components/admin/CountUp"
import { AnimatedBarFill } from "@/components/admin/AnimatedBarFill"

/**
 * Charts for the overall report.
 *
 * ── WHY NO CHARTING LIBRARY ────────────────────────────────
 *
 * There is none in this project, and the whole admin console is inline styles
 * and plain markup with no component library behind it. Adding recharts to draw
 * some rectangles would put a client-side bundle into a page that is otherwise
 * server-rendered HTML, for no gain.
 *
 * ── WHY CSS BARS AND NOT SVG ───────────────────────────────
 *
 * The first version drew each bar as an <svg> with a width computed from a
 * constant. That was the bug: the constant was wider than the card once the
 * grid dropped to one column, so the bars overflowed their card in the browser
 * and ran off the page in the printed PDF.
 *
 * These bars are plain elements whose width is a PERCENTAGE of their own row. A
 * percentage cannot overflow its container at any width, on screen or on paper,
 * which is exactly the property the fixed width did not have. The value is also
 * printed beside every bar, so a printed page carries the numbers even if a
 * printer drops the backgrounds.
 *
 * ── THE SCALE ──────────────────
 *
 * Bars are scaled against the tallest value, not against a round maximum, so a
 * single outlier cannot flatten every other bar to a sliver. The value labels
 * carry the absolute numbers; the bars only carry the shape.
 */

export interface BarChartProps {
  title: string
  /** Rendered small, under the title. Says what the bars are counting. */
  caption?: string
  points: SeriesPoint[]
  /** Bar colour. Defaults to the console green. */
  color?: string
  /** Message shown when there is nothing to plot. */
  emptyLabel?: string
  /** Cap the rows shown; the rest are summarised. */
  limit?: number
}

const LABEL_WIDTH = 150

export function BarChart({
  title,
  caption,
  points,
  color = "#1f6b43",
  emptyLabel = "Nothing to show for this period.",
  limit,
}: BarChartProps) {
  const max = points.reduce((highest, p) => (p.value > highest ? p.value : highest), 0)
  const hasData = points.length > 0 && max > 0
  const shown = limit !== undefined && points.length > limit ? points.slice(0, limit) : points
  const hidden = points.length - shown.length

  return (
    <section style={cardStyle} className="admin-card-hover">
      <h2 style={{ fontSize: 15, fontWeight: 800 }}>{title}</h2>
      {caption ? (
        <p style={{ fontSize: 12, color: "#888", marginTop: 3, lineHeight: 1.5 }}>{caption}</p>
      ) : null}

      {!hasData ? (
        <p style={{ fontSize: 13, color: "#999", marginTop: 14 }}>{emptyLabel}</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 14 }}>
          {shown.map((point, index) => {
            // Percentage of the tallest bar. A real value is floored at 1% so it
            // never renders as an invisible sliver; a zero value renders empty.
            const pct = point.value > 0 ? Math.max(1, (point.value / max) * 100) : 0
            return (
              <div key={point.label} style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <span
                  style={{
                    width: LABEL_WIDTH,
                    flexShrink: 0,
                    fontSize: 12,
                    color: "#536159",
                    textAlign: "right",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                  title={point.label}
                >
                  {point.label}
                </span>

                {/* The track is the full remaining width; the fill is a
                    percentage OF THE TRACK, so neither can overflow the card. */}
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    height: 14,
                    borderRadius: 4,
                    background: "rgba(0,0,0,.045)",
                    overflow: "hidden",
                    display: "block",
                  }}
                  role="img"
                  aria-label={point.label + ": " + point.value}
                >
                  <AnimatedBarFill pct={pct} color={color} index={index} />
                </span>

                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: "#17201b",
                    whiteSpace: "nowrap",
                    minWidth: 44,
                    textAlign: "right",
                    flexShrink: 0,
                  }}
                >
                  {point.value.toLocaleString()}
                </span>
              </div>
            )
          })}
          {hidden > 0 ? (
            <p style={{ fontSize: 11, color: "#999", marginTop: 2 }}>
              and {hidden} more with a smaller count.
            </p>
          ) : null}
        </div>
      )}
    </section>
  )
}

/**
 * A single headline number.
 *
 * `tone` marks a figure that wants attention when it is non-zero -- an open
 * queue, a growing backlog. It is a colour hint only; the number is the fact.
 */
export function StatTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: number | string
  hint?: string
  tone?: "default" | "warn" | "good"
}) {
  const valueColor = tone === "warn" ? "#b45309" : tone === "good" ? "#21643d" : "#17201b"

  return (
    <div style={cardStyle} className="admin-card-hover">
      <div style={{ color: "#77827b", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em" }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 800, marginTop: 8, letterSpacing: "-.02em", color: valueColor }}>
        {typeof value === "number" ? <CountUp value={value} /> : value}
      </div>
      {hint ? <div style={{ color: "#888", fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>{hint}</div> : null}
    </div>
  )
}

/**
 * A plain table for the report's list-like sections.
 *
 * Used where a chart would be wrong: a ranking of five named places, where the
 * names matter as much as the counts, and a bar would only repeat the number
 * already sitting beside it.
 */
export function RankTable({
  title,
  caption,
  columns,
  rows,
  emptyLabel,
}: {
  title: string
  caption?: string
  columns: string[]
  rows: { key: string; cells: (string | number)[] }[]
  emptyLabel?: string
}) {
  return (
    <section style={cardStyle} className="admin-card-hover">
      <h2 style={{ fontSize: 15, fontWeight: 800 }}>{title}</h2>
      {caption ? (
        <p style={{ fontSize: 12, color: "#888", marginTop: 3, lineHeight: 1.5 }}>{caption}</p>
      ) : null}

      {rows.length === 0 ? (
        <p style={{ fontSize: 13, color: "#999", marginTop: 14 }}>
          {emptyLabel ?? "Nothing recorded for this period."}
        </p>
      ) : (
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#888", fontSize: 12 }}>
                {columns.map((column) => (
                  <th key={column} style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="admin-row-hover" style={{ borderTop: "1px solid rgba(0,0,0,.06)" }}>
                  {row.cells.map((cell, i) => (
                    <td
                      key={String(i)}
                      style={{
                        padding: "9px 10px",
                        fontWeight: i === 0 ? 600 : 400,
                        color: i === 0 ? "#17201b" : "#555",
                        whiteSpace: i === 0 ? "normal" : "nowrap",
                      }}
                    >
                      {typeof cell === "number" ? cell.toLocaleString() : cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

const cardStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid rgba(0,0,0,.08)",
  borderRadius: 14,
  padding: 18,
  breakInside: "avoid",
  minWidth: 0,
}
