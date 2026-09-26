/**
 * Clear the Featured flag on every boost whose window has closed.
 *
 * Run: npx tsx --env-file=.env scripts/expire-featured.ts [--dry-run]
 *
 * The companion of scripts/expire-perishables.ts, and here for the same
 * reason: the lazy sweep in @/lib/featured runs on /featured and /profile/me,
 * which covers everything a user sees, and this is the same function behind a
 * command for a cron to call the day this deployment has one.
 * `expireFeaturedItems()` is the only place the rule is written.
 *
 * Replayable and safe to run as often as you like: it compares against each
 * row's own `featuredUntil`, and a second run finds nothing.
 *
 * NO LIVE-GUARD, for the reason expire-perishables.ts gives: it performs the
 * single UPDATE the application already performs on every Featured read.
 * Plain Prisma, no raw SQL, so it writes the schema its connection names.
 */

import prisma from "../src/lib/prisma"
import { expireFeaturedItems } from "../src/lib/featured"

async function main() {
  const now = new Date()

  if (process.argv.includes("--dry-run")) {
    // The sweep's own predicate, counted instead of written.
    const due = await prisma.item.count({
      where: { isFeatured: true, featuredUntil: { lte: now } },
    })
    console.log(`${due} featured listing(s) are past their window.`)
    console.log("Dry run — nothing was changed.")
    return
  }

  const moved = await expireFeaturedItems(prisma, {}, now)
  console.log(
    moved === 0
      ? "Nothing to expire."
      : `Cleared ${moved} lapsed boost${moved === 1 ? "" : "s"}.`,
  )
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
