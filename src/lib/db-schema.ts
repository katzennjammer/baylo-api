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
 * SCHEMA V2 GUARD, POST-CUTOVER FORM (branch feature/schema-v2-post-cutover).
 *
 * Before the cutover this refused every schema except a schema_v2_* copy,
 * because `public` was still pre-v2. After the cutover `public` IS v2, so the
 * rule is no longer about the NAME: this branch's code must never run against
 * a PRE-V2 schema, whatever it is called.
 *
 * This synchronous half (called by @/lib/prisma when it builds the client)
 * only refuses names that cannot be an app schema. The real gate is the
 * layout check in src/instrumentation-node.ts, which runs at server startup
 * and refuses any schema that lacks the v2 tables or still has the pre-v2
 * ones. That includes `public` if this branch is ever started before the
 * migration has run. scripts/lib/live-guard.ts still gates every script
 * that writes to `public`.
 *
 * DO NOT MERGE THIS BRANCH until live has been migrated
 * (docs/cutover-runbook.md, section 7).
 */
export function assertV2Schema(schema: string): void {
  if (schema !== "public" && !/^(schema_v2_|scratch_)[a-z0-9_]+$/.test(schema)) {
    throw new Error(
      `[schema v2] REFUSING to connect to schema "${schema}": the app runs on "public" (live, v2 since the cutover), ` +
        "a schema_v2_* copy or a scratch_* schema.",
    )
  }
}

/**
 * Tables that exist ONLY in the v2 layout, and tables that exist ONLY before it.
 * "Category" (8 Oct 2026, 20261008000000_category_lookup_table) is here so that
 * this code refuses to START on a database that has not had that migration,
 * rather than failing every listing query with a missing "categoryId" column.
 */
export const V2_ONLY_TABLES = ["AuthToken", "ItemImage", "ItemWantedCategory", "ModerationCase", "UserProgress", "SwapCode", "Like", "Comment", "Trade", "Category"] as const
export const PRE_V2_ONLY_TABLES = ["Offer", "TradeRequest", "TaskCompletion", "RefreshToken", "OrganizationMember", "QuestAssignment", "UserAchievement", "Report", "ListingAppeal"] as const

/** "v2" only when every v2 table is present and every pre-v2 table is gone. Pure, so it is testable without a database. */
export function layoutVerdict(present: ReadonlySet<string>): { ok: boolean; missing: string[]; leftover: string[] } {
  const missing = V2_ONLY_TABLES.filter((t) => !present.has(t))
  const leftover = PRE_V2_ONLY_TABLES.filter((t) => present.has(t))
  return { ok: missing.length === 0 && leftover.length === 0, missing, leftover }
}
