/**
 * A single small dot that pulses in a 2s loop -- the "this card has
 * something waiting" cue. Deliberately a plain CSS keyframe (see
 * globals.css, .admin-pulse-dot) rather than Framer Motion: it is a
 * decorative loop with no state and no layout to coordinate, which is
 * exactly the case plain CSS handles best.
 */
export function PulsingDot({ color = "#b45309" }: { color?: string }) {
  return <span className="admin-pulse-dot" style={{ background: color }} aria-hidden="true" />
}
