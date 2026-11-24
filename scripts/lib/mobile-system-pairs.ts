import { existsSync } from "fs"
import { createRequire } from "module"
import { resolve } from "path"

/**
 * The mobile app's collapseSystemPairs(), loaded from the sibling checkout AT
 * RUN TIME. The harnesses that use it are testing that exact file, so it is
 * not copied here -- but a static `import "../../baylo-mobile/..."` made
 * `next build` type-check a path outside this repo, which fails on any host
 * that checks out only the API (and on any machine whose folder is named
 * baylo-app). Resolved here instead, and only when a harness actually runs.
 *
 * Looks in BAYLO_APP_DIR, then ../baylo-mobile, then ../baylo-app.
 */
type PairCandidate = { senderId: string; content: string }

const candidates = [process.env.BAYLO_APP_DIR, "../baylo-mobile", "../baylo-app"]
  .filter((d): d is string => !!d)
  .map((d) => resolve(process.cwd(), d, "src/lib/system-pairs.ts"))

export function collapseSystemPairs<T extends PairCandidate>(messages: T[], partnerId: string | null): T[] {
  const file = candidates.find(existsSync)
  if (!file) throw new Error(`Mobile repo not found. Set BAYLO_APP_DIR; looked for:\n  ${candidates.join("\n  ")}`)
  const mod = createRequire(__filename)(file) as { collapseSystemPairs: typeof collapseSystemPairs }
  return mod.collapseSystemPairs(messages, partnerId)
}
