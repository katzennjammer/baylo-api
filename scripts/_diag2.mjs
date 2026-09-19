import pg from "pg"
import "dotenv/config"
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()
// Simulate what the app sends when only ONE badge is picked: reset then set one.
const uid = "seed-u-aya"
await c.query('BEGIN')
await c.query('UPDATE "UserAchievement" SET "displayOrder" = NULL, "homeDisplayOrder" = NULL WHERE "userId" = $1', [uid])
const one = await c.query('SELECT "achievementId" FROM "UserAchievement" ua JOIN "Achievement" a ON a.id = ua."achievementId" WHERE ua."userId" = $1 AND a.key = $2', [uid, "FIRST_LISTING"])
await c.query('UPDATE "UserAchievement" SET "displayOrder" = 1 WHERE "userId" = $1 AND "achievementId" = $2', [uid, one.rows[0].achievementId])
const after = await c.query('SELECT a.key, ua."displayOrder" FROM "UserAchievement" ua JOIN "Achievement" a ON a.id = ua."achievementId" WHERE ua."userId" = $1 ORDER BY ua."displayOrder" NULLS LAST', [uid])
console.log("AFTER single-pick save:", JSON.stringify(after.rows))
await c.query('ROLLBACK')
console.log("(rolled back - no data changed)")
await c.end()
