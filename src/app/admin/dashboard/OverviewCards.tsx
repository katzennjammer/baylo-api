"use client"

import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { StaggerGroup, StaggerItem } from "@/components/admin/Stagger"
import { CountUp } from "@/components/admin/CountUp"
import { PulsingDot } from "@/components/admin/PulsingDot"

export interface OverviewMetric {
  label: string
  value: number
  href: string
  /**
   * "queue"   -- somebody is waiting on this; gets an amber accent and, once
   *              non-zero, a pulsing dot.
   * "warn"    -- a current negative state (suspended, hidden, inactive);
   *              red accent, no dot -- it is not a queue to clear.
   * "good"    -- more is fine or positive (active achievements); green
   *              accent, no dot.
   */
  tone: "queue" | "warn" | "good"
}

const TONE_COLOR: Record<OverviewMetric["tone"], string> = {
  queue: "var(--adm-queue)",
  warn: "var(--adm-warn)",
  good: "var(--adm-good)",
}

export function OverviewCards({ metrics }: { metrics: OverviewMetric[] }) {
  return (
    <StaggerGroup as="div" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 12 }}>
      {metrics.map((metric, index) => {
        const active = metric.value > 0
        const accent = active ? TONE_COLOR[metric.tone] : "var(--adm-good)"
        return (
          <StaggerItem as="div" index={index} key={metric.label}>
            <Link
              href={metric.href}
              className="adm-lift adm-press"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 14,
                background: "var(--adm-panel)",
                border: "1px solid var(--adm-border)",
                borderRadius: "var(--adm-radius-panel)",
                padding: "20px 22px",
                textDecoration: "none",
                color: "var(--adm-text)",
                minWidth: 0,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span
                  style={{
                    color: "var(--adm-text-muted)",
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {metric.label}
                </span>
                {active && metric.tone === "queue" ? (
                  <PulsingDot color={accent} />
                ) : (
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: accent, flexShrink: 0 }} aria-hidden="true" />
                )}
              </div>
              <div style={{ fontSize: 44, fontWeight: 700, letterSpacing: "-0.03em", color: "var(--adm-text)", fontVariantNumeric: "tabular-nums" }}>
                <CountUp value={metric.value} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--adm-accent-text)", fontSize: 13, fontWeight: 600 }}>
                View queue <ArrowRight size={14} aria-hidden="true" />
              </div>
            </Link>
          </StaggerItem>
        )
      })}
    </StaggerGroup>
  )
}
