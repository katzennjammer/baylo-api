"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import toast from "react-hot-toast"
import { Modal } from "@/components/admin/Modal"

/**
 * The achievement editor.
 *
 * ── ONE COMPONENT FOR CREATE AND EDIT ────────────────────────
 *
 * Same fields, same rules, same image uploader, so the two cannot drift. The
 * server enforces the rules regardless (the routes validate every field), so
 * this is the convenience layer: it stops an admin discovering that a criterion
 * is required as an error after they have typed everything else.
 *
 * ── THE CRITERION IS A PICK, NOT A TYPED RULE ─────────────────
 *
 * The list here must match AchievementCriterion and @/lib/achievements. An
 * admin chooses what earns the badge from a closed set the system knows how to
 * evaluate -- the whole reason "grays out unless achieved" can be honest. The
 * threshold box is only shown for the COUNTED criteria; the boolean ones
 * (verified, profile complete, ID verified) are earned or not, so a number next
 * to them would be a field that means nothing.
 *
 * ── WHY A REASON IS REQUIRED ON EVERY SAVE ───────────────────
 *
 * It is the audit row. Every other admin decision in this tree demands one, and
 * "who created this badge and why" is exactly the question asked later when a
 * badge turns out to be farmable.
 */

// The `value` strings MUST match the live "AchievementCriterion" enum exactly
// (and @/lib/achievements). The live enum's own spellings are used for the four
// it already had: VERIFIED_ACCOUNT, ID_VERIFIED, FIRST_LISTING, COMPLETED_TRADES.
const CRITERIA: { value: string; label: string; counted: boolean }[] = [
  { value: "VERIFIED_ACCOUNT", label: "Verified email account", counted: false },
  { value: "ID_VERIFIED", label: "Government ID verified", counted: false },
  { value: "PROFILE_COMPLETE", label: "Completed profile (avatar, bio, location)", counted: false },
  { value: "FIRST_LISTING", label: "Listings posted", counted: true },
  { value: "COMPLETED_TRADES", label: "Completed trades", counted: true },
  { value: "LIFETIME_LEAVES", label: "Lifetime Leaves earned", counted: true },
  { value: "SAFEZONE_MEETUPS", label: "Safe-Zone meetups", counted: true },
  { value: "REPORTS_FILED", label: "Reports filed", counted: true },
  { value: "BRIDGE_COMPLETED", label: "Completed trades with a bridge fee paid", counted: true },
]

const CRITERIA_BY_VALUE = new Map(CRITERIA.map((c) => [c.value, c]))

export interface AchievementFormValues {
  id?: string
  key: string
  name: string
  description: string
  icon: string
  imageUrl: string | null
  criterion: string
  threshold: number
  points: number
  sortOrder: number
}

const emptyValues: AchievementFormValues = {
  key: "",
  name: "",
  description: "",
  icon: "🏆",
  imageUrl: null,
  criterion: "VERIFIED_ACCOUNT",
  threshold: 1,
  points: 0,
  sortOrder: 0,
}

/**
 * Uploads one badge image through /api/upload -- the same route listing photos
 * use, which sanitises the bytes and strips metadata before they reach
 * Cloudinary. Badge art is public by design (unlike an ID photo), so the public
 * upload path is the right one.
 */
async function uploadImage(file: File): Promise<string> {
  const form = new FormData()
  form.append("file", file)
  const response = await fetch("/api/upload", { method: "POST", body: form })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload?.error ?? "Upload failed")
  return payload.url as string
}

