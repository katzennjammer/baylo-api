/**
 * Expire perishable listings whose window has closed.
 *
 * Run: npx tsx --env-file=.env scripts/expire-perishables.ts
 *
 * ── WHY THIS EXISTS WHEN THE READ PATHS ALREADY SWEEP ───────────────────────
 *
 * The lazy sweep in @/lib/perishable runs on /browse, /home and /profile/me,
 * which covers every case where an expired listing would be SEEN. It does not
 * cover the case where nobody looks: a quiet night leaves yesterday's fish
 * AVAILABLE in the database until the first person opens the app, and while
 * that is invisible to users it is visible to anything that queries the table
 * directly — a report, an export, the valuation model's comparables.
 *
 * So this is the same function behind a command, for a cron to call the day
 * this deployment has one. It is deliberately NOT a second implementation:
 * `expirePerishableItems()` is the only place the rule is written, and this
 * file is twenty lines of argument parsing around it.
 *
 * Safe to run at any time and as often as you like. The sweep is replayable by
 * construction — the cutoff is computed per row from `createdAt`, so a run that
 * has not happened for a week expires exactly what was already past its window,
 * and a second run immediately after finds nothing.
 *
 * ── NO LIVE-GUARD, DELIBERATELY ─────────────────────────────────────────────
 *
 * Every other writing script in this repo refuses a non-local DATABASE_URL
 * without BAYLO_ALLOW_LIVE=1, because they create fixtures or move Leaves. This
 * one performs the single UPDATE the application already performs on every feed
 * load. Guarding it would mean the operational tool needs a flag to do what
 * opening the app does by itself, which is the kind of friction that gets a
 * cron entry written with the guard permanently disabled.
 */

import prisma from "../src/lib/prisma"
import { expirePerishableItems } from "../src/lib/perishable"

async function main() {
  const dryRun = process.argv.includes("--dry-run")

  if (dryRun) {
    // Counted with the same predicate the sweep updates on, so the number
    // printed is the number that would move.
    const due = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) FROM "Item"
       WHERE "isPerishable" = true
         AND "status" = 'AVAILABLE'
         AND "tradeWithinHours" IS NOT NULL
         AND "createdAt" + make_interval(hours => "tradeWithinHours") < now()`
    console.log(`${Number(due[0]?.count ?? 0)} perishable listing(s) are past their window.`)
    console.log("Dry run — nothing was changed.")
    return
  }

  const moved = await expirePerishableItems(prisma)
  console.log(
    moved === 0
      ? "Nothing to expire."
      : `Expired ${moved} perishable listing${moved === 1 ? "" : "s"}.`,
  )
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
