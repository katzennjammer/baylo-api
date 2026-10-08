// Put the 20 Category rows into a schema built by `prisma db push`.
//
//   DATABASE_URL=...?schema=scratch_x npx tsx --env-file=.env scripts/seed-categories.ts
//
// scripts/scratch.ps1 runs this after every push. SCRATCH ONLY: the live
// database got its rows from the migration and never needs this, so there is
// no --live escape hatch here at all.
import "dotenv/config"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { seedCategories } from "../prisma/category-seed"
import { targetSchema } from "./lib/live-guard"

const schema = targetSchema()
if (schema === "public") {
  console.error("  REFUSING: seed-categories.ts runs on scratch schemas only (DATABASE_URL has no ?schema=)")
  process.exit(1)
}
const u = new URL(process.env.DATABASE_URL!)
u.searchParams.delete("schema")
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: u.toString(), max: 1 }, { schema }) })

seedCategories(prisma)
  .then((n) => console.log(`  categories: ${n} rows in ${schema}`))
  .catch((e) => { console.error(`  seed-categories failed: ${(e as Error).message}`); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
