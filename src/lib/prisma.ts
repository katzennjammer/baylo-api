import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

// Postgres (Supabase) via the pg driver adapter. Prisma 7's `prisma-client`
// generator has no built-in engine, so an adapter is required, not optional.
//
// The pool is small on purpose. Supabase's session pooler hands each client a
// real backend for the life of its connection, and the free tier allows few of
// them; a dev server hot-reloading with a 10-connection default would exhaust
// that on its own. Five is plenty for one dev server plus one script.
//
// ── `?schema=` IS HONOURED HERE, NOT BY THE DRIVER ──────────────────────────
//
// The Prisma CLI reads a `schema` query parameter (so `db push` and `migrate`
// build tables in that schema), but the pg driver does not know the parameter
// and the adapter only targets a schema if told to in its options. Until 16
// Sep 2026 that meant a URL ending in `?schema=scratch_x` pushed tables to
// `scratch_x` and then READ AND WROTE `public` -- a test harness believing it
// was on a scratch schema was on the live one. The parameter is parsed off
// the URL and handed to the adapter, so one URL means one schema everywhere.
// No parameter means `public`, which is the live database.
function createPrismaClient() {
  const raw = process.env.DATABASE_URL!
  const schema = databaseSchema()
  // The live URL is passed through UNTOUCHED. Only a scratch URL is
  // re-serialised (to strip the parameter pg would choke on), so nothing about
  // how the production string is parsed changed on 16 Sep 2026.
  let connectionString = raw
  if (schema !== "public") {
    const url = new URL(raw)
    url.searchParams.delete("schema")
    connectionString = url.toString()
  }
  const adapter = new PrismaPg(
    { connectionString, max: 5 },
    schema !== "public" ? { schema } : undefined,
  )
  return new PrismaClient({ adapter })
}

/** The schema this process talks to. "public" is live. Scripts print it so a run says where it ran. */
export function databaseSchema(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? "").searchParams.get("schema") ?? "public"
  } catch {
    return "public"
  }
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma

export default prisma
