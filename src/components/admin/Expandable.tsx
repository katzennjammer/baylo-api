"use client"

import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { useEffect, useState, type ReactNode } from "react"

/**
 * Animates a section open/closed by height + opacity (200ms) instead of an
 * instant toggle. Used for disclosure panels like the hub edit form and a
 * takedown-reason panel -- content that was already there, just hidden.
 *
 * ── WHY THE FIRST RENDER SKIPS FRAMER MOTION ENTIRELY ────────
 *
 * Some callers (an edit form's panel, for one) start already `open` on
 * mount. Framer Motion computes its `initial` styles as part of that same
 * first render, which does not match the plain markup the server rendered --
 * a real hydration mismatch, not a cosmetic one. So the very first client
 * render matches SSR exactly (the content, or nothing, with no Framer Motion
 * involved), and only after an effect confirms hydration is done does this
 * switch to the animated version -- at which point AnimatePresence's
 * `initial={false}` deliberately does NOT replay an entrance for whatever is
 * already open; only a genuine later toggle (a real user click) animates.
 */
export function Expandable({ open, children }: { open: boolean; children: ReactNode }) {
  const reduce = useReducedMotion()
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    // Deferred a frame rather than set synchronously in the effect body --
    // see the same pattern (and the reason for it) in CountUp.tsx.
    const raf = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  if (!mounted || reduce) {
    return open ? <div>{children}</div> : null
  }

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          key="content"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
          style={{ overflow: "hidden" }}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
