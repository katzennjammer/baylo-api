/**
 * Row-level success feedback for a table an admin just acted on (hide a
 * listing, suspend a user, decide an appeal, decide a value review).
 *
 * WHY A DOM WALK AND NOT LIFTED STATE. Every one of these tables is rendered
 * by an async Server Component straight from Prisma; the action button lives
 * several server-rendered layers below it inside one <td>. Turning every one
 * of those pages into a client component just so a row can track its own
 * "removed" state would mean re-typing each table's row markup a second
 * time. Reaching up to the nearest <tr> from the button that was actually
 * clicked gets the same visible effect -- the row fades and settles before
 * the data underneath it changes -- without moving a single table's render
 * out of the server component that owns its Prisma query.
 *
 * The class is removed again before `after()` runs (which is what triggers
 * router.refresh()): a class added via classList is invisible to React's
 * reconciler, since these <tr> elements never carry a className prop, so
 * nothing would ever clear it on the next render if this function did not.
 */
const COLLAPSE_CLASS = "admin-row-collapsing"
const COLLAPSE_MS = 220

export function collapseRowThen(trigger: HTMLElement | null, after: () => void) {
  const row = trigger?.closest("tr")
  const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches

  if (!row || reduce) {
    after()
    return
  }

  row.classList.add(COLLAPSE_CLASS)
  window.setTimeout(() => {
    row.classList.remove(COLLAPSE_CLASS)
    after()
  }, COLLAPSE_MS)
}
