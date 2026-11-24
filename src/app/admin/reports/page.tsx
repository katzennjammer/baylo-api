import { cookies } from "next/headers"
import { REPORT_DAYS_COOKIE } from "../pref-keys"
import { formatReportDate, loadReportSummary, normaliseWindowDays, parseCustomRange, reportDateInputValue, WINDOW_OPTIONS } from "@/lib/admin-reports"
import { BarChart, ColumnChart, DonutChart, RankTable, StatTile, TrendChart } from "./ReportCharts"
import ReportControls from "./ReportControls"
import ExportReportButton from "./ExportReportButton"

export const dynamic = "force-dynamic"
export const revalidate = 0

/**
 * /admin/reports — the overall picture.
 *
 * ── WHAT THIS PAGE IS FOR ──────────────────
 *
 * Every other page in this console answers "what do I do next": a queue, a list,
 * a decision. None of them answers "how is this platform doing", which is the
 * question asked in a monthly meeting. This page is that answer, and it is
 * deliberately read-only -- no button here changes a row, so nothing on it needs
 * a reason or writes an audit entry.
 *
 * ── WHAT MOVES WHEN YOU CHANGE THE PERIOD ────
 *
 * Everything that is a RATE moves with the window. Two things never do, and the
 * page is written so that is visible rather than surprising: "right now" counts
 * (open queues, suspended accounts) and all-time totals. A backlog is not a
 * rate, and a total that changed when you picked a period would be a total of
 * nothing in particular.
 *
 * ── PRINTING ─────────────────────
 *
 * The @media print block strips the console chrome and the page background, so
 * the printed report is the figures on white rather than a screenshot of a web
 * app. The export goes through the browser's own print-to-PDF; see
 * ExportReportButton for why there is no PDF library.
 */

const SERIES_COLOR = "var(--adm-accent)"
const WARN_COLOR = "var(--adm-queue)"
const INFO_COLOR = "var(--adm-info)"
const NEUTRAL_COLOR = "var(--adm-text-secondary)"

interface Props {
  searchParams: Promise<{ days?: string; from?: string; to?: string }>
}

