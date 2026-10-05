// Which Prisma CLI commands may touch which schema (post-cutover form).
//
// Used by prisma.config.ts; pure, so scripts/schema-v2/test-post-cutover-guards.ts
// tests it without a database.
//
// On a scratch copy (schema_v2_* or scratch_*) every command is allowed.
// On `public` (LIVE) and any other schema only the commands that read the
// migration state or apply PENDING migrations are allowed:
//
//   migrate status | deploy | diff | resolve
//
// Everything else that touches a database is refused there. That includes
// `migrate reset` (drops everything), `migrate dev` (may ask to reset, and
// writes migrations from drift), `db push` (rewrites tables to match the
// schema, dropping columns), `db execute`, `db pull`, `db seed`, `studio` and
// `introspect`. Commands that need no database (generate, validate, format)
// are never inspected.
export const DB_COMMANDS = new Set(["migrate", "db", "studio", "introspect"])
export const LIVE_ALLOWED = new Set(["migrate status", "migrate deploy", "migrate diff", "migrate resolve"])

export function commandOf(argv: string[]): string | null {
  const words = argv.filter((a) => !a.startsWith("-"))
  const i = words.findIndex((w) => DB_COMMANDS.has(w))
  if (i === -1) return null
  return words[i + 1] && (words[i] === "migrate" || words[i] === "db") ? `${words[i]} ${words[i + 1]}` : words[i]
}

export function schemaOf(url: string | undefined): string {
  try { return new URL(url ?? "").searchParams.get("schema") ?? "public" } catch { return "public" }
}

/** null = allowed; otherwise the refusal message. */
export function refusal(argv: string[], url: string | undefined): string | null {
  const command = commandOf(argv)
  if (!command) return null
  const schema = schemaOf(url)
  if (/^(schema_v2_|scratch_)[a-z0-9_]+$/.test(schema)) return null
  if (LIVE_ALLOWED.has(command)) return null
  return `\n  [schema v2] REFUSING: \`prisma ${argv.join(" ")}\` against schema "${schema}"${schema === "public" ? " (LIVE)" : ""}.` +
    `\n  On that schema only ${[...LIVE_ALLOWED].map((c) => `\`prisma ${c}\``).join(", ")} may run.` +
    `\n  Rehearse anything else on a schema_v2_* copy: \`npm run v2:prisma -- <command>\`.\n`
}
