// Which database schema this process talks to, and the schema-v2 rule about it.
//
// Its own module, with NO side effects, so the startup guard in
// src/instrumentation.ts can check the schema BEFORE @/lib/prisma constructs a
// client. (When the client's constructor threw first, Turbopack reported it as
// "Failed to load chunk ..." and the reason was lost.) @/lib/prisma re-exports
// both functions, so existing imports keep working.

/** The schema this process talks to. "public" is live. Scripts print it so a run says where it ran. */
export function databaseSchema(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? "").searchParams.get("schema") ?? "public"
  } catch {
    return "public"
  }
}

/**
 * SCHEMA V2 GUARD (feature/schema-v2 only). Throws unless `schema` is a
 * schema_v2_* scratch schema: this branch's code speaks the 25-table schema,
 * and `public` (live) is still pre-v2. REMOVE ONLY AS THE LAST STEP OF THE
 * WEEK-3 CUTOVER, after live has been migrated.
 */
export function assertV2Schema(schema: string): void {
  if (!/^schema_v2_[a-z0-9_]+$/.test(schema)) {
    throw new Error(
      `[schema v2] REFUSING to connect to schema "${schema}"` +
        (schema === "public" ? " -- that is the LIVE database, which is still pre-v2." : ".") +
        " This branch runs only against a schema_v2_* copy: start it with `npm run dev:v2`" +
        " (or `npm run v2:tsx -- <script>`), which reads .env.v2.",
    )
  }
}
