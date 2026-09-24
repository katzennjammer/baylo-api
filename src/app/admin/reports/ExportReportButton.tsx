"use client"

import { useEffect } from "react"

/**
 * Export the report as a PDF, carrying the current filter.
 *
 * ── WHY window.print() AND NOT A PDF LIBRARY ─────────────────
 *
 * There is no PDF writer in this project, and adding one would mean generating
 * the whole report a second time -- once as JSX, once as drawing commands --
 * with the two renderings free to disagree. The browser already has a
 * print-to-PDF engine and a stylesheet, and the @media print rules on the report
 * page exist precisely so what is printed is what is on screen.
 *
 * ── WHY THE FILTER MATTERS HERE ─────────────
 *
 * The window selected is part of the report's identity: "reports for the last
 * 7 days" and "reports for the last 12 months" are different documents. The
 * filter lives in the URL, and the printed page carries a header naming the
 * period and the generation time, so a printed copy cannot be mistaken for a
 * different window than the one on screen.
 *
 * The honest trade-off: the user goes through the browser's print dialog and
 * chooses "Save as PDF". That is one more click than a direct download, and in
 * exchange the export cannot drift from the page, and the console gains no
 * server-side PDF dependency.
 */
export default function ExportReportButton({
  windowLabel,
  generatedAt,
  from,
  to,
}: {
  windowLabel: string
  generatedAt: string
  from: string
  to: string
}) {
  useEffect(() => {
    const beforePrint = () => {
      const previousTitle = document.title
      document.title = `Baylo overall report - ${from} to ${to}`
      ;(window as Window & { __bayloReportTitle?: string }).__bayloReportTitle = previousTitle
    }

    const afterPrint = () => {
      const previousTitle = (window as Window & { __bayloReportTitle?: string }).__bayloReportTitle
      document.title = previousTitle ?? "Baylo"
      delete (window as Window & { __bayloReportTitle?: string }).__bayloReportTitle
    }

    window.addEventListener("beforeprint", beforePrint)
    window.addEventListener("afterprint", afterPrint)

    return () => {
      window.removeEventListener("beforeprint", beforePrint)
      window.removeEventListener("afterprint", afterPrint)
    }
  }, [from, to])

  return (
    <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <button
        type="button"
        onClick={() => window.print()}
        className="admin-btn-press"
        style={{
          padding: "12px 22px",
          border: 0,
          borderRadius: 999,
          background: "var(--adm-accent)",
          color: "var(--adm-text-on-accent)",
          fontWeight: 700,
          fontSize: 14,
          cursor: "pointer",
        }}
      >
        Export as PDF
      </button>
      <div style={{ fontSize: 11, color: "var(--adm-text-muted)", lineHeight: 1.4 }}>
        Turn off “Headers and footers” in the print dialog.
      </div>
      {/* Print-only header. Invisible on screen, and the first thing on the
          printed page, so an exported report names its own period. */}
      <div className="print-only" style={{ display: "none" }}>
        <p style={{ fontSize: 11, color: "#555" }}>
          Period: {windowLabel} ({from} to {to}) · Generated {generatedAt}
        </p>
      </div>
    </div>
  )
}
