// Runs once when the Next.js server starts.
//
// SCHEMA V2 STARTUP GUARD, POST-CUTOVER FORM (feature/schema-v2-post-cutover).
// The server refuses to start -- the process exits -- unless the schema
// DATABASE_URL names is in the FULL v2 layout: every v2-only table present
// and every pre-v2-only table gone (layoutVerdict in @/lib/db-schema). That
// holds for `public` too. If this branch is started against live before the
// migration has run, it refuses at boot instead of serving 500s.
//
// The full layout is required, not just the core: this branch's code reads
// Trade and the merged ledger (phases B and C), so a copy with a part held
// back is not one it can run on.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { checkV2Database } = await import("./instrumentation-node")
    await checkV2Database()
  }
}
