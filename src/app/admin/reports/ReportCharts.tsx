"use client"

import { useState, type ReactNode } from "react"
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
 * server-rendered HTML, for no gain. TrendChart and DonutChart below are plain
 * inline SVG for the same reason BarChart is plain divs.
 *
 * ── WHY CSS BARS AND NOT SVG, FOR BarChart SPECIFICALLY ─────
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
 * TrendChart and DonutChart use `<svg viewBox="0 0 W H" style={{width:"100%"}}>`
 * instead: the coordinate SYSTEM is fixed (the viewBox), but the rendered
 * element scales to its container exactly the way a percentage-width div does,
 * so the same overflow bug can't recur here either.
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
  /** Bar colour. Defaults to the admin accent. */
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
  color = "var(--adm-accent)",
  emptyLabel = "Nothing to show for this period.",
  limit,
}: BarChartProps) {
  const max = points.reduce((highest, p) => (p.value > highest ? p.value : highest), 0)
  const hasData = points.length > 0 && max > 0
  const shown = limit !== undefined && points.length > limit ? points.slice(0, limit) : points
  const hidden = points.length - shown.length

  return (
    <section style={cardStyle} className="adm-lift">
      <h2 style={cardTitleStyle}>{title}</h2>
      {caption ? <p style={captionStyle}>{caption}</p> : null}

      {!hasData ? (
        <p style={emptyStyle}>{emptyLabel}</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
          {shown.map((point, index) => {
            // Percentage of the tallest bar. A real value is floored at 1% so it
            // never renders as an invisible sliver; a zero value renders empty.
            const pct = point.value > 0 ? Math.max(1, (point.value / max) * 100) : 0
            return (
              <div key={point.key ?? point.label} style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                <span
                  style={{
                    width: LABEL_WIDTH,
                    flexShrink: 0,
                    fontSize: 13,
                    fontWeight: 500,
                    color: "var(--adm-text-secondary)",
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
                    height: 10,
                    borderRadius: 999,
                    background: "var(--adm-track)",
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
                    fontSize: 13,
                    fontWeight: 700,
                    color: "var(--adm-text)",
                    whiteSpace: "nowrap",
                    minWidth: 44,
                    textAlign: "right",
                    flexShrink: 0,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {point.value.toLocaleString()}
                </span>
              </div>
            )
          })}
          {hidden > 0 ? <p style={{ fontSize: 12, color: "var(--adm-text-muted)", marginTop: 2 }}>and {hidden} more with a smaller count.</p> : null}
        </div>
      )}
    </section>
  )
}

// ── ColumnChart ─────────────────────────────────────────────────────────────

const COLUMN_PLOT_H = 200
const COLUMN_AXIS_W = 40

/** A round axis top and step for whole-number counts: 278 -> 0, 100, 200, 300. */
function niceScale(max: number): { top: number; step: number } {
  const rough = max / 4
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)))
  const normalised = rough / magnitude
  // 1, 2, 5, 10 only -- a 2.5 step would label a count axis "2.5, 7.5".
  const nice = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10
  const step = Math.max(1, nice * magnitude)
  return { top: Math.ceil(max / step) * step, step }
}

/**
 * Vertical bars against a value axis, for a series whose labels are short: the
 * months of a year, a handful of types. BarChart stays the right shape for long
 * labels (hub names, report reasons), which a column has no room to print.
 *
 * Same overflow-proof construction as BarChart, turned on its side: each bar's
 * height is a PERCENTAGE of a fixed-height plot and each slot is a flex share
 * of the card's width, so nothing here is sized from a constant that could be
 * wider than the card. Bars are <span>s, not <div>s, because the print
 * stylesheet whitens every div's background.
 */