export default async function AdminReportsPage({ searchParams }: Props) {
  const sp = await searchParams
  // No ?days= falls back to the period this admin chose in Settings.
  const days = normaliseWindowDays(sp.days ?? (await cookies()).get(REPORT_DAYS_COOKIE)?.value)
  // ?from=&to= wins over ?days= when both dates are valid.
  const custom = parseCustomRange(sp.from, sp.to)
  const summary = await loadReportSummary(days, custom ?? undefined)
  const t = summary.totals
  const fromLabel = formatReportDate(summary.from)
const toLabel = formatReportDate(summary.to)
  const generatedLabel = summary.generatedAt.toLocaleString()

  const resolutionLabel =
    summary.medianResolutionHours === null
      ? "—"
      : summary.medianResolutionHours < 1
        ? "<1h"
        : Math.round(summary.medianResolutionHours) + "h"

  const ratingLabel = summary.averageRating === null ? "—" : summary.averageRating.toFixed(1) + " / 5"

  return (
    <div className="report-shell" style={{ display: "flex", flexDirection: "column", gap: 22, minWidth: 0 }}>
      <style
        dangerouslySetInnerHTML={{
          __html: [
            // A4 portrait with a 14mm margin on every side. The report shell is
            // authored against a 1280px screen; paper is ~794px wide, and every
            // rule below exists to make the wide layout survive that change.
            "@page { size: A4 portrait; margin: 14mm; }",
            "@media print {",
            "  :root { color-scheme: light; }",
            "  html, body { background: #fff !important; color: #111827 !important; }",
            "  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }",
            "  *, *::before, *::after { box-shadow: none !important; text-shadow: none !important; filter: none !important; -webkit-filter: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; animation: none !important; transition: none !important; }",
            // THE CLIPPING BUG. globals.css sets `body { overflow-x: hidden }`
            // to stop the marketing pages scrolling sideways. In print the
            // report lays out at 1280px while the paper is ~794px, so that
            // hidden overflow CLIPPED every card past the right margin: the
            // PDF showed only the rounded corners and the first letters of
            // each heading. The reset below has to name html and body -- the
            // previous rule reset every OTHER element's overflow and missed
            // the two that were actually clipping.
            "  html, body { overflow: visible !important; }",
            "  header, nav, .no-print, [role='navigation'], [data-print-hidden='true'] { display: none !important; }",
            "  .print-only { display: block !important; }",
            // The console's top bar is a div, so the rule above misses it; the
            // shell's border and padding would frame every sheet.
            "  .adm-topbar { display: none !important; }",
            "  .adm-canvas, .adm-shell, .adm-body { border: 0 !important; padding: 0 !important; margin: 0 !important; border-radius: 0 !important; max-width: none !important; }",
            "  main, .report-shell, section, div, table, tr, td, th { overflow: visible !important; position: static !important; }",
            "  html, body, main, .report-shell { height: auto !important; max-height: none !important; }",
            "  main { padding: 0 !important; max-width: none !important; margin: 0 !important; width: auto !important; }",
            "  body, div, section, table, tr, td, th { background: #fff !important; color: #111827 !important; }",
            "  a { text-decoration: none !important; color: inherit !important; }",
            // CONTINUOUS FLOW. The old rule made every top-level <section>
            // break-inside: avoid, and since a section is taller than a page
            // that forced one section per sheet -- five half-empty pages. The
            // sections flow now; the CARDS inside them carry break-inside:
            // avoid so a single tile is never split, and headings carry
            // break-after: avoid so a heading is never left alone at a foot.
            // TWO COLUMNS ON PAPER, SECTION BY SECTION.
            // The report is a 3-column auto-fit grid on screen; on paper it is
            // two columns, which is what ~794px of A4 holds. The columns are a
            // real CSS GRID per section, NOT one whole-document multi-column: a
            // grid stays within its own section, whereas a document-wide
            // multi-column split the tall "Listings by category" card across
            // the column gutter and let its rows collide with the cards beside
            // it. Sections still FLOW (no break after a section) so the sheets
            // fill rather than one section per page.
            "  .report-shell { max-width: 100% !important; display: block !important; gap: 6px !important; }",
            "  .report-shell > section { display: block !important; break-inside: auto !important; page-break-inside: auto !important; break-after: auto !important; page-break-after: auto !important; }",
            "  .report-shell > section > h2 { break-after: avoid !important; page-break-after: avoid !important; margin-bottom: 5px !important; }",
            // Each section is its own two-column grid, and the card is the
            // atomic unit: break-inside: avoid so a tile or a table row is never
            // split.
            // SIX TRACKS, so two widths share one grid: a chart spans three
            // (two across) and a number tile spans two (three across). With
            // tiles and charts both at half width, a short tile sat beside a
            // tall chart and left a hole under it on every sheet. A tile that
            // is alone ahead of its section's charts becomes a full-width
            // strip instead of a third of a row. The trend chart's inline
            // `grid-column: 1 / -1` still wins over the un-!important span.
            "  .report-grid { display: grid !important; grid-template-columns: repeat(6, minmax(0, 1fr)) !important; gap: 8px !important; align-items: start !important; }",
            "  .report-grid > * { grid-column: span 3; }",
            "  .report-grid > .report-tile { grid-column: span 2 !important; }",
            // ...and that strip is ONE LINE (label, number, hint side by side).
            // Stacked, it was a tall, mostly empty card; the height it wasted
            // was what pushed the section's charts onto the next sheet and
            // left the rest of this one blank.
            "  .report-grid > .report-tile:first-child:has(+ :not(.report-tile)) { grid-column: 1 / -1 !important; display: flex !important; align-items: baseline !important; gap: 10px !important; padding: 6px 10px !important; }",
            "  .report-grid > .report-tile:first-child:has(+ :not(.report-tile)) > div { margin-top: 0 !important; }",
            "  .report-grid > .report-donut-chart { grid-column: 1 / -1 !important; }",
            "  .report-tile-value { font-size: 22px !important; margin-top: 2px !important; }",
            "  .report-tile > div:last-child { margin-top: 2px !important; font-size: 10px !important; }",
            "  .report-grid > * { padding: 8px !important; min-width: 0 !important; break-inside: avoid !important; page-break-inside: avoid !important; }",
            // A RANK TABLE NEEDS THE WHOLE WIDTH. Four columns ("Hub", "Type",
            // "State", "Meetups") in one ~294px half-column is unreadably
            // cramped even when it does not overflow. On paper the table cards
            // span both columns and get the full ~700px.
            "  .report-grid > section:has(table) { grid-column: 1 / -1 !important; }",
            "  .report-shell h1 { font-size: 20px !important; }",
            "  .report-shell { line-height: 1.4 !important; }",
            "  .report-head p { margin-top: 2px !important; line-height: 1.45 !important; }",
            // COMPACTION. The bars are the tallest thing on the page; a slimmer
            // track and tighter row gap is what keeps the report inside three
            // sheets without dropping a single figure.
            "  .report-grid span[role='img'] { height: 7px !important; }",
            "  .report-grid p { font-size: 9.5px !important; line-height: 1.28 !important; margin-top: 1px !important; }",
            "  .report-grid h2 { font-size: 12.5px !important; margin-bottom: 3px !important; }",
            "  .report-grid > section > div { gap: 2px !important; margin-top: 4px !important; }",
            "  .report-grid section > div > div { line-height: 1.15 !important; }",
            // BAR ROWS IN A HALF-COLUMN. A bar row is [label | track | value]
            // with the label pinned to a fixed 150px (LABEL_WIDTH in
            // ReportCharts). At full width that is fine; in a ~290px print
            // column it ate the whole row, collapsing the track and pushing the
            // value on top of the label. Pin the label narrower in print so the
            // track keeps room.
            "  .report-grid [role='img'] { min-width: 40px !important; }",
            "  .report-grid section > div > div > span:first-child { width: 92px !important; white-space: normal !important; overflow: visible !important; text-overflow: clip !important; }",
            // TrendChart / DonutChart in print. Both size themselves off a
            // fixed viewBox scaled by CSS width (the same percentage-safe
            // shape the bar tracks use, see ReportCharts.tsx's file header),
            // so shrinking them for the narrow print column is a CSS height
            // override, not a layout change -- nothing about the SVG's own
            // coordinate system needs to know it's printing.
            "  .report-trend-chart svg { height: 115px !important; }",
            "  .report-column-plot { height: 90px !important; }",
            // ColumnChart opts out of the BarChart row rules above: its bars
            // are flex shares of the plot and its labels sit under them. It
            // also needs its positioning back -- the blanket
            // `div { position: static }` reset above otherwise drops the axis
            // labels in the page corner and collapses the plot -- and room
            // above the plot for the value printed over the tallest bar.
            "  .report-grid .report-column-plot { position: relative !important; }",
            "  .report-grid .report-column-plot > div { position: absolute !important; }",
            "  .report-grid > section.report-column-chart > div { margin-top: 18px !important; }",
            "  .report-grid .report-column-chart [role='img'] { min-width: 0 !important; }",
            "  .report-grid section.report-column-chart > div > div > span:first-child { width: auto !important; }",
            "  .report-trend-chart text { font-size: 15px !important; }",
            // Narrow slots on paper: a smaller label keeps "Electronics" on one line.
            "  .report-column-labels span { font-size: 8px !important; }",
            "  .report-column-labels, .report-column-plot > div:last-child { gap: 4px !important; padding: 0 4px !important; }",
            "  .report-donut-chart svg { width: 96px !important; height: 96px !important; }",
            // TABLES IN A HALF-COLUMN. A RankTable cell is white-space: nowrap
            // on screen, which is right when the card is full width. In a
            // ~380px print column that nowrap made the columns overlap each
            // other. Let the cells wrap and shrink once, in print only.
            "  .report-grid table { table-layout: auto !important; width: 100% !important; }",
            "  .report-grid td, .report-grid th { white-space: normal !important; word-break: normal !important; overflow-wrap: anywhere !important; padding: 4px 6px !important; font-size: 10.5px !important; }",
            // THE DESCENDERS. A heading's box is only as tall as its
            // line-height; the old rule tightened headings to 1.22 while the
            // print reset forced overflow: visible, so in print the glyphs
            // below the baseline (the y in "Safety", the g in "Listings")
            // fell outside the box and were sliced. A slightly looser
            // line-height in print gives them room.
            "  h1, h2, h3, h4, h5, h6 { break-after: avoid; page-break-after: avoid; line-height: 1.34 !important; overflow: visible !important; text-overflow: clip !important; white-space: normal !important; }",
            "  table, tbody, thead { break-inside: auto; page-break-inside: auto; }",
            "  tr { break-inside: avoid !important; page-break-inside: avoid !important; }",
            // (report-shell sizing is set once, above)
            "  .report-print-header { display: block !important; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid rgba(17,24,39,.14); }",
            "  .report-print-header p { margin: 0; font-size: 11px; color: #4b5563; line-height: 1.45; }",
            // The masthead repeats "Generated ..." a second time; the print
            // header already carries it, so on paper the duplicate is dropped.
            "  .report-head > div > p:last-child { display: none !important; }",
            "  @supports (font: -apple-system-body) { body { font-synthesis-weight: none; } }",
            "}",
          ].join("\n"),
        }}
      />

      {/* ── Header ──────────────────────────── */}
      <div className="report-print-header" style={{ display: "none" }}>
        <p>
          <strong>Period:</strong> {summary.windowLabel} ({fromLabel} to {toLabel}) · <strong>Generated:</strong> {generatedLabel}
        </p>
      </div>
      <div className="report-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 16, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--adm-text)" }}>Platform reports</h1>
          <p style={{ fontSize: 14, fontWeight: 500, color: "var(--adm-text-secondary)", marginTop: 6, maxWidth: "72ch", lineHeight: 1.6 }}>
            {summary.windowLabel} ({fromLabel} to {toLabel}). Every figure is counted in the database,
            not on this screen.
          </p>
          <p style={{ fontSize: 12, color: "var(--adm-text-muted)", marginTop: 4 }}>Generated {generatedLabel}</p>
        </div>
        <ExportReportButton
          windowLabel={summary.windowLabel}
          generatedAt={generatedLabel}
          from={fromLabel}
          to={toLabel}
        />
      </div>

      {/* ── Filters ─────────────────────────── */}
      <ReportControls
        options={WINDOW_OPTIONS.map((option) => ({ days: option.days, label: option.label }))}
        activeDays={custom ? 0 : days}
        from={reportDateInputValue(summary.from)}
        to={reportDateInputValue(summary.to)}
        max={reportDateInputValue(summary.generatedAt)}
      />

      {/* ── Community ───────────────────────── */}
      <section>
        <h2 style={sectionHeading}>Community</h2>
        <div className="report-grid" style={gridStyle}>
          <StatTile label="Live accounts" value={t.users} hint={t.admins + " admin / staff"} />
          <StatTile label="New accounts" value={t.newUsersInWindow} hint={"registered in " + summary.windowLabel.toLowerCase()} />
          <StatTile label="Suspended now" value={t.suspended} tone={t.suspended > 0 ? "warn" : "default"} hint={t.deleted + " deleted accounts"} />
          <StatTile label="Listings" value={t.listings} hint={t.listingsAvailable + " currently available"} />
          <StatTile label="Hidden listings" value={t.listingsHidden} tone={t.listingsHidden > 0 ? "warn" : "default"} hint="moderator takedowns, all time" />
          <StatTile label="Trades completed" value={t.tradesInWindow} hint={t.tradesCompleted + " all time"} />
        </div>
      </section>

      {/* ── Safety ──────────────────────────── */}
      <section>
        <h2 style={sectionHeading}>Safety and moderation</h2>
        <div className="report-grid" style={gridStyle}>
          <StatTile label="Reports filed" value={t.reportsInWindow} hint={"in " + summary.windowLabel.toLowerCase()} />
          <StatTile label="Reports resolved" value={t.reportsResolvedInWindow} hint={"in " + summary.windowLabel.toLowerCase()} />
          <StatTile
            label="Resolution rate"
            value={summary.resolutionRate === null ? "—" : summary.resolutionRate + "%"}
            tone={summary.resolutionRate !== null && summary.resolutionRate >= 80 ? "good" : "warn"}
            hint="resolved against filed, same period"
          />
          <StatTile label="Median time to resolve" value={resolutionLabel} hint="half are faster than this" />
          <StatTile label="ID checks waiting" value={t.idPending} tone={t.idPending > 0 ? "warn" : "default"} hint={"queue now · " + t.idDecidedInWindow + " decided in period"} />
          <StatTile label="Appeals open" value={t.appealsOpen} tone={t.appealsOpen > 0 ? "warn" : "default"} hint={t.appealsDecidedInWindow + " decided in period"} />
        </div>
      </section>

      {/* ── Trend ───────────────────────────── */}
      <section>
        <h2 style={sectionHeading}>Trend</h2>
        <div className="report-grid" style={gridStyle}>
          <TrendChart
            title="New accounts vs. reports filed, per month"
            caption="Growth against the moderation load it generated -- a falling accent line with a rising dashed one is a ratio worth a second look."
            primary={{ points: summary.usersByMonth, color: "var(--adm-accent)", label: "New accounts" }}
            secondary={{ points: summary.reportsByMonth, color: "var(--adm-accent-2)", label: "Reports filed" }}
          />
          <ColumnChart
            title="Leaf movement per month"
            caption="Total Leaves moved, credits and debits together -- the size of the economy, not the balance of it."
            points={summary.leavesByMonth}
            color={SERIES_COLOR}
          />
          <BarChart
            title="Task completions"
            caption="Rewarded user actions completed in the period, by task."
            points={summary.tasksCompleted}
            color={SERIES_COLOR}
            emptyLabel="No tasks were completed in this period."
          />
        </div>
      </section>

      {/* ── Meetup hubs ─────────────────────── */}
      <section>
        <h2 style={sectionHeading}>Safe-Zone meetups</h2>
        <div className="report-grid" style={gridStyle}>
          <StatTile label="Active hubs" value={t.hubsActive} hint={t.hubsInactive + " inactive"} />
          <ColumnChart
            title="Meetups arranged, by hub type"
            caption="The shape of the answer when somebody asks what kind of place to add next."
            points={summary.hubByType}
            color={INFO_COLOR}
            emptyLabel="No meetups arranged yet."
          />
          <BarChart
            title="Meetups confirmed, by hub"
            caption="Where the parties said they met -- a different column from where they planned to, so confirmed meetups only."
            points={summary.hubClaims}
            color={NEUTRAL_COLOR}
            limit={10}
            emptyLabel="No meetup has been confirmed yet."
          />
        </div>
      </section>

      <section>
        <h2 style={sectionHeading}>Hub ranking and location</h2>
        <div className="report-grid" style={gridStyle}>
          <RankTable
            title="Most chosen hubs"
            caption="Ranked by arranged meetups, all time. 'Inactive' means the hub keeps its listing and trade history but is no longer offered in the picker."
            columns={["Hub", "Type", "State", "Meetups"]}
            rows={summary.topHubs}
            emptyLabel="No hub has been chosen for a meetup yet."
          />
          <RankTable
            title="Cities by meetup activity"
            caption="Where the meetings are happening, which is where the next hub probably belongs."
            columns={["City", "Meetups"]}
            rows={summary.topCities}
            emptyLabel="No meetups have been arranged in any city yet."
          />
        </div>
      </section>

      {/* ── Listings ────────────────────────── */}
      <section>
        <h2 style={sectionHeading}>Listings</h2>
        <div className="report-grid" style={gridStyle}>
          <StatTile label="Posted in period" value={t.listingsInWindow} hint={summary.windowLabel.toLowerCase()} />
          <ColumnChart
            title="Listings by category"
            caption="All time, what the marketplace actually holds."
            points={summary.listingsByCategory}
            color={SERIES_COLOR}
            emptyLabel="No listings have been posted."
          />
          <ColumnChart
            title="Listings by condition"
            caption="All time. A marketplace of nothing but used goods tells you something about the supply."
            points={summary.listingsByCondition}
            color={INFO_COLOR}
            emptyLabel="No listings have been posted."
          />
          <BarChart
            title="Reports by reason"
            caption="Reporters' own category, for reports filed in the period."
            points={summary.reportsByCategory}
            color={WARN_COLOR}
            emptyLabel="No reports were filed in this period."
          />
        </div>
      </section>

      {/* ── Trust ───────────────────────────── */}
      <section>
        <h2 style={sectionHeading}>Trust and quality</h2>
        <div className="report-grid" style={gridStyle}>
          <StatTile
            label="Average trade rating"
            value={ratingLabel}
            tone={summary.averageRating !== null && summary.averageRating >= 4 ? "good" : "warn"}
            hint={summary.reviewsInWindow + " reviews left in period"}
          />
          <StatTile label="ID approvals" value={t.idApprovedInWindow} hint={t.idDecidedInWindow + " decisions in period"} />
          <StatTile label="Appeals overturned" value={t.appealsOverturnedInWindow} hint={t.appealsDecidedInWindow + " decided in period"} />
          <DonutChart
            title="Reports by status"
            caption="All time, not just the period -- how much of the queue is still live."
            points={summary.reportsByStatus}
            emptyLabel="No reports have ever been filed."
          />
        </div>
      </section>

      {/* ── Staff ───────────────────────────── */}
      <section>
        <h2 style={sectionHeading}>Staff activity</h2>
        <div className="report-grid" style={gridStyle}>
          <BarChart
            title="Admin actions"
            caption="Every audit row written in the period, by kind. This is the work the console did."
            points={summary.actionsByKind}
            color={SERIES_COLOR}
            limit={10}
            emptyLabel="No admin actions were taken in this period."
          />
          <RankTable
            title="What each admin did"
            caption="Decisions each admin made in the period, by kind. Read it as workload, not as a ranking of anyone."
            columns={["Admin", "What they did", "Total"]}
            rows={summary.actionsByActor.map((actor) => ({
              key: actor.id,
              cells: [
                actor.name,
                <ul key="breakdown" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4, whiteSpace: "normal" }}>
                  {actor.breakdown.map((kind) => (
                    <li key={kind.label} style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
                      <span>{kind.label}</span>
                      <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--adm-text)" }}>{kind.count.toLocaleString()}</span>
                    </li>
                  ))}
                </ul>,
                actor.count,
              ],
            }))}
            emptyLabel="No admin actions were taken in this period."
          />
        </div>
      </section>

      <p style={{ fontSize: 12, color: "var(--adm-text-muted)", lineHeight: 1.6 }}>
        Read-only report. Nothing on this page changes a record, so nothing here writes an audit
        row. Open queues and all-time totals do not move with the period selector; everything else
        does. The figures are live as of {generatedLabel} and will differ if the page is reloaded.
      </p>
    </div>
  )
}

const sectionHeading: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  marginBottom: 14,
  lineHeight: 1.25,
  breakAfter: "avoid",
  pageBreakAfter: "avoid",
  overflow: "visible",
  color: "var(--adm-text)",
}

/**
 * minmax(min(100%, 330px), 1fr) rather than a plain minimum: without the
 * 100% floor a wide child can push a grid column past its share and overflow
 * the page, which is part of what the charts did before they were made fluid.
 */
const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 330px), 1fr))",
  gap: 12,
}
