"use client"

import dynamic from "next/dynamic"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import toast from "react-hot-toast"

const HubLocationPicker = dynamic(() => import("./HubLocationPicker"), { ssr: false })

const TYPES = ["MALL", "BARANGAY_HALL", "POLICE_STATION", "PUBLIC_PLAZA", "TRANSPORT_HUB"] as const

type Hub = {
  id?: string
  name: string
  type: (typeof TYPES)[number]
  address: string
  city: string
  landmark: string
  latitude: number
  longitude: number
  isActive: boolean
}

type SearchCandidate = {
  id: string
  label: string
  latitude: number
  longitude: number
  type: string
  city: string
  address: string
}

export default function HubForm({ initial }: { initial?: Hub }) {
  const router = useRouter()
  const [open, setOpen] = useState(Boolean(initial))
  const [form, setForm] = useState<Hub>(initial ?? {
    name: "", type: "MALL", address: "", city: "", landmark: "",
    latitude: 0, longitude: 0, isActive: true,
  })
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState("")
  const [searchRequest, setSearchRequest] = useState(0)
  const [searching, setSearching] = useState(false)
  const [candidates, setCandidates] = useState<SearchCandidate[]>([])

  function update<K extends keyof Hub>(key: K, value: Hub[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function searchLocation() {
    if (search.trim().length < 3) {
      toast.error("Enter at least 3 characters to search.")
      return
    }
    setSearching(true)
    try {
      const response = await fetch(`/api/admin/hubs/geocode?q=${encodeURIComponent(search.trim())}`)
      const payload = await response.json()
      if (!response.ok) {
        toast.error(payload?.error?.message ?? "Location search failed.")
        return
      }
      const next = payload?.data?.candidates
      setCandidates(Array.isArray(next) ? next : [])
      if (!next?.length) toast.error("No Philippine locations matched that search.")
    } catch {
      toast.error("Location search failed. Enter coordinates manually.")
    } finally {
      setSearching(false)
    }
  }

  function chooseLocation(candidate: SearchCandidate) {
    setForm((current) => ({
      ...current,
      address: candidate.address || candidate.label,
      city: candidate.city || current.city,
      latitude: candidate.latitude,
      longitude: candidate.longitude,
    }))
    setCandidates([])
    toast.success("Coordinates filled. Confirm the pin before saving.")
  }

  useEffect(() => {
    if (!open || search.trim().length < 3) {
      setCandidates([])
      return
    }

    const timer = window.setTimeout(() => {
      void searchLocation()
    }, 1_000)

    return () => window.clearTimeout(timer)
    // Search is deliberately debounced and only starts after three characters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, open, searchRequest])

  async function submit() {
    if (!reason.trim()) {
      toast.error("A reason is required.")
      return
    }
    setBusy(true)
    try {
      const requestBody = {
        name: form.name,
        type: form.type,
        address: form.address,
        city: form.city,
        landmark: form.landmark,
        latitude: form.latitude,
        longitude: form.longitude,
        ...(initial ? { isActive: form.isActive } : {}),
        reason,
      }
      const response = await fetch(initial ? `/api/admin/hubs/${initial.id}` : "/api/admin/hubs", {
        method: initial ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      })
      const payload = await response.json()
      if (!response.ok) {
        toast.error(payload?.error?.message ?? "That action failed.")
        return
      }
      toast.success(initial ? "Hub updated." : "Hub created.")
      setReason("")
      setOpen(false)
      router.refresh()
    } catch {
      toast.error("That action failed.")
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} style={{ padding: "9px 14px", border: 0, borderRadius: 9, background: "#17201b", color: "#fff", fontWeight: 700 }}>
        {initial ? "Edit" : "Create hub"}
      </button>
    )
  }

  return (
    <div style={{ display: "grid", gap: 8, padding: 14, borderRadius: 10, background: "#f7f9f7", minWidth: 320 }}>
      <input value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="Name" style={input} />
      <select value={form.type} onChange={(e) => update("type", e.target.value as Hub["type"])} style={input}>
        {TYPES.map((type) => <option key={type} value={type}>{type.replace("_", " ")}</option>)}
      </select>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search place in the Philippines"
          style={{ ...input, flex: 1 }}
        />
        <button type="button" onClick={() => setSearchRequest((value) => value + 1)} disabled={searching} style={button}>
          {searching ? "Searching…" : "Find"}
        </button>
      </div>
      {candidates.length > 0 && (
        <div style={{ display: "grid", gap: 6, padding: 8, borderRadius: 8, background: "#fff", border: "1px solid rgba(0,0,0,.10)" }}>
          <small style={{ color: "#666" }}>Choose the exact result, then verify the pin and landmark.</small>
          {candidates.map((candidate) => (
            <div key={candidate.id} style={{ display: "grid", gap: 4 }}>
              <button
                type="button"
                onClick={() => chooseLocation(candidate)}
                style={{ ...button, textAlign: "left", fontWeight: 500 }}
              >
                <span style={{ display: "block" }}>{candidate.label}</span>
                <span style={{ display: "block", marginTop: 3, color: "#777", fontSize: 11 }}>
                  {candidate.latitude.toFixed(5)}, {candidate.longitude.toFixed(5)} · OpenStreetMap
                </span>
              </button>
            </div>
          ))}
        </div>
      )}
      <input value={form.address} onChange={(e) => update("address", e.target.value)} placeholder="Address" style={input} />
      <input value={form.city} onChange={(e) => update("city", e.target.value)} placeholder="City" style={input} />
      <input value={form.landmark} onChange={(e) => update("landmark", e.target.value)} placeholder="Landmark" style={input} />
      <HubLocationPicker
        latitude={form.latitude}
        longitude={form.longitude}
        hubType={form.type}
        isActive={form.isActive}
        onChange={(latitude, longitude) => {
          update("latitude", latitude)
          update("longitude", longitude)
        }}
      />
      <div style={{ display: "flex", gap: 8 }}>
        <div style={{ ...input, flex: 1, color: "#555" }}>
          <span style={fieldLabel}>Latitude</span>
          {form.latitude === 0 && form.longitude === 0 ? "Not set" : form.latitude.toFixed(8)}
        </div>
        <div style={{ ...input, flex: 1, color: "#555" }}>
          <span style={fieldLabel}>Longitude</span>
          {form.latitude === 0 && form.longitude === 0 ? "Not set" : form.longitude.toFixed(8)}
        </div>
      </div>
      {initial && (
        <label style={{ fontSize: 13 }}>
          <input type="checkbox" checked={form.isActive} onChange={(e) => update("isActive", e.target.checked)} /> Active
        </label>
      )}
      <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason required for the audit log" style={{ ...input, minHeight: 60 }} />
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={submit} disabled={busy} style={{ ...button, background: "#4CAF50" }}>{busy ? "Saving…" : "Save"}</button>
        <button type="button" onClick={() => setOpen(false)} disabled={busy} style={button}>Cancel</button>
      </div>
    </div>
  )
}

const input: React.CSSProperties = { padding: "8px 9px", borderRadius: 7, border: "1px solid rgba(0,0,0,.16)", fontSize: 12, background: "#fff", color: "#111" }
const button: React.CSSProperties = { padding: "8px 12px", border: 0, borderRadius: 7, background: "#e5e7eb", color: "#17201b", fontWeight: 700 }
const fieldLabel: React.CSSProperties = { display: "block", marginBottom: 3, color: "#888", fontSize: 10, textTransform: "uppercase" }
