// Node-runtime half of src/instrumentation.ts (the schema-v2 startup guard).
// A separate file because Next also bundles instrumentation.ts for the Edge
// runtime, where process.exit does not exist; this is imported only on Node.
const V2_CORE_TABLES = ["AuthToken", "ItemImage", "ItemWantedCategory", "ModerationCase", "UserProgress", "SwapCode", "Like", "Comment"]

// ── THE POOL CHECK ───────────────────────────────────────────────────────────
//
// The v2 server has to run on the SESSION pooler (5432): the search_path pin in
// @/lib/prisma is a startup parameter, and the transaction pooler cannot be
// trusted to keep it -- raw SQL would fall back to public, which is live. The
// session pooler's weakness is the one @/lib/prisma's header describes: a client
// killed without a clean close keeps its connections reserved until the pooler
// times them out (tens of minutes), and new clients QUEUE behind them. On
// 3 Oct 2026 that surfaced as the first login failing with "Connection
// terminated due to connection timeout" after 10 s -- a 500 that read like a
// code bug. So the first query is timed here, at startup, and says what it is.
const SLOW_MS = 5_000
const POOL_BUSY_HINT =
  "The database pool is busy: connections from a server or script that was stopped " +
  "abruptly are still reserved on the Supabase session pooler. Wait 15–30 min for " +
  "them to be released, or restart the pooler (Supabase dashboard → Database → " +
  "Connection pooling), then start the server again."

/** Errors that mean "the pooler did not give us a connection in time", not "the query was wrong". */
function isPoolBusy(e: unknown): boolean {
  const text = `${(e as Error)?.message ?? ""} ${String((e as { cause?: unknown })?.cause ?? "")}`
  return /connection timeout|timeout exceeded when trying to connect|terminated unexpectedly|ETIMEDOUT|too many clients|max.?client/i.test(text)
}

export async function checkV2Database() {
  try {
    // Checked BEFORE importing @/lib/prisma, whose import constructs a client:
    // a throw from inside that import reaches here only as Turbopack's
    // "Failed to load chunk", with the reason gone.
    const { databaseSchema, assertV2Schema } = await import("@/lib/db-schema")
    const schema = databaseSchema()
    assertV2Schema(schema)
    const { default: prisma } = await import("@/lib/prisma")

    const t0 = Date.now()
    let rows: { t: string; present: boolean }[]
    try {
      rows = await prisma.$queryRaw<{ t: string; present: boolean }[]>`
        SELECT t, to_regclass(format('%I.%I', ${schema}::text, t)) IS NOT NULL AS present
          FROM unnest(${V2_CORE_TABLES}::text[]) AS t`
    } catch (e) {
      if (isPoolBusy(e)) {
        throw new Error(`[schema v2] REFUSING to start: no database connection after ${Date.now() - t0} ms. ${POOL_BUSY_HINT}`)
      }
      throw e
    }
    const elapsed = Date.now() - t0

    const missing = rows.filter((r) => !r.present).map((r) => r.t)
    if (missing.length) {
      throw new Error(`[schema v2] REFUSING to start: schema "${schema}" has no ${missing.join(", ")} -- it is not a migrated v2 copy.`)
    }
    console.log(`  [schema v2] database: schema "${schema}" (v2 core tables present, first connection ${elapsed} ms)`)
    // Slow but answered: start anyway, and say why requests may time out.
    if (elapsed > SLOW_MS) {
      console.warn(`  [schema v2] WARNING: the first database connection took ${elapsed} ms. ${POOL_BUSY_HINT}`)
    }
  } catch (e) {
    console.error(`\n${(e as Error).message}\n`)
    process.exit(1)
  }
}
