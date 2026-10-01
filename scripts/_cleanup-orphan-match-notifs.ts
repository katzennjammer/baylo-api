/**
 * ONE-OFF, 24-25 Sep 2026: delete CATEGORY_MATCH notifications whose listing
 * no longer exists.
 *
 * verify-org-http.ts ran against the live dev server before it had a
 * live-guard. Its FOOD listings notified real accounts -- nine rows on
 * jmjumuad2@gmail.com -- and its cleanup then deleted the listings but not the
 * notifications, leaving rows that open onto nothing. See the note on
 * notifyCategoryMatchesAsync() and the harnesses' `finally` blocks.
 *
 * WHAT IT TOUCHES: Notification rows with type CATEGORY_MATCH, entityType
 * "item", and an entityId that matches no Item row. Nothing else. A listing
 * that still exists keeps its notifications, whatever state it is in.
 *
 * SAFETY:
 *   - requireScratchSchema(): refuses `public` (live) unless --live is passed.
 *   - --dry-run lists what would go and writes/deletes nothing.
 *   - every row is written to backups/ BEFORE the delete, and the delete is by
 *     those exact ids -- a row that appears between the read and the delete is
 *     not swept up.
 *   - refuses outright above MAX_ROWS: tonight's damage is nine rows, and a
 *     much larger number means the query is wrong, not that there is more mess.
 *
 *   npx tsx --tsconfig tsconfig.json --env-file=.env scripts/_cleanup-orphan-match-notifs.ts --live --dry-run
 *   npx tsx --tsconfig tsconfig.json --env-file=.env scripts/_cleanup-orphan-match-notifs.ts --live
 *
 * To undo: the backup file is a JSON array of the full rows; re-insert with
 * prisma.notification.createMany({ data: rows }).
 */
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { requireScratchSchema } from "./lib/live-guard"
import prisma from "../src/lib/prisma"

const MAX_ROWS = 50
const DRY_RUN = process.argv.slice(2).includes("--dry-run")

async function main() {
  const schema = requireScratchSchema("scripts/_cleanup-orphan-match-notifs.ts")

  const rows = await prisma.notification.findMany({
    where: { type: "CATEGORY_MATCH", entityType: "item", entityId: { not: null } },
    include: { user: { select: { email: true } } },
    orderBy: { createdAt: "asc" },
  })
  const itemIds = [...new Set(rows.map((r) => r.entityId!))]
  const alive = new Set(
    (await prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true } })).map((i) => i.id),
  )
  const orphans = rows.filter((r) => !alive.has(r.entityId!))

  console.log(`  CATEGORY_MATCH rows: ${rows.length}; pointing at a deleted listing: ${orphans.length}`)
  const byRecipient = new Map<string, number>()
  for (const o of orphans) byRecipient.set(o.user.email, (byRecipient.get(o.user.email) ?? 0) + 1)
  for (const [email, n] of byRecipient) console.log(`    ${String(n).padStart(3)}  ${email}`)

  if (orphans.length === 0) {
    console.log("  nothing to do")
    return
  }
  if (orphans.length > MAX_ROWS) {
    console.error(`  REFUSING: ${orphans.length} rows is more than ${MAX_ROWS}. Check the query before deleting.`)
    process.exitCode = 1
    return
  }
  if (DRY_RUN) {
    console.log("  --dry-run: nothing backed up, nothing deleted")
    return
  }

  // backups/ is a sibling of the repo (D:\BAYLO\backups), resolved from this
  // file rather than the working directory so the backup cannot land somewhere
  // unexpected.
  const dir = path.resolve(__dirname, "..", "..", "backups")
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const out = path.join(dir, `orphan-category-match-notifications-${schema}-${stamp}.json`)
  const backup = orphans.map(({ user: _user, ...row }) => row)
  writeFileSync(out, JSON.stringify(backup, null, 2))
  console.log(`  backed up ${backup.length} rows to ${out}`)

  const del = await prisma.notification.deleteMany({ where: { id: { in: backup.map((o) => o.id) } } })
  console.log(`  deleted ${del.count} (expected ${backup.length})`)
  if (del.count !== backup.length) process.exitCode = 1
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
