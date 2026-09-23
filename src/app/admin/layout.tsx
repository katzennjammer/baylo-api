import type { ReactNode } from "react"
import Link from "next/link"
import { redirect } from "next/navigation"
import { Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google"
import { auth } from "@root/auth"
import prisma from "@/lib/prisma"
import { suspensionState } from "@/lib/moderation"
import AccountMenu from "./AccountMenu"
import AdminNav from "./AdminNav"
import "./admin-theme.css"

const admSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-adm-sans",
  display: "swap",
})
const admMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-adm-mono",
  display: "swap",
})

export const dynamic = "force-dynamic"
export const revalidate = 0

/**
 * The /admin shell, and the guard on every page under it.
 *
 * THE ROLE CHECK CANNOT LIVE IN proxy.ts. That file runs in the Next.js proxy
 * (formerly middleware), which has no database access — it can only read the
 * NextAuth JWT, and the JWT does not carry the role. Putting the role in the
 * token would make it a 30-day cached copy of a permission, so a revoked
 * moderator would keep their access until the token expired. proxy.ts therefore
 * does the one thing it can do correctly (bounce a signed-out visitor to the
 * login page) and the real check happens here, against the database, on every
 * request.
 *
 * A LAYOUT GUARD PROTECTS PAGES, NOT DATA. Every /api/admin route calls
 * requireRole() for itself and would 403 a non-staff caller with this file
 * deleted. This is what stops a signed-in ordinary user seeing the moderation
 * UI; the API is what stops them reading the reports.
 *
 * The redirect is to /dashboard, not to a 403 page: an ordinary user who
 * followed a stale link wants to be somewhere useful, and the pages here are
 * not a secret worth an error screen. The API tells the truth with a 403.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await auth()
  if (!session?.user?.id) redirect("/auth/login?callbackUrl=/admin")

  const me = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { role: true, name: true, deletedAt: true, suspendedAt: true, suspendedUntil: true },
  })

  if (!me || me.deletedAt || suspensionState(me).suspended) redirect("/auth/login")
  if (me.role !== "ADMIN") redirect("/dashboard")

  return (
    <div
      className={`admin-root ${admSans.variable} ${admMono.variable}`}
      style={{ minHeight: "100vh", background: "#f4f6f5", color: "#17201b", fontFamily: "var(--ff-body)" }}
    >
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 10,
          background: "rgba(255,255,255,.94)",
          backdropFilter: "blur(16px)",
          borderBottom: "1px solid rgba(23,32,27,.10)",
          padding: "0 28px",
          minHeight: 72,
          display: "flex",
          alignItems: "center",
          gap: 28,
        }}
      >
        <Link href="/admin" style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 190 }}>
          <span style={{ width: 34, height: 34, borderRadius: 10, display: "grid", placeItems: "center", background: "#1f6b43", color: "#fff", fontWeight: 800, fontSize: 17 }}>B</span>
          <span>
            <strong style={{ display: "block", fontSize: 16, letterSpacing: "-.02em" }}>Baylo</strong>
            <span style={{ display: "block", marginTop: 1, fontSize: 10, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", color: "#77827b" }}>Admin console</span>
          </span>
        </Link>
        <AdminNav />
        <AccountMenu name={me.name} role={me.role} />
      </header>
      <main style={{ padding: "34px 28px 56px", maxWidth: 1280, margin: "0 auto" }}>{children}</main>
    </div>
  )
}
