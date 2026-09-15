import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

// Postgres (Supabase) via the pg driver adapter. Prisma 7's `prisma-client`
// generator has no built-in engine, so an adapter is required, not optional.
//
// The pool is small on purpose. Supabase's session pooler hands each client a
// real backend for the life of its connection, and the free tier allows few of
// them; a dev server hot-reloading with a 10-connection default would exhaust
// that on its own. Five is plenty for one dev server plus one script.
function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 5 })
  return new PrismaClient({ adapter })
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma

export default prisma
