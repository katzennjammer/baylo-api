/**
 * Escape a user's search text for Prisma `contains` / `startsWith` /
 * `endsWith` on PostgreSQL.
 *
 * Prisma turns `contains: q` into `LIKE '%' || q || '%'` (ILIKE with
 * mode "insensitive") WITHOUT escaping q, so `%` and `_` inside it are
 * wildcards. Searching people for "__" matched every account, and "ia_s"
 * matched "Maria Santos". Backslash is PostgreSQL's default LIKE escape, so it
 * is escaped first and then put in front of the two wildcards.
 */
export function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`)
}
