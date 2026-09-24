"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { motion } from "framer-motion"

const LINKS = [
  { href: "/admin/dashboard", label: "Overview" },
  { href: "/admin/reports", label: "Overall report" },
  { href: "/admin", label: "Reports" },
  { href: "/admin/id-verification", label: "ID checks" },
  { href: "/admin/review-queue", label: "Review queue" },
  { href: "/admin/appeals", label: "Appeals" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/listings", label: "Listings" },
  { href: "/admin/hubs", label: "Hubs" },
  { href: "/admin/achievements", label: "Achievements" },
  { href: "/admin/audit", label: "Audit log" },
  { href: "/admin/access", label: "Access" },
]

// Longest href first, so a nested route like /admin/id-verification/xyz
// matches the specific "ID checks" link before the "/admin" root link (which
// would otherwise prefix-match everything under /admin).
const BY_SPECIFICITY = [...LINKS].sort((a, b) => b.href.length - a.href.length)

export default function AdminNav() {
  const pathname = usePathname()
  const active = BY_SPECIFICITY.find((link) => pathname === link.href || pathname.startsWith(link.href + "/"))

  return (
    <nav aria-label="Admin navigation" style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, height: "100%", overflowX: "auto" }}>
      {LINKS.map((link) => {
        const isActive = active?.href === link.href
        return (
          <Link key={link.href} href={link.href} className="admin-nav-link" data-active={isActive}>
            {link.label}
            {isActive ? (
              <motion.span
                layoutId="admin-nav-underline"
                className="admin-nav-underline"
                transition={{ type: "spring", stiffness: 500, damping: 40 }}
              />
            ) : null}
          </Link>
        )
      })}
    </nav>
  )
}
