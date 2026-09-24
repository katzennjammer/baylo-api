/**
 * Uploads the six swan-stamp badge images from C:\BAYLOMOBILEVERSION\Badges
 * to Cloudinary and upserts the matching Achievement rows -- name,
 * description, criterion, threshold, points and art, all in one place, per
 * the table given for this feature:
 *
 *   Welcome, Cygnet   Account created            5 pts
 *   Preening Time     Profile completed          5 pts
 *   True Colors       ID verified               10 pts
 *   First Leaf Out    First item listed         15 pts
 *   Little Swapling   First successful swap     20 pts
 *   Leaf of Faith     First value bridge        20 pts  (BRIDGE_COMPLETED --
 *                     the first COMPLETED trade that carried a bridge fee;
 *                     see @/lib/bridge-fee and @/lib/achievements)
 *
 * Run from the project root, after `npx prisma migrate deploy` (or
 * `migrate dev`) has applied 20260923000000_achievement_points_and_bridge_criterion
 * and `npx prisma generate` has picked up the new `points` field and the
 * BRIDGE_COMPLETED criterion:
 *
 *   npx tsx --env-file=.env scripts/seed-badge-achievements.ts
 *
 * --env-file loads DATABASE_URL and the CLOUDINARY_* vars from .env without
 * needing the dotenv package.
 *
 * ── IDEMPOTENT, BY KEY ───────────────────────────────────────
 *
 * Each badge is upserted on its stable `key` (see the model's doc comment on
 * why key and not id). Running this twice re-uploads the art (Cloudinary just
 * gets a second asset; harmless) and overwrites the six rows back to these
 * values -- the same "re-running resets seeded rows" contract prisma/seed.ts
 * uses. It does NOT touch, deactivate, or delete any OTHER achievement this
 * database might already have; those are listed at the end so a human decides
 * what to do with them, because guessing which existing badge a swan-stamp
 * badge replaces is exactly the kind of mistake a script should not make on
 * its own.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { v2 as cloudinary } from "cloudinary"
import prisma from "@/lib/prisma"
import { sanitizeImage } from "@/lib/image-sanitize"

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

const BADGES_DIR = "C:\\BAYLOMOBILEVERSION\\Badges"

interface BadgeSeed {
  key: string
  name: string
  description: string
  icon: string
  file: string
  criterion:
    | "VERIFIED_ACCOUNT"
    | "ID_VERIFIED"
    | "FIRST_LISTING"
    | "COMPLETED_TRADES"
    | "PROFILE_COMPLETE"
    | "BRIDGE_COMPLETED"
  threshold: number
  points: number
  sortOrder: number
}

const BADGES: BadgeSeed[] = [
  {
    key: "welcome_cygnet",
    name: "Welcome, Cygnet",
    description: "Created your Baylo account.",
    icon: "🦢",
    file: "Welcome, Cygnet.jpg",
    criterion: "VERIFIED_ACCOUNT",
    threshold: 1,
    points: 5,
    sortOrder: 10,
  },
  {
    key: "preening_time",
    name: "Preening Time",
    description: "Completed your profile — avatar, bio and location.",
    icon: "🪶",
    file: "Preening Time.jpg",
    criterion: "PROFILE_COMPLETE",
    threshold: 1,
    points: 5,
    sortOrder: 20,
  },
  {
    key: "true_colors",
    name: "True Colors",
    description: "Verified your government ID.",
    icon: "🌈",
    file: "True Colors.jpg",
    criterion: "ID_VERIFIED",
    threshold: 1,
    points: 10,
    sortOrder: 30,
  },
  {
    key: "first_leaf_out",
    name: "First Leaf Out",
    description: "Posted your first listing.",
    icon: "🍃",
    file: "First Leaf Out.jpg",
    criterion: "FIRST_LISTING",
    threshold: 1,
    points: 15,
    sortOrder: 40,
  },
  {
    key: "little_swapling",
    name: "Little Swapling",
    description: "Completed your first trade.",
    icon: "🤝",
    file: "Little Swapling.jpg",
    criterion: "COMPLETED_TRADES",
    threshold: 1,
    points: 20,
    sortOrder: 50,
  },
  {
    key: "leaf_of_faith",
    name: "Leaf of Faith",
    description: "Completed a trade that bridged the value gap with Leaves.",
    icon: "🌉",
    file: "Leaf of Faith.jpg",
    criterion: "BRIDGE_COMPLETED",
    threshold: 1,
    points: 20,
    sortOrder: 60,
  },
]

async function uploadBadgeArt(fileName: string): Promise<string> {
  const path = join(BADGES_DIR, fileName)
  const raw = readFileSync(path)
  // Same sanitisation the /api/upload route applies to any user-facing image:
  // decoded, stripped of metadata, and re-encoded before it ever reaches
  // Cloudinary.
  const sanitized = await sanitizeImage(raw)

  return new Promise<string>((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(
        { folder: "baylo/achievements", resource_type: "image", image_metadata: false },
        (error, result) => {
          if (error || !result) reject(error ?? new Error("Cloudinary returned no result"))
          else resolve(result.secure_url)
        },
      )
      .end(sanitized.buffer)
  })
}

async function main() {
  console.log(`Uploading and upserting ${BADGES.length} badges…\n`)

  for (const badge of BADGES) {
    process.stdout.write(`  ${badge.name} … uploading art`)
    const imageUrl = await uploadBadgeArt(badge.file)
    process.stdout.write(" done, upserting row… ")

    await prisma.achievement.upsert({
      where: { key: badge.key },
      create: {
        key: badge.key,
        name: badge.name,
        description: badge.description,
        icon: badge.icon,
        imageUrl,
        criterion: badge.criterion,
        threshold: badge.threshold,
        points: badge.points,
        sortOrder: badge.sortOrder,
        isActive: true,
      },
      update: {
        name: badge.name,
        description: badge.description,
        icon: badge.icon,
        imageUrl,
        criterion: badge.criterion,
        threshold: badge.threshold,
        points: badge.points,
        sortOrder: badge.sortOrder,
        isActive: true,
      },
    })
    console.log("done")
  }

  const knownKeys = new Set(BADGES.map((b) => b.key))
  const others = await prisma.achievement.findMany({
    where: { isActive: true, key: { notIn: [...knownKeys] } },
    select: { key: true, name: true, criterion: true },
  })

  console.log("\nDone.")
  if (others.length > 0) {
    console.log(
      `\n${others.length} other ACTIVE achievement(s) already existed and were left untouched -- decide by hand (via /admin/achievements) whether any should be deactivated now that the swan set replaces them:`,
    )
    for (const o of others) console.log(`  - ${o.name}  (key: ${o.key}, criterion: ${o.criterion})`)
  } else {
    console.log("No other active achievements existed.")
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err)
    await prisma.$disconnect()
    process.exit(1)
  })
