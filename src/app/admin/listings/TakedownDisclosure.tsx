"use client"

import { useState, type ReactNode } from "react"
import { Expandable } from "@/components/admin/Expandable"

/**
 * The "Moderation takedown…" disclosure on a listing still in value review.
 * Used to be a <details>/<summary>; now an animated open/close (200ms
 * height + opacity) so revealing the takedown controls doesn't snap.
 */
export function TakedownDisclosure({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{ fontSize: 12, color: "#777", cursor: "pointer", background: "none", border: 0, padding: 0 }}
      >
        {open ? "Hide moderation takedown" : "Moderation takedown…"}
      </button>
      <Expandable open={open}>
        <div style={{ marginTop: 6 }}>{children}</div>
      </Expandable>
    </div>
  )
}
