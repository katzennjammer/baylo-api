/**
 * A READ-ONLY fingerprint of live `public`, for tests that must prove they
 * left live untouched: per-table row counts, the ledger figures, the catalog
 * fingerprint (classes, types, enum labels, columns, constraints, functions,
 * default ACLs: oid + xmin) and the _prisma_migrations rows. Take one before
 * and one after; any difference is a failure.
 */
import { Client } from "pg"
import { LEDGER_INVARIANT_SQL, figuresFromRow } from "./ledger-invariant"
import { catalogFingerprint } from "./migration-runner"

export function liveUrl(): string {
  const u = new URL(process.env.DATABASE_URL ?? "")
  u.searchParams.delete("schema")
  return u.toString()
}

export async function liveSnapshot(): Promise<{ text: string; summary: string }> {
  const pg = new Client({ connectionString: liveUrl() })
  await pg.connect()
  try {
    await pg.query(`SET SESSION default_transaction_read_only = on`)
    if ((await pg.query(`SHOW default_transaction_read_only`)).rows[0].default_transaction_read_only !== "on") throw new Error("snapshot session is not read-only")
    await pg.query(`BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`)
    const tables = (await pg.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.tablename as string)
    const counts: string[] = []
    for (const t of tables) counts.push(`${t}=${(await pg.query(`SELECT count(*) n FROM public."${t}"`)).rows[0].n}`)
    const v2 = (await pg.query(`SELECT to_regclass('public."Trade"') IS NOT NULL AS v2`)).rows[0].v2
    const f = figuresFromRow((await pg.query(LEDGER_INVARIANT_SQL("public", v2 ? "v2" : "v1"))).rows[0])
    const fp = await catalogFingerprint(pg, "public")
    const migs = (await pg.query(`SELECT md5(string_agg(id || migration_name || checksum || coalesce(finished_at::text,'') || coalesce(rolled_back_at::text,''), ',' ORDER BY id)) m, count(*) n FROM public."_prisma_migrations"`)).rows[0]
    await pg.query("ROLLBACK")
    const total = counts.reduce((a, c) => a + Number(c.split("=")[1]), 0)
    return {
      text: JSON.stringify({ counts, ledger: f, fp, migs }),
      summary: `${tables.length} tables, ${total} rows, ledger ${f.userLeaves}/${f.userLeaves + f.escrow}/${f.escrow}, catalog ${fp.slice(0, 10)}, ${migs.n} migration rows`,
    }
  } finally { await pg.end() }
}
