"use client"

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { motion, useReducedMotion } from "framer-motion"
import {
  LayoutGrid,
  ChartLine,
  Flag,
  IdCard,
  Scale,
  Gavel,
  Users,
  Package,
  MapPin,
  Award,
  ScrollText,
  ShieldCheck,
  Menu,
  X,
  PanelLeft,
  Sun,
  Moon,
  type LucideIcon,
} from "lucide-react"
import AccountMenu from "./AccountMenu"
import RailTooltip from "@/components/admin/primitives/RailTooltip"

// Moved from the old AdminNav.tsx unchanged: hrefs, order, labels and the
// longest-href-first active-matching function. Only the icon field and the
// surrounding markup/styling are new.
const LINKS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/admin/dashboard", label: "Overview", icon: LayoutGrid },
  { href: "/admin/reports", label: "Overall report", icon: ChartLine },
  { href: "/admin", label: "Reports", icon: Flag },
  { href: "/admin/id-verification", label: "ID checks", icon: IdCard },
  { href: "/admin/review-queue", label: "Review queue", icon: Scale },
  { href: "/admin/appeals", label: "Appeals", icon: Gavel },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/listings", label: "Listings", icon: Package },
  { href: "/admin/hubs", label: "Hubs", icon: MapPin },
  { href: "/admin/achievements", label: "Achievements", icon: Award },
  { href: "/admin/audit", label: "Audit log", icon: ScrollText },
  { href: "/admin/access", label: "Access", icon: ShieldCheck },
]

// Longest href first, so a nested route like /admin/id-verification/xyz
// matches the specific "ID checks" link before the "/admin" root link (which
// would otherwise prefix-match everything under /admin).
const BY_SPECIFICITY = [...LINKS].sort((a, b) => b.href.length - a.href.length)

function findActive(pathname: string) {
  return BY_SPECIFICITY.find((link) => pathname === link.href || pathname.startsWith(link.href + "/"))
}

const RAIL_KEY = "baylo.adm.rail"
const RAIL_EVENT = "adm-rail-change"

function subscribeRail(callback: () => void) {
  window.addEventListener("storage", callback)
  window.addEventListener(RAIL_EVENT, callback)
  return () => {
    window.removeEventListener("storage", callback)
    window.removeEventListener(RAIL_EVENT, callback)
  }
}
function getRailSnapshot() {
  try {
    return window.localStorage.getItem(RAIL_KEY) === "1"
  } catch {
    return false
  }
}
function getRailServerSnapshot() {
  return false
}

type Theme = "dark" | "light"
const THEME_KEY = "baylo.adm.theme"
const THEME_EVENT = "adm-theme-change"

function subscribeTheme(callback: () => void) {
  window.addEventListener("storage", callback)
  window.addEventListener(THEME_EVENT, callback)
  return () => {
    window.removeEventListener("storage", callback)
    window.removeEventListener(THEME_EVENT, callback)
  }
}
function getThemeSnapshot(): Theme {
  try {
    return window.localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"
  } catch {
    return "dark"
  }
}
function getThemeServerSnapshot(): Theme {
  return "dark"
}

const railItemBase: React.CSSProperties = {
  position: "relative",
  height: 48,
  borderRadius: 16,
  padding: "0 15px",
  display: "flex",
  alignItems: "center",
  gap: 14,
  color: "var(--adm-text-muted)",
  textDecoration: "none",
  transition: "color 200ms var(--adm-ease-standard)",
}