export default function AchievementForm({
  initial,
  mode,
}: {
  initial?: AchievementFormValues
  mode: "create" | "edit"
}) {
  const router = useRouter()
  // ALWAYS starts closed, same fix as HubForm.tsx: `useState(mode === "edit")`
  // opened every edit-mode row's form immediately, so every achievement row
  // rendered its full editor -- key, name, description, art uploader,
  // criterion, threshold, points, sort order, reason, buttons -- permanently
  // expanded, which is what made this table look like it had "too much
  // space" too.
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<AchievementFormValues>(initial ?? emptyValues)
  const [reason, setReason] = useState("")
  const [backfill, setBackfill] = useState(true)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const criterion = CRITERIA_BY_VALUE.get(values.criterion)
  const counted = criterion?.counted ?? false

  function update<K extends keyof AchievementFormValues>(key: K, value: AchievementFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }))
  }

  /**
   * Closing returns the form to what it was when opened, the same rule
   * HubForm.tsx's closeAndReset() follows and for the same reason: this
   * component stays mounted between opens (one per row), so an edit typed
   * and then cancelled would otherwise still be sitting in `values` the next
   * time this row's form is reopened -- and `reason` carrying over would mean
   * a stale audit-log justification is one click from being reused for an
   * unrelated change.
   */
  function closeAndReset() {
    setValues(initial ?? emptyValues)
    setReason("")
    setOpen(false)
  }

  async function pickImage(file: File) {
    setUploading(true)
    try {
      const url = await uploadImage(file)
      update("imageUrl", url)
      toast.success("Image uploaded.")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed")
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ""
    }
  }

  async function submit() {
    if (!reason.trim()) {
      toast.error("A reason is required — it goes in the audit log.")
      return
    }
    if (!values.key.trim() || !values.name.trim() || !values.description.trim()) {
      toast.error("Key, name and description are required.")
      return
    }

    setBusy(true)
    try {
      const body =
        mode === "create"
          ? {
              key: values.key.trim(),
              name: values.name.trim(),
              description: values.description.trim(),
              icon: values.icon.trim() || "🏆",
              imageUrl: values.imageUrl,
              criterion: values.criterion,
              threshold: counted ? values.threshold : 1,
              points: values.points,
              sortOrder: values.sortOrder,
              backfill,
              reason: reason.trim(),
            }
          : {
              name: values.name.trim(),
              description: values.description.trim(),
              icon: values.icon.trim() || "🏆",
              imageUrl: values.imageUrl,
              criterion: values.criterion,
              threshold: counted ? values.threshold : 1,
              points: values.points,
              sortOrder: values.sortOrder,
              reason: reason.trim(),
            }

      const response = await fetch(
        mode === "create" ? "/api/admin/achievements" : `/api/admin/achievements/${initial!.id}`,
        {
          method: mode === "create" ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      )
      const payload = await response.json()
      if (!response.ok) {
        toast.error(payload?.error?.message ?? payload?.error ?? "That did not work.")
        return
      }
      if (mode === "create") {
        const granted = payload?.backfilled ?? 0
        toast.success(granted > 0 ? `Created. Backfilled to ${granted} user${granted === 1 ? "" : "s"}.` : "Achievement created.")
        setValues(emptyValues)
        setBackfill(true)
      } else {
        toast.success("Achievement updated.")
      }
      setReason("")
      if (mode === "create") setOpen(false)
      router.refresh()
    } catch {
      toast.error("That did not work.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="admin-btn-press"
          style={{ padding: "9px 14px", border: 0, borderRadius: 9, background: "#17201b", color: "#fff", fontWeight: 700 }}
        >
          {mode === "create" ? "Create achievement" : "Edit"}
        </button>
      ) : null}
      <Modal open={open} onClose={closeAndReset}>
        <AchievementFormPanel
          values={values}
          update={update}
          mode={mode}
          uploading={uploading}
          fileInput={fileInput}
          pickImage={pickImage}
          counted={counted}
          backfill={backfill}
          setBackfill={setBackfill}
          reason={reason}
          setReason={setReason}
          busy={busy}
          submit={submit}
          closeAndReset={closeAndReset}
        />
      </Modal>
    </div>
  )
}

