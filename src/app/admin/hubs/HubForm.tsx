"use client"

import dynamic from "next/dynamic"
import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import toast from "react-hot-toast"
import {
  NO_COORDINATES_MESSAGE,
  canSaveHub,
  hasCoordinates as coordsAreReal,
} from "./hub-form-rules"
import { Modal } from "@/components/admin/Modal"

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

  /**
   * What "untouched" means, captured ONCE on the first render.
   *
   * This component is not remounted between opens — the admin page renders one
   * per row and Cancel only flips `open` — so the state below survives a close
   * and a reopen. Cancel therefore cannot rely on a fresh mount to lose its
   * edits, and `initial` is the only thing that knows what the form looked like
   * before somebody started typing. Built inside a lazy initialiser so it is a
   * stable object rather than a new one every render (which would make it
   * useless as a dependency and as a comparison target).
   */
  const [initialForm] = useState<Hub>(() =>
    initial ?? {
      name: "", type: "MALL", address: "", city: "", landmark: "",
      latitude: 0, longitude: 0, isActive: true,
    },
  )

  // ALWAYS starts closed, including for an existing hub's edit instance.
  // `useState(Boolean(initial))` used to seed this true for every row that
  // had an `initial` -- i.e. every existing hub -- which hid the "Edit"
  // button behind an already-expanded form on EVERY row, permanently. With
  // one row per hub each carrying a full form (name, type, search, map,
  // lat/lng, reason, buttons) always open, every row rendered at
  // 700-900px tall, which is what actually produced the "too much space" on
  // this page -- not padding, a form nobody asked to see, times every hub.
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<Hub>(initialForm)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState("")
  const [searching, setSearching] = useState(false)
  const [candidates, setCandidates] = useState<SearchCandidate[]>([])

  /**
   * The in-flight geocode request, so the next one can cancel it.
   *
   * A ref rather than state: aborting is a side effect on a resource, not a
   * render input, and putting it in state would re-render the form every time
   * somebody typed a character.
   */
  const searchAbortRef = useRef<AbortController | null>(null)
  /**
   * Which request is the latest, counted up on every search.
   *
   * THE ABORT ALONE IS NOT ENOUGH. abort() only stops a request that has not
   * settled; one that has already resolved — or is already past its last await
   * and queued to continue — still runs the code after it and would still call
   * setCandidates. The counter is what makes the outcome order-independent: a
   * response is applied only if it is from the newest request, so a slow early
   * search can never overwrite a fast later one no matter how the timings fall.
   */
  const searchSeqRef = useRef(0)
  /**
   * Unmount. Flipped in the cleanup so an import or a fetch that resolves after
   * the form closed does not toast, setState, or hold a controller alive.
   */
  const unmountedRef = useRef(false)

  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
      searchAbortRef.current?.abort()
      searchAbortRef.current = null
    }
  }, [])

  /**
   * (0, 0) means "no coordinates", not "a coordinate". The rule and the words
   * come from ./hub-form-rules, which the tests import, so the gate and its
   * test cannot drift apart. The route enforces the same rule server-side — see
   * isNullIsland() in @/lib/safe-zones — because this component is not the only
   * possible caller.
   */
  const hasCoordinates = coordsAreReal(form)

  /**
   * The Save gate: name, address, city and real coordinates. See canSaveHub()
   * for why `landmark` and `reason` are not part of it.
   */
  const canSave = canSaveHub(form)

  function update<K extends keyof Hub>(key: K, value: Hub[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  /**
   * Closing the form returns it to what it was when opened.
   *
   * WHY THIS IS NOT JUST `setOpen(false)`. HubForm stays mounted between opens,
   * so every field it does not reset is still there the next time it is
   * opened — which for `reason` means the audit-log justification from the last
   * edit, pre-filled and one keystroke away from being reused for an unrelated
   * change. An audit log with a copied reason is worse than one with none, so
   * the box is emptied and the fields are rewound on every Cancel, not only on
   * a successful save.
   *
   * The search box goes too: leaving a term in it means reopening the form
   * re-fires the debounced search from the stale effect dependency and repopulates
   * `candidates` with results for text nobody just typed.
   */
  function closeAndReset() {
    searchAbortRef.current?.abort()
    searchAbortRef.current = null
    // Bumping the sequence invalidates anything already in flight, abort or not.
    searchSeqRef.current += 1
    setForm(initialForm)
    setReason("")
    setSearch("")
    setSearching(false)
    setCandidates([])
    setOpen(false)
  }

  /**
   * Runs one geocode search and applies the result ONLY if it is still current.
   *
   * Every path out of this function — success, HTTP error, network throw — has
   * to clean up after itself, because the alternative is a red error toast
   * appearing in answer to a search the user abandoned two keystrokes ago.
   * Aborts are therefore not an error: they are this function being told its
   * answer is no longer wanted, and they return silently.
   */
  async function searchLocation(term: string) {
    if (term.trim().length < 3) {
      toast.error("Enter at least 3 characters to search.")
      return
    }

    // Supersede whatever was running. The old request is aborted, and — more
    // importantly — its sequence number is now behind ours, so if it settles
    // anyway it will find itself stale and do nothing.
    searchAbortRef.current?.abort()
    const controller = new AbortController()
    searchAbortRef.current = controller
    const seq = ++searchSeqRef.current

    /** Only the newest search may touch state, and only while mounted. */
    const isCurrent = () => !unmountedRef.current && seq === searchSeqRef.current

    setSearching(true)
    try {
      const response = await fetch(
        `/api/admin/hubs/geocode?q=${encodeURIComponent(term.trim())}`,
        { signal: controller.signal },
      )
      const payload = await response.json()
      if (!isCurrent()) return
      if (!response.ok) {
        toast.error(payload?.error?.message ?? "Location search failed.")
        return
      }
      const next = payload?.data?.candidates
      setCandidates(Array.isArray(next) ? next : [])
      if (!next?.length) toast.error("No Philippine locations matched that search.")
    } catch (error) {
      // An abort is this search being superseded or the form being closed. It is
      // not a failure, and reporting it as one would put an error toast on
      // screen for a request that worked.
      if (error instanceof DOMException && error.name === "AbortError") return
      if (!isCurrent()) return
      toast.error("Location search failed. Enter coordinates manually.")
    } finally {
      // `searching` guards the Find button, and only the newest search owns it:
      // letting a stale one clear it would re-enable the button mid-search.
      if (isCurrent()) setSearching(false)
      if (searchAbortRef.current === controller) searchAbortRef.current = null
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

  // AUTO-SEARCH WHILE TYPING. Debounced 1s, and only ever for typing — the Find
  // button calls searchLocation() directly. See handleFindClick().
  useEffect(() => {
    if (!open || search.trim().length < 3) {
      setCandidates([])
      // Leaving the input cleared must also cancel a request already in flight
      // for the text that was there a moment ago, or its results land in a box
      // the user has since emptied.
      searchAbortRef.current?.abort()
      searchAbortRef.current = null
      return
    }

    const term = search
    const timer = window.setTimeout(() => {
      void searchLocation(term)
    }, 1_000)

    return () => window.clearTimeout(timer)
    // Search is deliberately debounced and only starts after three characters.
    // searchLocation is intentionally absent: it is redefined every render, so
    // depending on it would restart the timer on each one and the debounce
    // would never fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, open])

  /**
   * The Find button — an explicit act, so it is NOT debounced.
   *
   * It used to increment a counter the debounced effect watched, which meant a
   * deliberate click waited out the same 1s used to avoid firing on every
   * keystroke. The delay exists to guess at when typing has stopped; a click is
   * not a guess, and making somebody wait for a timer they did not start reads
   * as the button being broken. The search runs now, and the pending debounce
   * (if any) is cancelled by the abort inside searchLocation().
   */
  function handleFindClick() {
    void searchLocation(search)
  }

  async function submit() {
    if (!reason.trim()) {
      toast.error("A reason is required.")
      return
    }
    // The client half of the (0, 0) rule. Save is disabled while it is unmet, so
    // this is belt-and-braces for the paths that bypass the button — Enter on a
    // field, a resubmit after the gate changed under the cursor — and it says
    // the same thing the route would, rather than letting a round-trip produce
    // a red toast from the server.
    if (!hasCoordinates) {
      toast.error(NO_COORDINATES_MESSAGE)
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
      closeAndReset()
      router.refresh()
    } catch {
      toast.error("That action failed.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="admin-btn-press" style={{ padding: "9px 14px", border: 0, borderRadius: 9, background: "#17201b", color: "#fff", fontWeight: 700 }}>
          {initial ? "Edit" : "Create hub"}
        </button>
      ) : null}
      {/*
        A centered modal, not an inline Expandable panel. This form used to
        expand INSIDE the table row (or, for "Create hub", inline in the page
        header), which is what capped the map at a table column's width no
        matter how tall globals.css made it. A modal has the whole viewport
        to work with, so the map can actually be the size the admin asked for.
      */}
      <Modal open={open} onClose={closeAndReset}>
        <HubFormPanel
          form={form}
          update={update}
          search={search}
          setSearch={setSearch}
          searching={searching}
          handleFindClick={handleFindClick}
          candidates={candidates}
          chooseLocation={chooseLocation}
          initial={initial}
          reason={reason}
          setReason={setReason}
          busy={busy}
          canSave={canSave}
          submit={submit}
          closeAndReset={closeAndReset}
        />
      </Modal>
    </div>
  )
}

function HubFormPanel({
  form, update, search, setSearch, searching, handleFindClick, candidates, chooseLocation,
  initial, reason, setReason, busy, canSave, submit, closeAndReset,
}: {
  form: Hub
  update: <K extends keyof Hub>(key: K, value: Hub[K]) => void
  search: string
  setSearch: (value: string) => void
  searching: boolean
  handleFindClick: () => void
  candidates: SearchCandidate[]
  chooseLocation: (candidate: SearchCandidate) => void
  initial?: Hub
  reason: string
  setReason: (value: string) => void
  busy: boolean
  canSave: boolean
  submit: () => void
  closeAndReset: () => void
}) {
  return (
    <div
      style={{
        display: "grid", gap: 10, padding: 20, borderRadius: 14,
        background: "#f7f9f7", width: "min(92vw, 560px)",
        boxShadow: "0 24px 60px rgba(15,20,17,.28)",
      }}
    >
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
        <button type="button" onClick={handleFindClick} disabled={searching} className="admin-btn-press" style={button}>
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
        {/*
          Disabled until the four fields a hub cannot be understood without are
          filled: name, address, city, and real coordinates. `reason` is checked
          in submit() rather than here because it is an audit field, not part of
          the hub — the button should be enabled the moment the HUB is valid, and
          the reason is prompted for on click like everywhere else in this tree.

          The `title` is the only affordance explaining WHY it is greyed out;
          without it a disabled button is a dead end, and the (0, 0) case in
          particular looks like coordinates are set when they are not.
        */}
        <button
          type="button"
          onClick={submit}
          disabled={busy || !canSave}
          title={canSave ? undefined : "Name, address, city and coordinates are all required"}
          className="admin-btn-press"
          style={{ ...button, background: "#4CAF50", opacity: busy || !canSave ? 0.55 : 1 }}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={closeAndReset} disabled={busy} className="admin-btn-press" style={button}>Cancel</button>
      </div>
    </div>
  )
}

// `width: "100%"` is the fix for the panel's own too-much-space complaint:
// without it, a bare <input> keeps the browser's default intrinsic width
// (~170-200px) while its siblings (the map, the textarea) stretch to fill
// the grid column -- so the column widens to fit those, and every short
// input sits in a much wider box than its own content needs, leaving a
// visibly empty strip beside Name, City and Landmark. Filling the column
// removes that dead space without changing the layout's actual footprint.
const input: React.CSSProperties = { width: "100%", padding: "8px 9px", borderRadius: 7, border: "1px solid rgba(0,0,0,.16)", fontSize: 12, background: "#fff", color: "#111" }
const button: React.CSSProperties = { padding: "8px 12px", border: 0, borderRadius: 7, background: "#e5e7eb", color: "#17201b", fontWeight: 700 }
const fieldLabel: React.CSSProperties = { display: "block", marginBottom: 3, color: "#888", fontSize: 10, textTransform: "uppercase" }
