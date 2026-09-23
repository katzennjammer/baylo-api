"use client"

import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { motion } from "framer-motion"

/**
 * A row of filter pills whose active background slides between chips
 * (Framer Motion layoutId) instead of popping.
 *
 * `active` is computed client-side from the CURRENT URL's search params
 * rather than trusted as a prop from the server-rendered page, because
 * Next.js updates the address bar (and therefore useSearchParams()) as soon
 * as the Link navigation starts -- well before the server component's new
 * data streams back. That gap is exactly what makes a chip's active state
 * show up immediately on click instead of waiting for the filtered rows.
 *
 * Each option's href already carries the FULL resulting query string (every
 * page here builds it that way), so "this option is the current state" is
 * just "this option's query string equals the current one" -- no per-field
 * comparison needed, and it works whether the page has one filter axis or
 * several running side by side.
 */
export interface ChipOption {
  key: string
  label: string
  href: string
}

export function FilterChips({
  groupId,
  options,
}: {
  /** Unique per filter axis on a page (e.g. "status", "role") -- scopes the sliding pill to its own row. */
  groupId: string
  options: ChipOption[]
}) {
  const searchParams = useSearchParams()
  const current = searchParams.toString()

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      {options.map((option) => {
        const target = option.href.includes("?") ? option.href.slice(option.href.indexOf("?") + 1) : ""
        const active = target === current
        return (
          <Link key={option.key} href={option.href} scroll={false} className="admin-chip" data-active={active}>
            {active ? (
              <motion.span
                layoutId={`chip-pill-${groupId}`}
                className="admin-chip-pill"
                transition={{ type: "spring", stiffness: 500, damping: 40, mass: 0.6 }}
              />
            ) : null}
            <span className="admin-chip-label">{option.label}</span>
          </Link>
        )
      })}
    </div>
  )
}
