// Names and allowed values of the admin's own preferences. A plain module, NOT
// "use client": server components (the landing redirect, Settings, Platform
// reports) read these, and a value exported from a client module reaches the
// server as an opaque reference rather than the value itself. The hooks that
// read and write the preferences are in prefs.ts.

export const THEME_KEY = "baylo.adm.theme"
export const DENSITY_KEY = "baylo.adm.density"

export const LANDING_COOKIE = "adm_landing"
export const REPORT_DAYS_COOKIE = "adm_report_days"

/** The only pages a landing preference may name. */
export const LANDING_OPTIONS = [
  { href: "/admin/dashboard", label: "Overview" },
  { href: "/admin", label: "User reports" },
  { href: "/admin/id-verification", label: "Documents" },
  { href: "/admin/review-queue", label: "Review queue" },
  { href: "/admin/appeals", label: "Appeals" },
] as const
export const DEFAULT_LANDING = "/admin/dashboard"
