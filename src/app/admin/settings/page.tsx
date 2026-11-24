import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { auth } from "@root/auth"
import prisma from "@/lib/prisma"
import { normaliseWindowDays, WINDOW_OPTIONS } from "@/lib/admin-reports"
import { DEFAULT_LANDING, LANDING_COOKIE, LANDING_OPTIONS, REPORT_DAYS_COOKIE } from "../pref-keys"
import SettingsForm from "./SettingsForm"

export const dynamic = "force-dynamic"

export default async function AdminSettingsPage() {
  const session = await auth()
  if (!session?.user?.id) redirect("/auth/login?callbackUrl=/admin/settings")
  const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { email: true, password: true } })

  const store = await cookies()
  const landing = LANDING_OPTIONS.find((option) => option.href === store.get(LANDING_COOKIE)?.value)?.href ?? DEFAULT_LANDING

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28, maxWidth: 760 }}>
      <div>
        <h1 style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--adm-text)" }}>Settings</h1>
        <p style={{ fontSize: 14, fontWeight: 500, color: "var(--adm-text-secondary)", marginTop: 6, lineHeight: 1.6 }}>
          Your own preferences for this console. They are saved in this browser and change nothing for other admins or for Baylo users.
        </p>
      </div>
      <SettingsForm
        email={me?.email ?? ""}
        hasPassword={!!me?.password}
        landing={landing}
        landingOptions={LANDING_OPTIONS.map((option) => ({ value: option.href, label: option.label }))}
        reportDays={normaliseWindowDays(store.get(REPORT_DAYS_COOKIE)?.value)}
        reportOptions={WINDOW_OPTIONS.map((option) => ({ value: String(option.days), label: option.label }))}
      />
    </div>
  )
}
