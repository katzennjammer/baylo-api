/**
 * Deactivates the three pre-existing achievements the swan badge set
 * duplicates -- same criterion, same trigger, now a second badge for the same
 * moment:
 *
 *   Verified            VERIFIED_ACCOUNT  -> superseded by "Welcome, Cygnet"
 *   Identity Confirmed   ID_VERIFIED       -> superseded by "True Colors"
 *   Trusted Trader       COMPLETED_TRADES  -> superseded by "Little Swapling"
 *
 * Deactivate, not delete -- same rule the admin UI and API enforce (see
 * ACHIEVEMENT_DEACTIVATED in the schema and the [id]/route.ts doc comment):
 * a UserAchievement cascades from its Achievement, so deleting would strip
 * the badge off every profile that already earned it. Deactivating stops new
 * grants and hides it from the shelf; earned copies survive untouched.
 *
 * WRITES A REAL AUDIT ROW per achievement, same as the admin route would --
 * a script that flips isActive without one would be exactly the kind of
 * "who did this and why" gap this codebase never allows anywhere else.
 * Needs an ADMIN user to attribute the action to; set ACTOR_EMAIL to pick a
 * specific one, or it uses the earliest-created active ADMIN account and
 * prints which one it chose.
 *
 * Idempotent: an already-inactive row (or a missing key) is skipped, not
 * re-audited.
 *
 * Run from the project root:
 *   npx tsx --env-file=.env scripts/deactivate-legacy-achievements.ts
 *   ACTOR_EMAIL=you@example.com npx tsx --env-file=.env scripts/deactivate-legacy-achievements.ts
 */

import prisma from "@/lib/prisma"
import { writeAudit } from "@/lib/moderation"

const REASON = "Superseded by the swan badge set, which covers the same criterion under a new name and image."

const LEGACY: { key: string; supersededBy: string }[] = [
  { key: "VERIFIED_ACCOUNT", supersededBy: "Welcome, Cygnet" },
  { key: "ID_VERIFIED", supersededBy: "True Colors" },
  { key: "COMPLETED_TRADES", supersededBy: "Little Swapling" },
]

async function main() {
  const actorEmail = process.env.ACTOR_EMAIL?.trim()
  const actor = await prisma.user.findFirst({
    where: {
      role: "ADMIN",
      deletedAt: null,
      ...(actorEmail ? { email: actorEmail } : {}),
    },
    select: { id: true, name: true, email: true },
    orderBy: { createdAt: "asc" },
  })

  if (!actor) {
    console.error(
      actorEmail
        ? `No active ADMIN account found with email ${actorEmail}.`
        : "No active ADMIN account found to attribute this to.",
    )
    process.exit(1)
  }

  console.log(`Attributing to ${actor.name} <${actor.email}>.\n`)

  for (const item of LEGACY) {
    const existing = await prisma.achievement.findUnique({ where: { key: item.key } })
    if (!existing) {
      console.log(`  ${item.key}: no row with this key, skipped.`)
      continue
    }
    if (!existing.isActive) {
      console.log(`  ${existing.name} (${item.key}): already inactive, skipped.`)
      continue
    }

    await prisma.$transaction(async (tx) => {
      const row = await tx.achievement.update({
        where: { id: existing.id },
        data: { isActive: false },
      })
      await writeAudit(tx, {
        actorId: actor.id,
        action: "ACHIEVEMENT_DEACTIVATED",
        targetType: "ACHIEVEMENT",
        targetId: row.id,
        reason: `${REASON} (superseded by "${item.supersededBy}")`,
        detail: {
          before: { name: existing.name, criterion: existing.criterion, isActive: true },
          after: { name: row.name, criterion: row.criterion, isActive: false },
        },
      })
    })
    console.log(`  ${existing.name} (${item.key}): deactivated.`)
  }

  console.log("\nDone.")
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err)
    await prisma.$disconnect()
    process.exit(1)
  })