function RailItem({
  href,
  label,
  Icon,
  active,
  expanded,
  onNavigate,
  itemRef,
}: {
  href: string
  label: string
  Icon: LucideIcon
  active: boolean
  expanded: boolean
  onNavigate?: () => void
  itemRef?: React.Ref<HTMLAnchorElement>
}) {
  const reduce = useReducedMotion()

  const link = (describedById?: string) => (
    <Link
      ref={itemRef}
      href={href}
      onClick={onNavigate}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      aria-describedby={describedById}
      className="adm-press"
      style={{ ...railItemBase, color: active ? "var(--adm-accent-icon-active)" : railItemBase.color }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.color = "var(--adm-text)"
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.color = "var(--adm-text-muted)"
      }}
    >
      {active ? (
        <motion.span
          layoutId="adm-rail-indicator"
          transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 40, mass: 1 }}
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 16,
            background: "var(--adm-accent-tint)",
            boxShadow: "var(--adm-glow-active)",
            zIndex: 0,
          }}
        />
      ) : null}
      <Icon size={20} strokeWidth={2} aria-hidden="true" style={{ flex: "none", position: "relative", zIndex: 1 }} />
      {expanded ? (
        <span style={{ position: "relative", zIndex: 1, fontSize: 14, fontWeight: 600, whiteSpace: "nowrap" }}>
          {label}
        </span>
      ) : null}
    </Link>
  )

  if (expanded) return link()
  return <RailTooltip label={label}>{(id) => link(id)}</RailTooltip>
}

function RailBody({
  pathname,
  expanded,
  onNavigate,
  firstItemRef,
}: {
  pathname: string
  expanded: boolean
  onNavigate?: () => void
  firstItemRef?: React.Ref<HTMLAnchorElement>
}) {
  const active = findActive(pathname)
  return (
    <>
      {LINKS.map((link, i) => (
        <RailItem
          key={link.href}
          href={link.href}
          label={link.label}
          Icon={link.icon}
          active={active?.href === link.href}
          expanded={expanded}
          onNavigate={onNavigate}
          itemRef={i === 0 ? firstItemRef : undefined}
        />
      ))}
    </>
  )
}

