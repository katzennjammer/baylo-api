/**
 * Take Supabase's PostgREST roles (anon, authenticated) off a schema.
 *
 * ── WHY (found 4 Oct 2026, read-only on live) ───────────────────────────────
 *
 * On live, `anon` and `authenticated` hold every privilege (SELECT, INSERT,
 * UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER) on all 35 tables in
 * `public`, and RLS is off on every table. Supabase's default ACLs in
 * `public` give each new table the same grants, so the 25 v2 tables would
 * inherit them. Anyone holding the project's anon key could read and rewrite
 * every row through PostgREST. Nothing in Baylo uses those roles: the API
 * reaches Postgres as `postgres` through Prisma, and neither the mobile app
 * nor the admin web carries supabase-js, a PostgREST URL, or an anon key
 * (grep, 5 Oct 2026).
 *
 * `service_role` and `postgres` are left exactly as they are.
 *
 * ── WHAT IT DOES, in one caller-owned transaction ───────────────────────────
 *   1  REVOKE ALL on every table, sequence and routine in the schema
 *   2  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA ... REVOKE ALL,
 *      so a table created later by postgres (every migration) gets nothing
 *   3  the same for supabase_admin's defaults in that schema, when this role
 *      is allowed to change them (reported, not assumed)
 *
 * Routines carry a GLOBAL default grant, EXECUTE to PUBLIC, which
 * anon inherits, and a per-schema REVOKE cannot remove a global default
 * (Postgres docs, ALTER DEFAULT PRIVILEGES). `public` has no functions today
 * and no migration creates one. So this is reported, not changed: changing
 * it is a database-wide decision.
 */
import type { Client } from "pg"

export const API_ROLES = ["anon", "authenticated"] as const
type Q = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>

export function lockdownStatements(schema: string, owner: "postgres" | "supabase_admin"): string[] {
  const s = `"${schema.replace(/"/g, "")}"`, roles = API_ROLES.join(", ")
  if (owner === "supabase_admin") return [
    `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA ${s} REVOKE ALL ON TABLES FROM ${roles}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA ${s} REVOKE ALL ON SEQUENCES FROM ${roles}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA ${s} REVOKE ALL ON FUNCTIONS FROM ${roles}`,
  ]
  return [
    `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${s} FROM ${roles}`,
    `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${s} FROM ${roles}`,
    `REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA ${s} FROM ${roles}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA ${s} REVOKE ALL ON TABLES FROM ${roles}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA ${s} REVOKE ALL ON SEQUENCES FROM ${roles}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA ${s} REVOKE ALL ON FUNCTIONS FROM ${roles}`,
  ]
}

/** The reverse, for the runbook's undo. Restores live's shape as measured on 4 Oct 2026. */
export function undoStatements(schema: string): string[] {
  const s = `"${schema.replace(/"/g, "")}"`, roles = API_ROLES.join(", ")
  return [
    `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${s} TO ${roles}`,
    `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${s} TO ${roles}`,
    `GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA ${s} TO ${roles}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA ${s} GRANT ALL ON TABLES TO ${roles}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA ${s} GRANT ALL ON SEQUENCES TO ${roles}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA ${s} GRANT ALL ON FUNCTIONS TO ${roles}`,
  ]
}

export interface Exposure {
  tables: number; tablesExposed: number; sequencesExposed: number; routinesExposed: number
  defaultAclExposed: string[]; serviceRoleTables: number; postgresTables: number
}

/** Read-only: how much of `schema` the API roles can reach. */
export async function exposure(query: Q | Client, schema: string): Promise<Exposure> {
  const qq: Q = typeof (query as Client).query === "function" ? (sql, p) => (query as Client).query(sql, p) : (query as Q)
  const one = async (sql: string) => Number(Object.values((await qq(sql, [schema])).rows[0])[0])
  const anyPriv = (role: string, kind: "TABLE" | "SEQUENCE") => kind === "TABLE"
    ? `(has_table_privilege('${role}', c.oid, 'SELECT') OR has_table_privilege('${role}', c.oid, 'INSERT') OR has_table_privilege('${role}', c.oid, 'UPDATE') OR has_table_privilege('${role}', c.oid, 'DELETE') OR has_table_privilege('${role}', c.oid, 'TRUNCATE') OR has_table_privilege('${role}', c.oid, 'REFERENCES') OR has_table_privilege('${role}', c.oid, 'TRIGGER'))`
    : `(has_sequence_privilege('${role}', c.oid, 'USAGE') OR has_sequence_privilege('${role}', c.oid, 'SELECT') OR has_sequence_privilege('${role}', c.oid, 'UPDATE'))`
  const ns = `(SELECT oid FROM pg_namespace WHERE nspname = $1)`
  const api = (kind: "TABLE" | "SEQUENCE") => API_ROLES.map((r) => anyPriv(r, kind)).join(" OR ")
  return {
    tables: await one(`SELECT count(*) FROM pg_class c WHERE c.relnamespace = ${ns} AND c.relkind IN ('r','p','v','m','f')`),
    tablesExposed: await one(`SELECT count(*) FROM pg_class c WHERE c.relnamespace = ${ns} AND c.relkind IN ('r','p','v','m','f') AND (${api("TABLE")})`),
    sequencesExposed: await one(`SELECT count(*) FROM pg_class c WHERE c.relnamespace = ${ns} AND c.relkind = 'S' AND (${api("SEQUENCE")})`),
    // Via an explicit grant to anon/authenticated. EXECUTE through PUBLIC is
    // the global default and is reported separately by the caller.
    routinesExposed: await one(`SELECT count(*) FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      WHERE p.pronamespace = ${ns} AND a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon','authenticated'))`),
    defaultAclExposed: (await qq(`SELECT pg_get_userbyid(d.defaclrole) || '/' || d.defaclobjtype::text || ' -> ' || r.rolname AS e
      FROM pg_default_acl d, LATERAL aclexplode(d.defaclacl) a JOIN pg_roles r ON r.oid = a.grantee
      WHERE d.defaclnamespace = ${ns} AND r.rolname IN ('anon','authenticated') GROUP BY 1 ORDER BY 1`, [schema])).rows.map((r) => String(r.e)),
    serviceRoleTables: await one(`SELECT count(*) FROM pg_class c WHERE c.relnamespace = ${ns} AND c.relkind = 'r' AND has_table_privilege('service_role', c.oid, 'SELECT')`),
    postgresTables: await one(`SELECT count(*) FROM pg_class c WHERE c.relnamespace = ${ns} AND c.relkind = 'r' AND has_table_privilege('postgres', c.oid, 'SELECT') AND has_table_privilege('postgres', c.oid, 'INSERT')`),
  }
}

export function describe(e: Exposure): string {
  return `tables ${e.tablesExposed}/${e.tables} reachable by anon/authenticated; sequences ${e.sequencesExposed}; routines ${e.routinesExposed}; ` +
    `default ACLs granting them: ${e.defaultAclExposed.length ? e.defaultAclExposed.join(", ") : "none"}; ` +
    `service_role reads ${e.serviceRoleTables} tables; postgres reads+writes ${e.postgresTables}`
}
