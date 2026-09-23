"use client"

import { useEffect, useRef, useState } from "react"
import { useReducedMotion } from "framer-motion"

/**
 * Counts a number up from 0 to `value` over `durationMs`, ease-out cubic.
 *
 * Skips the animation entirely for value === 0 (nothing to count up to) and
 * for prefers-reduced-motion (jumps straight to the final value) -- an admin
 * re-checking a queue after clearing it should not wait on a number.
 */
export function CountUp({
  value,
  durationMs = 600,
  format,
}: {
  value: number
  durationMs?: number
  format?: (n: number) => string
}) {
  const reduce = useReducedMotion()
  const [display, setDisplay] = useState(reduce || value === 0 ? value : 0)
  const rafRef = useRef<number | null>(null)
  const fmt = format ?? ((n: number) => Math.round(n).toLocaleString())

  useEffect(() => {
    if (value === 0 || reduce) {
      // Deferred a frame rather than set synchronously in the effect body: the
      // value is already correct on the very first render (see the lazy
      // useState initializer above), so this only matters when `value`
      // changes on an already-mounted instance.
      rafRef.current = requestAnimationFrame(() => setDisplay(value))
      return () => {
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      }
    }
    let start: number | null = null
    function tick(ts: number) {
      if (start === null) start = ts
      const t = Math.min(1, (ts - start) / durationMs)
      const eased = 1 - Math.pow(1 - t, 3)
      setDisplay(value * eased)
      if (t < 1) rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [value, durationMs, reduce])

  return <>{fmt(display)}</>
}
