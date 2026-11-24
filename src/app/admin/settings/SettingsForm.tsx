"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import toast from "react-hot-toast"
import { DENSITY_KEY, LANDING_COOKIE, REPORT_DAYS_COOKIE, THEME_KEY } from "../pref-keys"
import { usePref, writePref, writePrefCookie } from "../prefs"

interface Option {
  value: string
  label: string
}

/** One device signed in to the Baylo app, as GET /api/v1/sessions returns it. */
interface Device {
  id: string
  signedInAt: string
  lastActiveAt: string
}

const panel: React.CSSProperties = {
  background: "var(--adm-panel)",
  border: "1px solid var(--adm-border)",
  borderRadius: "var(--adm-radius-panel)",
  padding: 24,
}
const panelTitle: React.CSSProperties = { fontSize: 16, fontWeight: 700, color: "var(--adm-text)" }
const hint: React.CSSProperties = { fontSize: 13, color: "var(--adm-text-muted)", marginTop: 4, lineHeight: 1.5 }
const row: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap", padding: "14px 0", borderTop: "1px solid var(--adm-divider)" }
const rowLabel: React.CSSProperties = { fontSize: 14, fontWeight: 600, color: "var(--adm-text)" }
const field: React.CSSProperties = {
  border: "1px solid var(--adm-border-input)",
  borderRadius: "var(--adm-radius-input)",
  padding: "8px 12px",
  fontSize: 13,
  fontFamily: "inherit",
}
const button: React.CSSProperties = {
  ...field,
  background: "var(--adm-accent)",
  color: "var(--adm-text-on-accent)",
  border: 0,
  fontWeight: 700,
  cursor: "pointer",
}

/** A small set of mutually exclusive choices, as native radios in a pill row. */
function Choice({ name, value, options, onChange, local }: { name: string; value: string; options: Option[]; onChange: (value: string) => void; local?: boolean }) {
  // `local` choices live in localStorage, which the server can't read, so its
  // HTML marks the default. Hide them until hydrated rather than show a wrong one.
  const hydrated = useSyncExternalStore(() => () => {}, () => true, () => false)
  return (
    <div role="radiogroup" style={{ display: "flex", gap: 6, flexWrap: "wrap", visibility: local && !hydrated ? "hidden" : undefined }}>
      {options.map((option) => {
        const active = option.value === value
        return (
          <label
            key={option.value}
            style={{
              padding: "7px 14px",
              borderRadius: 999,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              border: "1px solid " + (active ? "var(--adm-accent-soft)" : "var(--adm-border-chip)"),
              background: active ? "var(--adm-accent-soft)" : "transparent",
              color: active ? "var(--adm-text-on-soft)" : "var(--adm-text)",
            }}
          >
            {/* Visually hidden, still focusable: arrow keys move between options. */}
            <input
              type="radio"
              name={name}
              checked={active}
              onChange={() => onChange(option.value)}
              style={{ position: "absolute", opacity: 0, width: 1, height: 1 }}
            />
            {option.label}
          </label>
        )
      })}
    </div>
  )
}