export default function AdminShell({
  name,
  role,
  fontVariables,
  children,
}: {
  name: string | null
  role: "ADMIN"
  fontVariables: string
  children: ReactNode
}) {
  const pathname = usePathname()
  const railExpanded = useSyncExternalStore(subscribeRail, getRailSnapshot, getRailServerSnapshot)
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeServerSnapshot)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [lastPathname, setLastPathname] = useState(pathname)

  const hamburgerRef = useRef<HTMLButtonElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)
  const firstDrawerItemRef = useRef<HTMLAnchorElement>(null)

  // Close the drawer on navigation. Adjusting state during render (the
  // React-recommended pattern for "a prop changed, reset derived state")
  // rather than in an effect, so this never fires as a same-render setState
  // loop and never trips react-hooks/set-state-in-effect.
  if (pathname !== lastPathname) {
    setLastPathname(pathname)
    if (drawerOpen) setDrawerOpen(false)
  }

  function toggleTheme() {
    try {
      window.localStorage.setItem(THEME_KEY, theme === "dark" ? "light" : "dark")
      window.dispatchEvent(new Event(THEME_EVENT))
    } catch {
      // localStorage unavailable -- the toggle simply won't persist across reloads.
    }
  }

  function toggleRail() {
    try {
      window.localStorage.setItem(RAIL_KEY, railExpanded ? "0" : "1")
      window.dispatchEvent(new Event(RAIL_EVENT))
    } catch {
      // localStorage unavailable (private mode, disabled storage) -- the
      // toggle simply won't persist across reloads.
    }
  }

  // Escape-to-close, Tab focus trap, focus-on-open, and returning focus to
  // the hamburger on close -- all side effects on an external system (the
  // DOM), so they belong in an effect; none of them call setState directly
  // in the effect body except in response to a real keyboard event.
  useEffect(() => {
    if (!drawerOpen) return
    firstDrawerItemRef.current?.focus()
    const hamburgerButton = hamburgerRef.current

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault()
        setDrawerOpen(false)
        return
      }
      if (e.key === "Tab" && drawerRef.current) {
        const focusables = drawerRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      hamburgerButton?.focus()
    }
  }, [drawerOpen])

  // Body scroll lock while the drawer is open.
  useEffect(() => {
    if (!drawerOpen) return
    const original = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = original
    }
  }, [drawerOpen])

  return (
    <div className={`admin-root ${fontVariables}`} data-theme={theme}>
      <div className="adm-canvas">
        <a href="#adm-main" className="adm-skip-link">
          Skip to content
        </a>
        <div className="adm-shell">
          <div className="adm-topbar">
          <button
            ref={hamburgerRef}
            type="button"
            className="adm-hamburger-btn adm-press"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            aria-controls="adm-drawer"
            style={{
              width: 48,
              height: 48,
              borderRadius: "999px",
              background: "var(--adm-panel-flat)",
              border: "1px solid var(--adm-border-chip)",
              color: "var(--adm-text)",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <Menu size={20} aria-hidden="true" />
          </button>

          <Link
            href="/admin"
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 12,
              marginRight: "auto",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            <span style={{ fontSize: 28, fontWeight: 800, lineHeight: 1, letterSpacing: "-0.03em", color: "var(--adm-text)" }}>
              Baylo
            </span>
            <span
              className="adm-brand-sub"
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: "var(--adm-text-muted)",
              }}
            >
              Admin console
            </span>
          </Link>

          <button
            type="button"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-pressed={theme === "light"}
            className="adm-press"
            style={{
              width: 48,
              height: 48,
              borderRadius: "999px",
              background: "var(--adm-panel-flat)",
              border: "1px solid var(--adm-border-chip)",
              color: "var(--adm-text)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              flex: "none",
            }}
          >
            {theme === "dark" ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
          </button>

          <AccountMenu name={name} role={role} />
        </div>

        <div className="adm-body">
          <nav
            aria-label="Admin sections"
            className="adm-rail-desktop"
            style={{
              width: railExpanded ? 208 : 76,
              flex: "none",
              background: "var(--adm-panel-flat)",
              borderRadius: 28,
              padding: "14px 12px",
              flexDirection: "column",
              gap: 6,
              position: "sticky",
              top: 24,
              zIndex: 10,
              transition: "width 250ms var(--adm-ease-standard)",
            }}
          >
            <RailBody pathname={pathname} expanded={railExpanded} />

            <div style={{ height: 1, background: "var(--adm-divider)", margin: "10px 4px" }} />

            <button
              type="button"
              onClick={toggleRail}
              aria-label={railExpanded ? "Collapse labels" : "Show labels"}
              aria-pressed={railExpanded}
              className="adm-press"
              style={{
                ...railItemBase,
                border: 0,
                background: "transparent",
                cursor: "pointer",
                width: "100%",
              }}
            >
              <PanelLeft size={20} aria-hidden="true" style={{ flex: "none" }} />
              {railExpanded ? <span style={{ fontSize: 14, fontWeight: 600 }}>Collapse</span> : null}
            </button>
          </nav>

          <main id="adm-main" tabIndex={-1} className="adm-main">
            {children}
          </main>
        </div>
      </div>

      {drawerOpen ? (
        <>
          <div
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
            style={{ position: "fixed", inset: 0, background: "var(--adm-scrim)", zIndex: 40 }}
          />
          <nav
            id="adm-drawer"
            ref={drawerRef}
            aria-label="Admin sections"
            style={{
              position: "fixed",
              left: 12,
              top: 12,
              bottom: 12,
              width: 260,
              maxWidth: "calc(100vw - 24px)",
              zIndex: 41,
              background: "var(--adm-panel-flat)",
              borderRadius: 28,
              padding: "16px 12px",
              overflowY: "auto",
              boxShadow: "var(--adm-shadow-overlay)",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close navigation"
              className="adm-press"
              style={{
                alignSelf: "flex-end",
                width: 40,
                height: 40,
                borderRadius: 999,
                background: "rgba(255,255,255,0.06)",
                border: 0,
                color: "var(--adm-text)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                marginBottom: 6,
              }}
            >
              <X size={18} aria-hidden="true" />
            </button>

            <RailBody
              pathname={pathname}
              expanded
              onNavigate={() => setDrawerOpen(false)}
              firstItemRef={firstDrawerItemRef}
            />
          </nav>
        </>
      ) : null}
      </div>
    </div>
  )
}
