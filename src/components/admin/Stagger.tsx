"use client"

import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { motion, useReducedMotion, type Transition } from "framer-motion"

/**
 * Mount-only entrance stagger for stat cards and table rows.
 *
 * StaggerGroup marks whether THIS render is still within the component's
 * first entrance (a real mount) or a later one (a filter re-render, a
 * router.refresh()). Only the first gets the staggered fade + translateY;
 * everything after renders instantly, because a moderator re-filtering a
 * list is not "content arriving" the way an initial page load is.
 *
 * The flag is state, set back to false from a timeout rather than a ref
 * mutated during render: React keeps this component mounted across a
 * Next.js soft navigation (same slot in the tree), so state set once after
 * the entrance animation has had time to play survives through every later
 * re-render, the same way a ref would -- without reading or writing a ref
 * outside an effect, which breaks under React's compiler.
 *
 * ── WHY THERE IS ALSO A `mounted` GATE ───────────────────────
 *
 * Framer Motion computes a motion component's `initial` styles as part of
 * its very first render, not after -- so the FIRST CLIENT RENDER (the one
 * React's hydration check compares against the server-rendered HTML) would
 * already carry `opacity: 0; transform: translateY(8px)`, which the server
 * never rendered (it has no window, so it just renders the plain tag). That
 * mismatch is what the hydration warning was: real, not cosmetic, and it
 * does not fix itself. So the group renders a PLAIN tag -- identical to SSR
 * -- until an effect confirms hydration has actually completed, and only
 * then swaps in the animated version. The entrance still plays; it just
 * starts a frame after hydration instead of racing it.
 */
const StaggerCtx = createContext(false)

const MAX_STAGGER = 10
// Comfortably longer than the worst case (MAX_STAGGER * stagger + one item's
// own transition) so the flag never flips while the entrance is still
// playing.
const ENTRANCE_WINDOW_MS = 900

export function StaggerGroup({
  as = "div",
  stagger = 0.03,
  children,
  ...rest
}: {
  as?: "div" | "tbody"
  stagger?: number
  children: ReactNode
} & Record<string, unknown>) {
  const reduce = useReducedMotion()
  const [mounted, setMounted] = useState(false)
  const [entering, setEntering] = useState(true)
  useEffect(() => {
    // Deferred a frame rather than set synchronously in the effect body --
    // see the same pattern (and the reason for it) in CountUp.tsx.
    const raf = requestAnimationFrame(() => setMounted(true))
    const timer = window.setTimeout(() => setEntering(false), ENTRANCE_WINDOW_MS)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
    }
  }, [])

  if (!mounted) {
    const PlainTag = as === "tbody" ? "tbody" : "div"
    return (
      <StaggerCtx.Provider value={false}>
        <PlainTag {...(rest as object)}>{children}</PlainTag>
      </StaggerCtx.Provider>
    )
  }

  const animate = entering && !reduce
  const MotionTag = as === "tbody" ? motion.tbody : motion.div

  return (
    <StaggerCtx.Provider value={animate}>
      <MotionTag
        initial={animate ? "hidden" : false}
        animate="show"
        transition={{ staggerChildren: stagger }}
        {...rest}
      >
        {children}
      </MotionTag>
    </StaggerCtx.Provider>
  )
}

const itemVariants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0 },
}

const itemTransition: Transition = { duration: 0.2, ease: [0, 0, 0.2, 1] }

export function StaggerItem({
  as = "div",
  index = 0,
  children,
  ...rest
}: {
  as?: "div" | "tr"
  index?: number
  children: ReactNode
} & Record<string, unknown>) {
  const animate = useContext(StaggerCtx)
  if (!animate || index >= MAX_STAGGER) {
    if (as === "tr") return <tr {...(rest as object)}>{children}</tr>
    return <div {...(rest as object)}>{children}</div>
  }
  const MotionTag = as === "tr" ? motion.tr : motion.div
  return (
    <MotionTag variants={itemVariants} transition={itemTransition} {...rest}>
      {children}
    </MotionTag>
  )
}
