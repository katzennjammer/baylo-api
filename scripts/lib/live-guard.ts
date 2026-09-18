/**
 * THE ONE PLACE A SCRIPT IS ALLOWED TO DECIDE IT MAY WRITE TO LIVE.
 *
 * ── WHY THIS EXISTS (17 Sep 2026) ───────────────────────────────────────────
 *
 * Twice in two days a script wrote to the live Supabase database while
 * reporting that it had not. `prisma/seed.ts` built its own adapter and ignored
 * `?schema=`, so `scratch.ps1 -Seed` seeded LIVE and said "seeded scratch_x".
 * Two acceptance harnesses did the same through the shared client before the
 * adapter learned about schemas. Neither did damage, and neither was prevented
 * from doing damage -- they were idempotent, which is luck.
 *
 * The fix at the time was to PRINT the schema. A print is not a guard: it tells
 * you what happened after it has happened, and only if somebody was watching
 * the scrollback. So every script in this repo that writes a row calls
 * `requireScratchSchema()` on its first line, and the rule it enforces is:
 *
 *     A script refuses `public` unless the operator typed --live.
 *
 * `public` IS the live database. There is no staging copy, the free tier has no
 * automatic backups, and `scratch.ps1` exists precisely so that development
 * never needs to touch it. The flag is deliberately ugly to type, deliberately
 * absent from every documented invocation, and deliberately not inferrable from
 * an environment variable -- a CI runner, a stale shell or a copy-pasted
 * command cannot supply it by accident the way `FORCE=1` can.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 *
 * It is not a permission system and it does not protect the database from a
 * determined operator; `--live` is right there. It removes the ACCIDENT: the
 * wrong terminal, the forgotten `-Run`, the URL whose `?schema=` was dropped by
 * a PowerShell `?` gotcha. Every one of those now stops with a refusal naming
 * the schema instead of quietly rewriting thirty user rows.
 *
 * Read-only scripts (check-new-enum-rows, pg-backup, analyze-*) do NOT call
 * this. Reading live is the normal, correct thing for them to do.
 */

/**
 * The schema the URL points at. `public` is live.
 *
 * MIRRORS `databaseSchema()` in @/lib/prisma, four lines, on purpose: importing
 * that module constructs a PrismaClient as a side effect of the import, and a
 * guard that opens a connection pool before deciding whether it is allowed to
 * run has already lost the argument. Both parse the same parameter the Prisma
 * CLI does; if one changes, change the other.
 */
export function targetSchema(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? "").searchParams.get("schema") ?? "public"
  } catch {
    return "public"
  }
}

export function isLiveSchema(): boolean {
  return targetSchema() === "public"
}

/** Whether the operator typed `--live` on the command line. Nothing else counts. */
export function liveFlagPassed(): boolean {
  return process.argv.slice(2).includes("--live")
}

/**
 * Call FIRST, before opening a client or writing anything. Returns the schema
 * it approved so the caller can print it; exits 1 rather than throwing, because
 * a throw inside a harness's own try/catch is how a guard gets swallowed.
 *
 * @param scriptName how the script is invoked, quoted back in the refusal so
 *                   the operator can see what to re-run.
 */
export function requireScratchSchema(scriptName: string): string {
  const schema = targetSchema()

  if (schema !== "public") {
    console.log(`  schema: ${schema}  (scratch)`)
    return schema
  }

  if (liveFlagPassed()) {
    console.log("")
    console.log("  ####################################################################")
    console.log("  #  WRITING TO THE LIVE DATABASE (schema: public) -- --live passed  #")
    console.log("  ####################################################################")
    console.log("")
    return schema
  }

  console.error("")
  console.error(`  REFUSING TO RUN: ${scriptName} writes rows, and DATABASE_URL points at`)
  console.error("  schema `public`, which is the live database. There are no automatic")
  console.error("  backups on this tier.")
  console.error("")
  console.error("  Run it on a throwaway schema instead:")
  console.error(`      .\\scripts\\scratch.ps1 -Run ${scriptName}`)
  console.error("")
  console.error("  If you genuinely mean live -- a one-off backfill, a production seed --")
  console.error("  take a backup first (scripts\\backup-baylo-pg.ps1) and pass --live:")
  console.error(`      npx tsx --tsconfig tsconfig.json ${scriptName} --live`)
  console.error("")
  process.exit(1)
}