function AchievementFormPanel({
  values, update, mode, uploading, fileInput, pickImage, counted, backfill, setBackfill,
  reason, setReason, busy, submit, closeAndReset,
}: {
  values: AchievementFormValues
  update: <K extends keyof AchievementFormValues>(key: K, value: AchievementFormValues[K]) => void
  mode: "create" | "edit"
  uploading: boolean
  fileInput: React.RefObject<HTMLInputElement | null>
  pickImage: (file: File) => Promise<void>
  counted: boolean
  backfill: boolean
  setBackfill: (value: boolean) => void
  reason: string
  setReason: (value: string) => void
  busy: boolean
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
      <Field label="Key (stable id)">
        <input
          value={values.key}
          onChange={(e) => update("key", e.target.value)}
          placeholder="verified_account"
          disabled={mode === "edit"}
          style={{ ...input, opacity: mode === "edit" ? 0.6 : 1 }}
        />
      </Field>

      <Field label="Name">
        <input value={values.name} onChange={(e) => update("name", e.target.value)} placeholder="Verified" style={input} />
      </Field>

      <Field label="Description">
        <textarea
          value={values.description}
          onChange={(e) => update("description", e.target.value)}
          placeholder="Verified your email address."
          style={{ ...input, minHeight: 54, resize: "vertical" }}
        />
      </Field>

      <Field label="Badge art (optional — falls back to the icon)">
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div
            style={{
              width: 56, height: 56, borderRadius: 16, display: "grid", placeItems: "center",
              background: "#E1F1E5", overflow: "hidden", flexShrink: 0,
            }}
          >
            {values.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={values.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <span style={{ fontSize: 26 }}>{values.icon || "🏆"}</span>
            )}
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            disabled={uploading}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void pickImage(file)
            }}
            style={{ fontSize: 12 }}
          />
          {values.imageUrl ? (
            <button type="button" onClick={() => update("imageUrl", null)} style={{ ...smallButton, color: "#991b1b" }}>
              Remove
            </button>
          ) : null}
        </div>
      </Field>

      <Field label="Fallback icon (emoji)">
        <input value={values.icon} onChange={(e) => update("icon", e.target.value)} maxLength={8} style={input} />
      </Field>

      <Field label="Earned when">
        <select value={values.criterion} onChange={(e) => update("criterion", e.target.value)} style={input}>
          {CRITERIA.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
      </Field>

      {counted ? (
        <Field label="Threshold (how many)">
          <input
            type="number"
            min={1}
            value={values.threshold}
            onChange={(e) => update("threshold", Math.max(1, Number(e.target.value) || 1))}
            style={input}
          />
        </Field>
      ) : (
        <p style={{ fontSize: 12, color: "#888" }}>
          Earned or not — no threshold applies to this criterion.
        </p>
      )}

      <Field label="Points">
        <input
          type="number"
          min={0}
          value={values.points}
          onChange={(e) => update("points", Math.max(0, Number(e.target.value) || 0))}
          style={input}
        />
      </Field>

      <Field label="Sort order (lower shows first)">
        <input
          type="number"
          min={0}
          value={values.sortOrder}
          onChange={(e) => update("sortOrder", Math.max(0, Number(e.target.value) || 0))}
          style={input}
        />
      </Field>

      {mode === "create" ? (
        <label style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "flex-start" }}>
          <input type="checkbox" checked={backfill} onChange={(e) => setBackfill(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            Grant to users who already qualify.
            <span style={{ display: "block", color: "#888", fontSize: 11 }}>
              Runs the criteria engine over recent users now. Leave off for a badge that should only be earned from now on.
            </span>
          </span>
        </label>
      ) : null}

      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason required for the audit log"
        maxLength={1000}
        style={{ ...input, minHeight: 54 }}
      />

      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={submit}
          disabled={busy || uploading}
          className="admin-btn-press"
          style={{ ...smallButton, background: "#4CAF50", color: "#fff", opacity: busy || uploading ? 0.6 : 1 }}
        >
          {busy ? "Saving…" : mode === "create" ? "Create" : "Save"}
        </button>
        <button type="button" onClick={closeAndReset} disabled={busy} className="admin-btn-press" style={smallButton}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ fontSize: 11, color: "#888", textTransform: "uppercase", fontWeight: 700 }}>{label}</span>
      {children}
    </label>
  )
}

// `width: "100%"` for the same reason as HubForm.tsx's `input`: without it a
// bare <input>/<select> keeps the browser's small intrinsic width while the
// grid column widens to fit a sibling (the description textarea), leaving a
// dead strip beside every short field.
const input: React.CSSProperties = {
  width: "100%", padding: "8px 9px", borderRadius: 7, border: "1px solid rgba(0,0,0,.16)",
  fontSize: 12, background: "#fff", color: "#111", fontFamily: "inherit",
}
const smallButton: React.CSSProperties = {
  padding: "8px 12px", border: "1px solid rgba(0,0,0,.12)", borderRadius: 7,
  background: "#fff", color: "#17201b", fontWeight: 700, cursor: "pointer", fontSize: 12,
}
