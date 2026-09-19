import pg from "pg"
import "dotenv/config"
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()
const u = await c.query('SELECT id, name, email FROM "User" WHERE name ILIKE $1 LIMIT 5', ["%Aya%"])
console.log("USERS:", JSON.stringify(u.rows))
for (const person of u.rows) {
  const rows = await c.query('SELECT ua."achievementId", a.key, a.name, ua."displayOrder", ua."homeDisplayOrder", ua."unlockedAt" FROM "UserAchievement" ua JOIN "Achievement" a ON a.id = ua."achievementId" WHERE ua."userId" = $1 ORDER BY ua."displayOrder" NULLS LAST', [person.id])
  console.log("  " + person.name + " rows:")
  rows.rows.forEach(function (r) { console.log("    " + r.key + " display=" + r.displayOrder + " home=" + r.homeDisplayOrder) })
}
await c.end()
