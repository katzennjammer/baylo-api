/**
 * Upserts the "Premium Member" achievement -- Premium perk #4 from the PM's
 * final list. Emoji icon only, no uploaded art (unlike
 * scripts/seed-badge-achievements.ts): there is no badge image for this one
 * yet, and PROGRESSFOR()'s PREMIUM_SUBSCRIBER case (see @/lib/achievements)
 * only needs an icon fallback to work correctly.
 *
 * Run after `npx prisma migrate deploy` has applied
 * 20260924000001_premium_achievement (adds the PREMIUM_SUBSCRIBER criterion
 * value) and `npx prisma generate` has picked it up:
 *
 *   npx tsx --env-file=.env scripts/seed-premium-achievement.ts
 *
 * Idempotent, upserted on the stable `key` -- running this twice just
 * confirms the row still reads the same values.
 */

import prisma from "@/lib/prisma"

async function main() {
  const achievement = await prisma.achievement.upsert({
    where: { key: "premium_member" },
    create: {
      key: "premium_member",
      name: "Premium Member",
      description: "Subscribed to Baylo Premium.",
      icon: "⭐",
      criterion: "PREMIUM_SUBSCRIBER",
      threshold: 1,
      points: 15,
      sortOrder: 70,
      isActive: true,
    },
    update: {
      name: "Premium Member",
      description: "Subscribed to Baylo Premium.",
      icon: "⭐",
      criterion: "PREMIUM_SUBSCRIBER",
      threshold: 1,
      points: 15,
      sortOrder: 70,
      isActive: true,
    },
  })
  console.log("Upserted:", achievement.key, achievement.id)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
