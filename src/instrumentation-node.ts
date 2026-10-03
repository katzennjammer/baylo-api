// Node-runtime half of src/instrumentation.ts (the schema-v2 startup guard).
// A separate file because Next also bundles instrumentation.ts for the Edge
// runtime, where process.exit does not exist; this is imported only on Node.
const V2_CORE_TABLES = ["AuthToken", "ItemImage", "ItemWantedCategory", "ModerationCase", "UserProgress", "SwapCode", "Like", "Comment"]

export async function checkV2Database() {
  try {
    // Checked BEFORE importing @/lib/prisma, whose import constructs a client:
    // a throw from inside that import reaches here only as Turbopack's
    // "Failed to load chunk", with the reason gone.
    const { databaseSchema, assertV2Schema } = await import("@/lib/db-schema")
    const schema = databaseSchema()
    assertV2Schema(schema)
    const { default: prisma } = await import("@/lib/prisma")
    const rows = await prisma.$queryRaw<{ t: string; present: boolean }[]>`
      SELECT t, to_regclass(format('%I.%I', ${schema}::text, t)) IS NOT NULL AS present
        FROM unnest(${V2_CORE_TABLES}::text[]) AS t`
    const missing = rows.filter((r) => !r.present).map((r) => r.t)
    if (missing.length) {
      throw new Error(`[schema v2] REFUSING to start: schema "${schema}" has no ${missing.join(", ")} -- it is not a migrated v2 copy.`)
    }
    console.log(`  [schema v2] database: schema "${schema}" (v2 core tables present)`)
  } catch (e) {
    console.error(`\n${(e as Error).message}\n`)
    process.exit(1)
  }
}
