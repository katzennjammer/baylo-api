"use client"

import { useEffect, type ReactNode } from "react"
import { createPortal } from "react-dom"

/**
 * A centered, viewport-fixed dialog, rendered via a portal.
 *
 * ── WHY A PORTAL, NOT JUST `position: fixed` IN PLACE ───────────────────────
 *
 * The Hubs edit form used to render inline inside a `<tr>` that
 * StaggerGroup/StaggerItem animate with Framer Motion. Framer Motion sets a
 * CSS `transform` on an animated element (even at rest, briefly, during
 * mount), and ANY ancestor with a transform becomes the containing block for
 * a `position: fixed` descendant -- so "fixed" would have anchored to that
 * table row's box, not the viewport, and the dialog would have rendered
 * clipped to wherever the row happened to be instead of centered on screen.
 * `createPortal` moves the DOM node to `document.body`, outside every
 * ancestor's influence, so `position: fixed` here always means the viewport.
 *
 * Not a library dialog: this repo has no modal anywhere yet, and one flexible
 * component (esc-to-close, backdrop-click-to-close, scroll lock) covers every
 * future admin form that outgrows an inline panel, the same way Expandable
 * covers every inline disclosure.
 */
export function Modal({
  open,
  onClose,
  children,
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKeyDown)
    // Background scroll is locked while open -- otherwise the page behind a
    // centered dialog scrolls out from under it, which reads as broken.
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,20,17,.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        zIndex: 1000,
      }}
    >
      {/* Stops a click INSIDE the dialog from bubbling to the backdrop and
          closing it -- the backdrop's own onClick is what closing-by-click
          relies on, so this is the only thing standing between "click Save"
          and "the dialog closes before Save runs". */}
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{ maxHeight: "90vh", overflowY: "auto" }}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}