export function ColumnChart({
  title,
  caption,
  points,
  color = "var(--adm-accent)",
  emptyLabel = "Nothing to show for this period.",
  limit,
}: BarChartProps) {
  const max = points.reduce((highest, p) => (p.value > highest ? p.value : highest), 0)
  const hasData = points.length > 0 && max > 0
  const shown = limit !== undefined && points.length > limit ? points.slice(0, limit) : points
  const hidden = points.length - shown.length
  const { top, step } = hasData ? niceScale(max) : { top: 1, step: 1 }
  const ticks: number[] = []
  for (let value = 0; value <= top + step / 2; value += step) ticks.push(value)

  const slots: React.CSSProperties = { display: "flex", gap: 8, padding: "0 8px" }

  return (
    <section style={cardStyle} className="adm-lift report-column-chart">
      <h2 style={cardTitleStyle}>{title}</h2>
      {caption ? <p style={captionStyle}>{caption}</p> : null}

      {!hasData ? (
        <p style={emptyStyle}>{emptyLabel}</p>
      ) : (
        <div style={{ marginTop: 34 }}>
          <div className="report-column-plot" style={{ position: "relative", height: COLUMN_PLOT_H }}>
            {ticks.map((tick) => (
              <div key={tick} style={{ position: "absolute", left: 0, right: 0, bottom: (tick / top) * 100 + "%" }}>
                <span
                  style={{
                    position: "absolute",
                    left: 0,
                    bottom: -7,
                    width: COLUMN_AXIS_W - 10,
                    textAlign: "right",
                    fontSize: 11,
                    lineHeight: "14px",
                    color: "var(--adm-text-muted)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {tick.toLocaleString()}
                </span>
                <div style={{ marginLeft: COLUMN_AXIS_W, borderTop: "1px solid var(--adm-divider)" }} />
              </div>
            ))}

            <div style={{ ...slots, position: "absolute", left: COLUMN_AXIS_W, right: 0, top: 0, bottom: 0, alignItems: "flex-end" }}>
              {shown.map((point) => {
                // A real value is floored at 1% so it never renders as nothing.
                const pct = point.value > 0 ? Math.max(1, (point.value / top) * 100) : 0
                return (
                  // role="img" sits on the slot, not the bar: the print
                  // stylesheet pins every span[role='img'] to a 7px track
                  // height, which is right for BarChart and would flatten
                  // these.
                  <div
                    key={point.key ?? point.label}
                    role="img"
                    aria-label={point.label + ": " + point.value}
                    title={point.label + ": " + point.value.toLocaleString()}
                    style={{ flex: 1, minWidth: 0, height: "100%", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
                  >
                    <span
                      style={{
                        position: "relative",
                        display: "block",
                        width: "100%",
                        maxWidth: 44,
                        height: pct + "%",
                        background: color,
                        borderRadius: "6px 6px 0 0",
                      }}
                    >
                      <span
                        style={{
                          position: "absolute",
                          left: "50%",
                          bottom: "100%",
                          transform: "translateX(-50%)",
                          paddingBottom: 4,
                          fontSize: 11,
                          fontWeight: 700,
                          color: "var(--adm-text)",
                          whiteSpace: "nowrap",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {point.value.toLocaleString()}
                      </span>
                    </span>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="report-column-labels" style={{ ...slots, marginLeft: COLUMN_AXIS_W, marginTop: 8, alignItems: "flex-start" }}>
            {shown.map((point) => (
              <span
                key={point.key ?? point.label}
                style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 11, lineHeight: 1.3, color: "var(--adm-text-muted)", overflowWrap: "anywhere" }}
              >
                {point.label}
                {point.partial ? "*" : ""}
              </span>
            ))}
          </div>
          {hidden > 0 ? <p style={{ fontSize: 12, color: "var(--adm-text-muted)", marginTop: 10 }}>and {hidden} more with a smaller count.</p> : null}
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
  const valueColor = tone === "warn" ? "var(--adm-warn)" : tone === "good" ? "var(--adm-good)" : "var(--adm-text)"

  return (
    <div style={cardStyle} className="adm-lift report-tile">
      <div style={{ color: "var(--adm-text-muted)", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>
        {label}
      </div>
      <div className="report-tile-value" style={{ fontSize: 38, fontWeight: 700, marginTop: 10, letterSpacing: "-0.03em", color: valueColor, fontVariantNumeric: "tabular-nums" }}>
        {typeof value === "number" ? <CountUp value={value} /> : value}
      </div>
      {hint ? <div style={{ color: "var(--adm-text-muted)", fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>{hint}</div> : null}
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
  rows: { key: string; cells: ReactNode[] }[]
  emptyLabel?: string
}) {
  return (
    <section style={cardStyle} className="adm-lift">
      <h2 style={cardTitleStyle}>{title}</h2>
      {caption ? <p style={captionStyle}>{caption}</p> : null}

      {rows.length === 0 ? (
        <p style={emptyStyle}>{emptyLabel ?? "Nothing recorded for this period."}</p>
      ) : (
        <div style={{ overflowX: "auto", marginTop: 14 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                {columns.map((column) => (
                  <th
                    key={column}
                    style={{
                      padding: "8px 10px",
                      whiteSpace: "nowrap",
                      fontSize: 11,
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      color: "var(--adm-text-muted)",
                    }}
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="adm-row-hover" style={{ borderTop: "1px solid var(--adm-divider)" }}>
                  {row.cells.map((cell, i) => (
                    <td
                      key={String(i)}
                      style={{
                        padding: "10px 10px",
                        fontWeight: i === 0 ? 700 : 500,
                        color: i === 0 ? "var(--adm-text)" : "var(--adm-text-secondary)",
                        whiteSpace: i === 0 ? "normal" : "nowrap",
                        verticalAlign: "top",
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

// ── TrendChart ──────────────────────────────────────────────────────────────

export interface TrendSeries {
  points: SeriesPoint[]
  /** CSS colour (a var(--adm-*) string or literal). */
  color: string
  label: string
  /** Dashed stroke, no area fill -- for a comparison series behind the primary. */
  dashed?: boolean
}

const CHART_W = 720
const CHART_H = 220
const CHART_PAD_X = 8
const CHART_PAD_TOP = 12
const CHART_PAD_BOTTOM = 28

const CHART_INNER_W = CHART_W - CHART_PAD_X * 2
const CHART_INNER_H = CHART_H - CHART_PAD_TOP - CHART_PAD_BOTTOM

/** Where point `i` of `n` sits, in viewBox units. */
function xAt(i: number, n: number): number {
  return CHART_PAD_X + (n <= 1 ? CHART_INNER_W / 2 : (i / (n - 1)) * CHART_INNER_W)
}
function yAt(value: number, max: number): number {
  return CHART_PAD_TOP + CHART_INNER_H - (max > 0 ? (value / max) * CHART_INNER_H : 0)
}

/** `M x0,y0 L x1,y1 L x2,y2 ...` over a fixed viewBox -- see the file header
 *  for why a viewBox-scaled SVG can't reproduce BarChart's old overflow bug. */
function linePath(points: SeriesPoint[], max: number): string {
  const n = points.length
  return points.map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(i, n).toFixed(1)},${yAt(p.value, max).toFixed(1)}`).join(" ")
}

function areaPath(points: SeriesPoint[], max: number): string {
  const innerW = CHART_W - CHART_PAD_X * 2
  const line = linePath(points, max)
  const n = points.length
  const lastX = CHART_PAD_X + (n <= 1 ? innerW / 2 : innerW)
  const floorY = CHART_H - CHART_PAD_BOTTOM
  return `${line} L ${lastX.toFixed(1)},${floorY} L ${CHART_PAD_X},${floorY} Z`
}

/**
 * A monthly trend, as a line (plus an optional dashed comparison series) with
 * a gradient area fill under the primary -- see DESIGN_SPEC.md §3.29 for the
 * colour spec this follows. Renders the SAME SeriesPoint[] shape BarChart
 * takes; this is a different way to draw existing data, not new data.
 */
export function TrendChart({
  title,
  caption,
  primary,
  secondary,
  emptyLabel = "Nothing to show for this period.",
}: {
  title: string
  caption?: string
  primary: TrendSeries
  secondary?: TrendSeries
  emptyLabel?: string
}) {
  const allValues = [...primary.points, ...(secondary?.points ?? [])].map((p) => p.value)
  const max = allValues.reduce((highest, v) => (v > highest ? v : highest), 0)
  const hasData = primary.points.length > 0 && max > 0
  const gradientId = "trend-fill-" + title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()

  // The point under the cursor, and where it sits in the wrapper in CSS pixels
  // (the tooltip is HTML laid over the SVG, so it needs pixels, not viewBox
  // units).
  const [hover, setHover] = useState<{ index: number; left: number; top: number; flip: boolean } | null>(null)
  const n = primary.points.length

  function onPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const svg = event.currentTarget
    const matrix = svg.getScreenCTM()
    if (!matrix || n === 0) return
    // The viewBox is letterboxed inside the element, so a plain "fraction of
    // the element's width" would be off; the CTM is the exact mapping.
    const viewX = (event.clientX - matrix.e) / matrix.a
    const index = n <= 1 ? 0 : Math.min(n - 1, Math.max(0, Math.round(((viewX - CHART_PAD_X) / CHART_INNER_W) * (n - 1))))
    const box = svg.getBoundingClientRect()
    setHover({
      index,
      left: xAt(index, n) * matrix.a + matrix.e - box.left,
      top: yAt(primary.points[index].value, max) * matrix.d + matrix.f - box.top,
      flip: index > (n - 1) / 2,
    })
  }
  const hovered = hover ? primary.points[hover.index] : null

  return (
    <section style={{ ...cardStyle, gridColumn: "1 / -1" }} className="adm-lift report-trend-chart">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h2 style={cardTitleStyle}>{title}</h2>
          {caption ? <p style={captionStyle}>{caption}</p> : null}
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <Legend color={primary.color} label={primary.label} />
          {secondary ? <Legend color={secondary.color} label={secondary.label} dashed /> : null}
        </div>
      </div>

      {!hasData ? (
        <p style={emptyStyle}>{emptyLabel}</p>
      ) : (
        <div style={{ marginTop: 18, position: "relative" }}>
          <svg
            viewBox={`0 0 ${CHART_W} ${CHART_H}`}
            style={{ width: "100%", height: 220, display: "block", touchAction: "pan-y" }}
            role="img"
            aria-label={title}
            onPointerMove={onPointerMove}
            onPointerLeave={() => setHover(null)}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={primary.color} stopOpacity="0.45" />
                <stop offset="55%" stopColor={primary.color} stopOpacity="0.18" />
                <stop offset="100%" stopColor={primary.color} stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* Horizontal gridlines only, per DESIGN_SPEC §3.29. */}
            {[0.25, 0.5, 0.75].map((f) => {
              const y = CHART_PAD_TOP + (CHART_H - CHART_PAD_TOP - CHART_PAD_BOTTOM) * f
              return <line key={f} x1={CHART_PAD_X} y1={y} x2={CHART_W - CHART_PAD_X} y2={y} style={{ stroke: "var(--adm-divider)" }} strokeWidth={1} />
            })}

            <path d={areaPath(primary.points, max)} fill={`url(#${gradientId})`} stroke="none" />
            {secondary ? (
              <path
                d={linePath(secondary.points, max)}
                fill="none"
                style={{ stroke: secondary.color }}
                strokeWidth={2}
                strokeDasharray="4 6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null}
            <path
              d={linePath(primary.points, max)}
              fill="none"
              style={{ stroke: primary.color }}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            {hover ? (
              <g pointerEvents="none">
                <line
                  x1={xAt(hover.index, n)}
                  y1={CHART_PAD_TOP}
                  x2={xAt(hover.index, n)}
                  y2={CHART_H - CHART_PAD_BOTTOM}
                  style={{ stroke: "var(--adm-text-muted)" }}
                  strokeWidth={1}
                  strokeDasharray="3 4"
                />
                {secondary && secondary.points[hover.index] ? (
                  <circle cx={xAt(hover.index, n)} cy={yAt(secondary.points[hover.index].value, max)} r={4} style={{ fill: secondary.color, stroke: "var(--adm-panel-solid)" }} strokeWidth={2} />
                ) : null}
                <circle cx={xAt(hover.index, n)} cy={yAt(primary.points[hover.index].value, max)} r={4} style={{ fill: primary.color, stroke: "var(--adm-panel-solid)" }} strokeWidth={2} />
              </g>
            ) : null}

            {primary.points.map((p, i) => {
              const x = xAt(i, n)
              return (
                <text
                  key={p.key ?? p.label}
                  x={x}
                  y={CHART_H - 8}
                  textAnchor="middle"
                  style={{ fill: "var(--adm-text-muted)", fontSize: 11, fontFamily: "var(--adm-font-sans)" }}
                >
                  {p.label}
                  {p.partial ? "*" : ""}
                </text>
              )
            })}
          </svg>

          {hover && hovered ? (
            <div
              style={{
                position: "absolute",
                top: Math.min(hover.top + 12, CHART_H - 110),
                ...(hover.flip ? { right: `calc(100% - ${hover.left - 14}px)` } : { left: hover.left + 14 }),
                minWidth: 160,
                background: "var(--adm-panel-solid)",
                border: "1px solid var(--adm-border-hover)",
                borderRadius: 10,
                boxShadow: "0 8px 24px rgba(0,0,0,0.16)",
                pointerEvents: "none",
                zIndex: 2,
              }}
            >
              <div style={{ padding: "8px 12px", fontSize: 12, fontWeight: 600, color: "var(--adm-text-secondary)", borderBottom: "1px solid var(--adm-divider)" }}>
                {hovered.label}
                {hovered.partial ? " (so far)" : ""}
              </div>
              <div style={{ padding: "8px 12px", display: "grid", gap: 6 }}>
                {[primary, ...(secondary ? [secondary] : [])].map((series) => (
                  <div key={series.label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 999, background: series.color, flexShrink: 0 }} />
                    <span style={{ flex: 1, color: "var(--adm-text-secondary)", whiteSpace: "nowrap" }}>{series.label}</span>
                    <span style={{ fontWeight: 700, color: "var(--adm-text)", fontVariantNumeric: "tabular-nums" }}>
                      {(series.points[hover.index]?.value ?? 0).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}

function Legend({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--adm-text-secondary)" }}>
      <span
        style={{
          width: 12,
          height: dashed ? 0 : 8,
          borderRadius: dashed ? 0 : 999,
          background: dashed ? "transparent" : color,
          borderTop: dashed ? `2px dashed ${color}` : undefined,
        }}
      />
      {label}
    </div>
  )
}

// ── DonutChart ──────────────────────────────────────────────────────────────

const DONUT_PALETTE = [
  "var(--adm-accent)",
  "var(--adm-accent-2)",
  "var(--adm-good)",
  "var(--adm-queue)",
  "var(--adm-info)",
  "var(--adm-neutral)",
]

/**
 * A categorical breakdown as a ring, with a legend that carries the exact
 * numbers -- the ring shows proportion at a glance, the legend is what a
 * screen reader and a printed page actually read. Built as stacked <circle>
 * strokes with stroke-dasharray, the standard SVG-donut technique, rather
 * than a pie of <path> wedges: a circle's circumference is one number, so
 * there is no per-wedge arc-angle trig to get subtly wrong at the edges.
 */
export function DonutChart({
  title,
  caption,
  points,
  emptyLabel = "Nothing to show for this period.",
}: {
  title: string
  caption?: string
  points: SeriesPoint[]
  emptyLabel?: string
}) {
  const total = points.reduce((sum, p) => sum + p.value, 0)
  const hasData: boolean = points.length > 0 && total > 0
  const size = 168
  const stroke = 26
  const r = (size - stroke) / 2
  const circumference = 2 * Math.PI * r

  let offset = 0
  const segments = hasData
    ? points
        .filter((p) => p.value > 0)
        .map((p, i) => {
          const fraction = p.value / total
          const dash = fraction * circumference
          const seg = { point: p, color: DONUT_PALETTE[i % DONUT_PALETTE.length], dash, offset, fraction }
          offset += dash
          return seg
        })
    : []

  return (
    <section style={cardStyle} className="adm-lift report-donut-chart">
      <h2 style={cardTitleStyle}>{title}</h2>
      {caption ? <p style={captionStyle}>{caption}</p> : null}

      {!hasData ? (
        <p style={emptyStyle}>{emptyLabel}</p>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 24, marginTop: 16, flexWrap: "wrap" }}>
          <svg
            viewBox={`0 0 ${size} ${size}`}
            style={{ width: size, height: size, flexShrink: 0, transform: "rotate(-90deg)" }}
            role="img"
            aria-label={title}
          >
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" style={{ stroke: "var(--adm-track)" }} strokeWidth={stroke} />
            {segments.map((seg) => (
              <circle
                key={seg.point.key ?? seg.point.label}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                style={{ stroke: seg.color }}
                strokeWidth={stroke}
                strokeDasharray={`${seg.dash.toFixed(1)} ${(circumference - seg.dash).toFixed(1)}`}
                strokeDashoffset={-seg.offset}
                strokeLinecap="butt"
              />
            ))}
          </svg>

          <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0, flex: 1 }}>
            {segments.map((seg) => (
              <div key={seg.point.key ?? seg.point.label} style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <span style={{ width: 9, height: 9, borderRadius: 999, background: seg.color, flexShrink: 0 }} />
                <span
                  style={{
                    fontSize: 13,
                    color: "var(--adm-text-secondary)",
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={seg.point.label}
                >
                  {seg.point.label}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "var(--adm-text)", fontVariantNumeric: "tabular-nums" }}>
                  {seg.point.value.toLocaleString()}
                </span>
                <span style={{ fontSize: 12, color: "var(--adm-text-muted)", width: 36, textAlign: "right" }}>
                  {Math.round(seg.fraction * 100)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

const cardStyle: React.CSSProperties = {
  background: "var(--adm-panel)",
  border: "1px solid var(--adm-border)",
  borderRadius: "var(--adm-radius-panel)",
  padding: 24,
  breakInside: "avoid",
  minWidth: 0,
}

const cardTitleStyle: React.CSSProperties = { fontSize: 16, fontWeight: 700, color: "var(--adm-text)" }
const captionStyle: React.CSSProperties = { fontSize: 13, color: "var(--adm-text-muted)", marginTop: 4, lineHeight: 1.5 }
const emptyStyle: React.CSSProperties = { fontSize: 13, color: "var(--adm-text-muted)", marginTop: 16 }
