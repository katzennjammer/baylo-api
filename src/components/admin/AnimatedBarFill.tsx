"use client"

import { useEffect, useState } from "react"
import { motion, useReducedMotion } from "framer-motion"

/**
 * A report bar's fill, grown from 0 to its final width on scroll-into-view
 * (once), staggered by row index. The bar's percentage math stays in
 * ReportCharts.BarChart -- this only owns the growth animation, so the
 * "percentage of its own row, never a fixed px width" property that keeps
 * bars from overflowing on paper (see ReportCharts.tsx) is untouched.
 *
 * PRINT IS THE ESCAPE HATCH. A bar below the fold that has never scrolled
 * into view is still at width: 0 the moment somebody hits Export -- the
 * report's whole print path exists to turn the CURRENT figures into a PDF,
 * not a PDF with blank charts. `beforeprint` forces every bar to its final
 * width immediately, the same way ReportControls pauses the live refresh for
 * print: both listen for the browser telling them a printout is imminent.
 */
export function AnimatedBarFill({
  pct,
  color,
  index = 0,
}: {
  pct: number
  color: string
  index?: number
}) {
  const reduce = useReducedMotion()
  const [printing, setPrinting] = useState(false)

  useEffect(() => {
    const onBeforePrint = () => setPrinting(true)
    const onAfterPrint = () => setPrinting(false)
    window.addEventListener("beforeprint", onBeforePrint)
    window.addEventListener("afterprint", onAfterPrint)
    return () => {
      window.removeEventListener("beforeprint", onBeforePrint)
      window.removeEventListener("afterprint", onAfterPrint)
    }
  }, [])

  if (reduce || printing) {
    return <span style={{ display: "block", width: pct + "%", height: "100%", borderRadius: 4, background: color }} />
  }

  return (
    <motion.span
      style={{ display: "block", height: "100%", borderRadius: 4, background: color }}
      initial={{ width: 0 }}
      whileInView={{ width: pct + "%" }}
      viewport={{ once: true, amount: 0.4 }}
      transition={{ duration: 0.4, ease: [0, 0, 0.2, 1], delay: Math.min(index, 10) * 0.04 }}
    />
  )
}
