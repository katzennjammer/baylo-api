import { NextRequest } from "next/server"
import { z } from "zod"
import { requireRole } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok, conflict } from "@/lib/v1/envelope"
import { parseJsonBody } from "@/lib/v1/body"
import { writeAudit } from "@/lib/moderation"
import { backfillAchievement } from "@/lib/achievements"

export const dynamic = "force-dynamic"

/**
 * The admin achievements surface.
 *
 *   GET  /api/admin/achievements — every definition, active and not, with how
 *                                 many users have earned each.
 *   POST /api/admin/achievements — create one, and backfill it to users who
 *                                 already qualify.
 *
 * ── THERE IS NO DELETE ───────────────────────────────
 *
 * Deactivation is the only way an achievement leaves circulation. A DELETE
 * would cascade away every UserAchievement row pointing at it -- every earned
 * copy, for every user -- which is the one outcome this feature must never
 * have. The definition is deactivated (isActive = false): it stops being listed
 * and stops being awarded, but the badges people already earned survive, still
 * shown on their profiles. The schema backs this up: UserAchievement ->
 * Achievement is ON DELETE CASCADE, so the ROUTE is what refuses the delete,
 * and it simply does not offer one.
 *
 * ── THE CRITERION IS A CLOSED SET, VALIDATED HERE ────────────────────────────
 *
 * `criterion` must be one of the values in the AchievementCriterion enum, which
 * is the set @/lib/achievements knows how to evaluate. An admin picks a
 * criterion and a threshold; they never type a rule, because "grays out unless
 * achieved" is only honest if the system can decide it.
 */

// ── Shared field rules ───────────────────────

/**
 * The stable machine key. Lowercase snake so it reads as an identifier, and it
 * is unique -- two definitions with the same key would make a seed script or a
 * feature flag that refers to "verified" ambiguous.
 */
const keySchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9_]+$/, "Use lowercase letters, numbers and underscores only")

const criterionSchema = z.enum([
  // Must match the live "AchievementCriterion" enum exactly.
  "VERIFIED_ACCOUNT",
  "ID_VERIFIED",
  "FIRST_LISTING",
  "COMPLETED_TRADES",
  "PROFILE_COMPLETE",
  "LIFETIME_LEAVES",
  "SAFEZONE_MEETUPS",
  "REPORTS_FILED",
  "BRIDGE_COMPLETED",
  "PREMIUM_SUBSCRIBER",
])

/**
 * An emoji or short text, shown when imageUrl is null. Capped small because it
 * is rendered inside a fixed-size badge circle; a paragraph there is a layout
 * break, not a bigger icon.
 */
const iconSchema = z.string().trim().min(1).max(8)

/**
 * The uploaded badge art. A public Cloudinary delivery URL, produced by
 * /api/upload (which sanitises and re-encodes the bytes). Checked to be on our
 * own Cloudinary host and cloud, the same rule @/lib/safe-image-url enforces
 * for listing images -- a badge image is public by design, unlike an ID photo,
 * but it still must not be an arbitrary URL the app would then fetch.
 */
const imageUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((url) => url.startsWith("https://res.cloudinary.com/"), {
    message: "Image must be a Cloudinary delivery URL",
  })
  .nullable()

const thresholdSchema = z.number().int().min(1).max(1_000_000)

/** A stored score, nothing more -- see the `points` doc comment on the model. */
const pointsSchema = z.number().int().min(0).max(1_000)

// ── GET ──────────────────────

export async function GET() {
  const gate = await requireRole("ADMIN")
  if (gate.response) return gate.response

  const rows = await prisma.achievement.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      icon: true,
      imageUrl: true,
      criterion: true,
      threshold: true,
      points: true,
      sortOrder: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
      // How many users hold this badge. The number an admin needs before
      // deactivating anything and the number that makes "did the backfill
      // work?" answerable.
      _count: { select: { unlocks: true } },
    },
  })

  return ok({
    achievements: rows.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      icon: row.icon,
      imageUrl: row.imageUrl,
      criterion: row.criterion,
      threshold: row.threshold,
      points: row.points,
      sortOrder: row.sortOrder,
      isActive: row.isActive,
      earnedCount: row._count.unlocks,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
  })
}

// ── POST ─────────────────────

/**
 * Creating an achievement.
 *
 * `backfill` defaults TRUE, and that is the interesting decision. Most badges
 * are created for something users have ALREADY done -- "verified", "first
 * trade" -- and without a backfill a user who verified last month simply never
 * gets the badge until something re-triggers their evaluation. The backfill runs
 * the criteria engine over a bounded batch of users (see backfillAchievement)
 * and reports how many it granted, so the admin sees it did something.
 *
 * Set it false for a badge that should only be earned from now on -- e.g. a
 * seasonal or event badge where back-crediting would be wrong.
 */
const createSchema = z.strictObject({
  key: keySchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(400),
  icon: iconSchema.default("🏆"),
  imageUrl: imageUrlSchema.optional().default(null),
  criterion: criterionSchema,
  threshold: thresholdSchema.default(1),
  points: pointsSchema.default(0),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
  backfill: z.boolean().default(true),
  reason: z
    .string()
    .trim()
    .min(1, "A reason is required — it is written to the audit log")
    .max(1000),
})

export async function POST(req: NextRequest) {
  const gate = await requireRole("ADMIN")
  if (gate.response) return gate.response
  const actor = gate.actor

  const parsed = await parseJsonBody(req, createSchema)
  if (!parsed.ok) return parsed.response
  const { reason, backfill, ...definition } = parsed.data

  // The key is unique. Checking first gives a helpful conflict instead of a raw
  // unique-violation 500.
  const clash = await prisma.achievement.findUnique({
    where: { key: definition.key },
    select: { id: true, isActive: true },
  })
  if (clash) {
    return conflict(`An achievement with key "${definition.key}" already exists`, {
      code: "DUPLICATE_KEY",
      achievementId: clash.id,
      isActive: clash.isActive,
    })
  }

  // The definition and its audit row in ONE transaction, like every other
  // admin write: an audit row that can fail to exist for a change that did
  // happen is a log with holes in it.
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.achievement.create({ data: definition })
    await writeAudit(tx, {
      actorId: actor.id,
      action: "ACHIEVEMENT_CREATED",
      targetType: "ACHIEVEMENT",
      targetId: row.id,
      reason,
      detail: {
        key: row.key,
        name: row.name,
        criterion: row.criterion,
        threshold: row.threshold,
        points: row.points,
        imageUrl: row.imageUrl,
      },
    })
    return row
  })

  // The backfill is OUTSIDE the transaction, deliberately: it can touch many
  // users and must not hold the definition's transaction open against a large
  // scan. A definition that exists but is not yet back-filled is fine -- the
  // next user to open the achievements screen is evaluated anyway.
  const granted = backfill ? await backfillAchievement(created.id) : 0

  return ok({
    achievement: {
      id: created.id,
      key: created.key,
      name: created.name,
      description: created.description,
      icon: created.icon,
      imageUrl: created.imageUrl,
      criterion: created.criterion,
      threshold: created.threshold,
      points: created.points,
      sortOrder: created.sortOrder,
      isActive: created.isActive,
      earnedCount: granted,
    },
    backfilled: granted,
    audited: true,
  })
}
