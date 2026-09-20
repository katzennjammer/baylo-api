import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

// Postgres (Supabase) via the pg driver adapter. Prisma 7's `prisma-client`
// generator has no built-in engine, so an adapter is required, not optional.
//
// ── WHICH POOLER, AND WHY THE APP DOES NOT USE `DATABASE_URL` DIRECTLY ──────
//
// `DATABASE_URL` is the SESSION pooler (port 5432). It has to be: `prisma
// migrate`, pg-backup's drill and drop-scratch-schema all need a connection
// that stays on one backend (advisory locks, `SET search_path`). But the app
// must NOT run on it. In session mode every pooled connection pins one of the
// tenant's few backends for the life of the TCP connection, and a client that
// dies without a clean close -- a hard-killed `next dev`, a hotspot/Wi-Fi
// switch, a sleeping laptop -- leaves that backend stranded until the
// server-side keepalive gives up on it (tens of minutes to hours). Once enough
// of those pile up the pooler QUEUES every new client instead of refusing it,
// which is what a 30-78s login or admin page was: the wait for a stranded
// backend to be reaped. That is why the numbers were so large and so variable
// with only two queries in the route.
//
// The TRANSACTION pooler (port 6543) lends a backend per transaction and hands
// it straight back, so a dead client strands nothing. Nothing the app sends
// through Prisma needs session state (no SET, no advisory locks, no LISTEN;
// interactive transactions hold one checked-out client for their duration,
// which is the one thing transaction mode guarantees), so it is the right fit.
// `DATABASE_POOL_URL` is that string when set; otherwise the session URL is
// used as before, so a fresh clone with only `DATABASE_URL` still runs. It is
// ONLY consulted for the live (`public`) schema: a harness that points
// `DATABASE_URL` at `?schema=scratch_x` gets that URL, never the pool one --
// otherwise a `.env` pool URL would put a "scratch" run back on live data,
// the exact hazard the section below exists to prevent.
//
// `connectionTimeoutMillis` is the other half. pg's default is 0 -- wait
// forever -- so an unresponsive pooler turned into a request that hung for as
// long as the client was willing to wait, then failed with no error anyone
// could read. Ten seconds is longer than any healthy handshake and shorter
// than the native client's request timeout, so the failure is now a real
// error in the server log rather than a silent stall.
//
// The pool is small on purpose: five is plenty for one dev server plus one
// script, and stays under the tenant's backend count even on the session URL.
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
  const schema = databaseSchema()
  const raw = (schema === "public" && process.env.DATABASE_POOL_URL) || process.env.DATABASE_URL!
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
    { connectionString, max: 5, connectionTimeoutMillis: 10_000 },
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