export default function SettingsForm({
  email,
  hasPassword,
  landing,
  landingOptions,
  reportDays,
  reportOptions,
}: {
  email: string
  hasPassword: boolean
  landing: string
  landingOptions: Option[]
  reportDays: number
  reportOptions: Option[]
}) {
  const theme = usePref(THEME_KEY, "dark")
  const density = usePref(DENSITY_KEY, "comfortable")
  // The cookie-backed choices came from the server; mirrored here so the
  // control moves as soon as it is changed.
  const [landingChoice, setLandingChoice] = useState(landing)
  const [daysChoice, setDaysChoice] = useState(String(reportDays))

  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [saving, setSaving] = useState(false)

  const [devices, setDevices] = useState<Device[] | null>(null)
  const [devicesError, setDevicesError] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch("/api/v1/sessions")
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((payload) => {
        if (!cancelled) setDevices(payload?.data?.sessions ?? [])
      })
      .catch(() => {
        if (!cancelled) setDevicesError(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function changePassword(event: React.FormEvent) {
    event.preventDefault()
    if (newPassword !== confirmPassword) {
      toast.error("The two new passwords don't match.")
      return
    }
    setSaving(true)
    try {
      const response = await fetch("/api/user", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(hasPassword ? { currentPassword } : {}), newPassword }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(typeof payload?.error === "string" ? payload.error : "The password was not changed.")
        return
      }
      toast.success("Password changed. Other devices were signed out.")
      setCurrentPassword("")
      setNewPassword("")
      setConfirmPassword("")
      // Changing the password signs out every app device, so the list is stale.
      setDevices([])
    } catch {
      toast.error("The password was not changed.")
    } finally {
      setSaving(false)
    }
  }

  async function signOutDevice(id: string) {
    try {
      const response = await fetch(`/api/v1/sessions/${id}`, { method: "DELETE" })
      if (!response.ok) {
        toast.error("That device could not be signed out.")
        return
      }
      setDevices((current) => (current ?? []).filter((device) => device.id !== id))
      toast.success("Device signed out.")
    } catch {
      toast.error("That device could not be signed out.")
    }
  }

  return (
    <>
      <section style={panel}>
        <h2 style={panelTitle}>Appearance</h2>
        <p style={{ ...hint, marginBottom: 14 }}>How the console looks in this browser.</p>
        <div style={row}>
          <span style={rowLabel}>Theme</span>
          <Choice
            name="theme"
            local
            value={theme}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
              { value: "system", label: "Match my computer" },
            ]}
            onChange={(value) => writePref(THEME_KEY, value)}
          />
        </div>
        <div style={row}>
          <span>
            <span style={{ ...rowLabel, display: "block" }}>Row spacing</span>
            <span style={{ ...hint, display: "block" }}>Compact fits more table rows on screen.</span>
          </span>
          <Choice
            name="density"
            local
            value={density}
            options={[
              { value: "comfortable", label: "Comfortable" },
              { value: "compact", label: "Compact" },
            ]}
            onChange={(value) => writePref(DENSITY_KEY, value)}
          />
        </div>
      </section>

      <section style={panel}>
        <h2 style={panelTitle}>Defaults</h2>
        <p style={{ ...hint, marginBottom: 14 }}>What you see first.</p>
        <div style={row}>
          <label htmlFor="settings-landing">
            <span style={{ ...rowLabel, display: "block" }}>Landing page</span>
            <span style={{ ...hint, display: "block" }}>Where the console opens after you sign in, and where the Baylo logo takes you.</span>
          </label>
          <select
            id="settings-landing"
            value={landingChoice}
            onChange={(event) => {
              setLandingChoice(event.target.value)
              writePrefCookie(LANDING_COOKIE, event.target.value)
              toast.success("Landing page saved.")
            }}
            style={field}
          >
            {landingOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div style={row}>
          <label htmlFor="settings-period">
            <span style={{ ...rowLabel, display: "block" }}>Platform reports period</span>
            <span style={{ ...hint, display: "block" }}>The period the report opens on. You can still change it on the page.</span>
          </label>
          <select
            id="settings-period"
            value={daysChoice}
            onChange={(event) => {
              setDaysChoice(event.target.value)
              writePrefCookie(REPORT_DAYS_COOKIE, event.target.value)
              toast.success("Default period saved.")
            }}
            style={field}
          >
            {reportOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section style={panel}>
        <h2 style={panelTitle}>Password</h2>
        <p style={hint}>
          Signed in as {email}. {hasPassword ? "Changing your password signs you out of the Baylo app on every device." : "Your account signs in with Google. Setting a password also lets you sign in with your email."}
        </p>
        <form onSubmit={changePassword} style={{ display: "grid", gap: 12, marginTop: 16, maxWidth: 360 }}>
          {hasPassword ? (
            <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 600, color: "var(--adm-text-secondary)" }}>
              Current password
              <input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required style={field} />
            </label>
          ) : null}
          <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 600, color: "var(--adm-text-secondary)" }}>
            New password
            <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={8} required style={field} />
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 600, color: "var(--adm-text-secondary)" }}>
            Confirm new password
            <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={8} required style={field} />
          </label>
          <button type="submit" disabled={saving} className="admin-btn-press" style={{ ...button, justifySelf: "start", opacity: saving ? 0.6 : 1 }}>
            {saving ? "Saving…" : hasPassword ? "Change password" : "Set password"}
          </button>
        </form>
      </section>

      <section style={panel}>
        <h2 style={panelTitle}>App devices</h2>
        <p style={{ ...hint, marginBottom: 14 }}>
          Phones and tablets where this account is signed in to the Baylo app. This browser is not listed; use Sign out in the account menu to end it.
        </p>
        {devicesError ? (
          <p style={hint}>The device list could not be loaded.</p>
        ) : devices === null ? (
          <p style={hint}>Loading…</p>
        ) : devices.length === 0 ? (
          <p style={hint}>This account is not signed in to the app on any device.</p>
        ) : (
          devices.map((device) => (
            <div key={device.id} style={row}>
              <span>
                <span style={{ ...rowLabel, display: "block" }}>Signed in {new Date(device.signedInAt).toLocaleDateString()}</span>
                <span style={{ ...hint, display: "block" }}>Last active {new Date(device.lastActiveAt).toLocaleString()}</span>
              </span>
              <button
                type="button"
                onClick={() => signOutDevice(device.id)}
                className="admin-btn-press"
                style={{ ...field, background: "transparent", color: "var(--adm-warn)", border: "1px solid var(--adm-warn-outline)", fontWeight: 700, cursor: "pointer" }}
              >
                Sign out
              </button>
            </div>
          ))
        )}
      </section>
    </>
  )
}
