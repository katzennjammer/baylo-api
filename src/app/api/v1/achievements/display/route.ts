import { NextRequest } from "next/server"
import { z } from "zod"
import { Prisma } from "@/generated/prisma/client"
import { resolveSession } from "@/lib/api-auth"
import prisma, { databaseSchema } from "@/lib/prisma"
import { ok, unauthenticated } from "@/lib/v1/envelope"

const updateSchema = z.object({
  achievementIds: z.array(z.string()).default([]),
  featuredAchievementId: z.string().nullable().optional(),
})

export const dynamic = "force-dynamic"

/**
 * `"<schema>"."UserAchievement"`, for the raw statements below.
 *
 * ── WHY THE TABLE NAME IS NOT ENOUGH (23 Sep 2026) ──────────────────────────
 *
 * `src/lib/prisma.ts` hands `?schema=` to the driver adapter, which qualifies
 * the SQL PRISMA BUILDS. It does not rewrite a raw string, and nothing here
 * sets `search_path`, so a bare `"UserAchievement"` resolved against `public`
 * -- THE LIVE DATABASE -- however the URL read. Same bug, same day, as
 * `itemTable()` in @/lib/perishable; this route is where it actually had
 * something to destroy, because live carries real shelf rows.
 *
 * ── AND WHY THIS ONE CAN IMPORT `databaseSchema()` WHEN PERISHABLE CANNOT ───
 *
 * `itemTable()` re-parses `DATABASE_URL` by hand, and says why: importing
 * @/lib/prisma constructs a PrismaClient as a side effect, and @/lib/perishable
 * is handed its `db` precisely so that it owns no client. THAT REASONING DOES
 * NOT APPLY HERE. This module already imports the `prisma` singleton on the
 * line above -- the client is constructed by that import either way -- so
 * taking `databaseSchema()` from the same module costs nothing and is one
 * fewer copy of a parse that already exists three times (@/lib/prisma,
 * scripts/lib/live-guard.ts, @/lib/perishable). Import it; do not copy it.
 */
function userAchievementTable(): Prisma.Sql {
  return Prisma.raw(`"${databaseSchema().replace(/"/g, '""')}"."UserAchievement"`)
}

export async function PATCH(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()

  try {
    const body = await req.json().catch(() => ({}))
    const parsed = updateSchema.safeParse(body)
    if (!parsed.success) return ok({ ok: false, error: "Invalid payload" })

    const { achievementIds, featuredAchievementId } = parsed.data

    // ── EVERY VALUE BELOW IS A PARAMETER, NOT A PIECE OF STRING ─────────────
    //
    // These five statements used to be `$executeRawUnsafe` with the ids spliced
    // into the SQL text. Two of the splices -- both of `session.user.id` --
    // carried no escaping at all, on a PATCH any signed-in client can call, so
    // an id holding one apostrophe rewrote the WHERE clause: `x' OR '1'='1`
    // turns the blanket reset four lines down into "clear EVERY user's shelf".
    // The other splices escaped quotes by doubling them, which is the right
    // answer arrived at by hand and therefore the kind that is correct until
    // somebody adds a sixth statement.
    //
    // So the pattern is gone rather than patched: `$executeRaw` tagged
    // templates throughout, with `Prisma.join` building the variable-length
    // CASE and IN list out of parameters. `Prisma.raw` appears only for the
    // schema-qualified TABLE NAME, which is an identifier -- `$1` cannot be one
    // -- and which comes from this process's own DATABASE_URL, never from a
    // request. Same division as scripts/verify-org-cloudinary.ts.
    const table = userAchievementTable()
    const userId = session.user.id

    // Clear the whole shelf first, then set the picked order. The blanket reset
    // is what makes a badge the user REMOVED leave the shelf: an update scoped to
    // `achievementId IN (...)` could only ever touch the badges that stayed, so a
    // deselected badge kept its stale displayOrder and reappeared on the next
    // load. This also handles the empty selection (cleared shelf) correctly.
    await prisma.$executeRaw`
      UPDATE ${table}
         SET "displayOrder" = NULL
       WHERE "userId" = ${userId}`

    if (achievementIds.length > 0) {
      // `::int` is not decoration. Every THEN arm is a parameter and the ELSE is
      // NULL, so the CASE has no branch with a known type and Postgres refuses
      // it with "could not determine data type of parameter". One cast anchors
      // the whole expression.
      const whens = achievementIds.map(
        (id, index) => Prisma.sql`WHEN ${id} THEN ${index + 1}::int`,
      )
      await prisma.$executeRaw`
        UPDATE ${table}
           SET "displayOrder" = CASE "achievementId"
                 ${Prisma.join(whens, " ")}
                 ELSE NULL
               END
         WHERE "userId" = ${userId}
           AND "achievementId" IN (${Prisma.join(achievementIds)})`
    }

    // Feature-detect for a column that predates the migration that added it.
    // `table_schema` is part of the question, not a detail: without it this asks
    // "does ANY schema have the column", so a scratch schema that lacks it would
    // be told it has it, on the strength of `public` -- and then the qualified
    // UPDATE below would fail against the table that actually does not.
    const schema = databaseSchema()
    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = ${schema}
        AND table_name = 'UserAchievement'
        AND column_name = 'homeDisplayOrder'
    `

    if (columns.length > 0) {
      if (featuredAchievementId) {
        await prisma.$executeRaw`
          UPDATE ${table}
             SET "homeDisplayOrder" = CASE "achievementId"
                   WHEN ${featuredAchievementId} THEN 1
                   ELSE NULL
                 END
           WHERE "userId" = ${userId}`
      } else {
        await prisma.$executeRaw`
          UPDATE ${table}
             SET "homeDisplayOrder" = NULL
           WHERE "userId" = ${userId}`
      }
    } else if (featuredAchievementId && achievementIds.length > 0) {
      await prisma.$executeRaw`
        UPDATE ${table}
           SET "displayOrder" = CASE "achievementId"
                 WHEN ${featuredAchievementId} THEN 1
                 ELSE "displayOrder"
               END
         WHERE "userId" = ${userId}
           AND "achievementId" = ${featuredAchievementId}`
    }

    return ok({ ok: true })
  } catch {
    return ok({ ok: false, error: "Could not update achievements" })
  }
}
