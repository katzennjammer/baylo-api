// Runs once when the Next.js server starts.
//
// SCHEMA V2 STARTUP GUARD (feature/schema-v2 only). The server refuses to
// start -- the process exits -- unless DATABASE_URL names a schema_v2_* schema
// AND that schema actually has the v2 core tables. The first half is the same
// rule src/lib/prisma.ts enforces on every client; the second catches a v2
// URL pointing at a schema that was never migrated (or was dropped), which
// would otherwise surface as a 500 on the first request instead of at boot.
//
// Only the core tables are required: the ledger (#20) and trade (#18) parts
// may be held back at the go/no-go, and the app must still start without them.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { checkV2Database } = await import("./instrumentation-node")
    await checkV2Database()
  }
}
