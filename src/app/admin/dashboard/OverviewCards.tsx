"use client"

import Link from "next/link"
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
  queue: "#b45309",
  warn: "#b91c1c",
  good: "#1f6b43",
}

export function OverviewCards({ metrics }: { metrics: OverviewMetric[] }) {
  return (
    <StaggerGroup as="div" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
      {metrics.map((metric, index) => {
        const active = metric.value > 0
        const accent = active ? TONE_COLOR[metric.tone] : "#c7cdc9"
        return (
          <StaggerItem as="div" index={index} key={metric.label}>
            <Link
              href={metric.href}
              className="admin-card-hover"
              style={{
                display: "block",
                background: "#fff",
                border: "1px solid rgba(0,0,0,.08)",
                borderLeft: `3px solid ${accent}`,
                borderRadius: 14,
                padding: 18,
                textDecoration: "none",
                color: "#17201b",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#77827b", fontSize: 12, fontWeight: 700 }}>
                {metric.label}
                {active && metric.tone === "queue" ? <PulsingDot color={accent} /> : null}
              </div>
              <div style={{ fontSize: 30, fontWeight: 800, marginTop: 8, color: active ? accent : "#17201b" }}>
                <CountUp value={metric.value} />
              </div>
              <div style={{ color: "#4CAF50", fontSize: 12, marginTop: 8 }}>View queue →</div>
            </Link>
          </StaggerItem>
        )
      })}
    </StaggerGroup>
  )
}
