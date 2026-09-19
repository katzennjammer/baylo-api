import Link from "next/link"
import prisma from "@/lib/prisma"

export const dynamic = "force-dynamic"
export const revalidate = 0

/**
 * /admin/audit — the moderation log, readable.
 *
 * An audit trail nobody can read is a table, not an audit trail. The point of
 * writing AdminAction rows is that somebody can afterwards ask "who suspended
 * this account, and what reason did they give" and get an answer without a
 * database prompt.
 *
 * Filters are URL-backed so an investigation can be bookmarked and shared.
 */

const th: React.CSSProperties = { padding: "10px 12px", textAlign: "left", color: "#888", fontSize: 12 }
const td: React.CSSProperties = { padding: "10px 12px", fontSize: 13, verticalAlign: "top" }

const ACTION_COLOR: Record<string, string> = {
  REPORT_REVIEWING: "#1d4ed8",
  REPORT_DISMISSED: "#6b7280",
  REPORT_ACTIONED: "#15803d",
  LISTING_HIDDEN: "#b91c1c",
  LISTING_UNHIDDEN: "#15803d",
  USER_SUSPENDED: "#b91c1c",
  USER_UNSUSPENDED: "#15803d",
  LISTING_VALUE_APPROVED: "#15803d",
  LISTING_VALUE_REJECTED: "#b45309",
  LISTING_APPEAL_UPHELD: "#7c2d12",
  LISTING_APPEAL_OVERTURNED: "#15803d",
  ACHIEVEMENT_CREATED: "#15803d",
  ACHIEVEMENT_UPDATED: "#1d4ed8",
  ACHIEVEMENT_DEACTIVATED: "#b91c1c",
  ACHIEVEMENT_REACTIVATED: "#15803d",
}

const TARGET_TYPES = ["REPORT", "LISTING", "USER", "HUB", "ID_VERIFICATION", "TRADE", "LISTING_APPEAL", "ACHIEVEMENT"] as const

interface Props {
  searchParams: Promise<{
    actorId?: string
    targetType?: string
    targetId?: string
    from?: string
    to?: string
  }>
}

export default async function AuditPage({ searchParams }: Props) {
  const sp = await searchParams
  const actorId = sp.actorId?.trim() || undefined
  const targetType = (TARGET_TYPES as readonly string[]).includes(sp.targetType ?? "")
    ? (sp.targetType as (typeof TARGET_TYPES)[number])
    : undefined
  const targetId = sp.targetId?.trim() || undefined
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? "") ? sp.from : undefined
  const to = /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? "") ? sp.to : undefined
  const fromDate = from ? new Date(`${from}T00:00:00.000Z`) : undefined
  const toDate = to ? new Date(`${to}T00:00:00.000Z`) : undefined
  const dateRange =
    fromDate && toDate
      ? { gte: fromDate, lt: new Date(toDate.getTime() + 86_400_000) }
      : fromDate
        ? { gte: fromDate }
        : toDate
          ? { lt: new Date(toDate.getTime() + 86_400_000) }
          : undefined

  const [actions, actors] = await Promise.all([
    prisma.adminAction.findMany({
      where: {
        ...(actorId ? { actorId } : {}),
        ...(targetType ? { targetType } : {}),
        ...(targetId ? { targetId } : {}),
        ...(dateRange ? { createdAt: dateRange } : {}),
      },
      select: {
        id: true, action: true, targetType: true, targetId: true,
        reportId: true, reason: true, detail: true, createdAt: true,
        actor: { select: { name: true, email: true, role: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    }),
    prisma.user.findMany({
      where: { role: { in: ["ADMIN", "MODERATOR"] }, deletedAt: null },
      select: { id: true, name: true, email: true },
      orderBy: [{ name: "asc" }, { email: "asc" }],
    }),
  ])

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-.02em" }}>Audit log</h1>
        <p style={{ fontSize: 13, color: "#777", marginTop: 4, maxWidth: "72ch", lineHeight: 1.6 }}>
          Every moderation action, with who did it and why. Rows are written inside the same
          transaction as the change they describe, and there is no route that edits or deletes
          one — a log with an edit button records what somebody was willing to admit to.
        </p>
      </div>

      <form action="/admin/audit" style={{ ...cardStyle, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
        <label style={labelStyle}>
          Actor
          <select name="actorId" defaultValue={actorId ?? ""} style={fieldStyle}>
            <option value="">All staff</option>
            {actors.map((actor) => (
              <option key={actor.id} value={actor.id}>{actor.name} — {actor.email}</option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          Target type
          <select name="targetType" defaultValue={targetType ?? ""} style={fieldStyle}>
            <option value="">All targets</option>
            {TARGET_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </label>
        <label style={labelStyle}>
          Target ID
          <input name="targetId" defaultValue={targetId ?? ""} placeholder="Exact ID" style={fieldStyle} />
        </label>
        <label style={labelStyle}>
          From
          <input type="date" name="from" defaultValue={from ?? ""} style={fieldStyle} />
        </label>
        <label style={labelStyle}>
          To
          <input type="date" name="to" defaultValue={to ?? ""} style={fieldStyle} />
        </label>
        <button type="submit" style={buttonStyle}>Filter</button>
        <Link href="/admin/audit" style={{ ...buttonStyle, background: "#fff", color: "#555", textDecoration: "none" }}>Clear</Link>
      </form>

      {actions.length === 0 ? (
        <p style={{ fontSize: 14, color: "#888", padding: 32, textAlign: "center", background: "#fff", borderRadius: 14 }}>
          No moderation actions yet.
        </p>
      ) : (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid rgba(0,0,0,.08)", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
            <thead>
              <tr>
                <th style={th}>When</th>
                <th style={th}>Who</th>
                <th style={th}>What</th>
                <th style={th}>Target</th>
                <th style={th}>Why</th>
              </tr>
            </thead>
            <tbody>
              {actions.map((a) => {
                // Stored as a JSON string. A malformed value renders as nothing
                // rather than throwing — one bad row must not take down the log.
                let detail: Record<string, unknown> | null = null
                try {
                  detail = a.detail ? (JSON.parse(a.detail) as Record<string, unknown>) : null
                } catch {
                  detail = null
                }
                return (
                  <tr key={a.id} style={{ borderTop: "1px solid rgba(0,0,0,.06)" }}>
                    <td style={{ ...td, whiteSpace: "nowrap", color: "#666" }}>
                      {a.createdAt.toLocaleString()}
                    </td>
                    <td style={td}>
                      {a.actor.name}
                      <div style={{ fontSize: 11, color: "#aaa" }}>{a.actor.role}</div>
                    </td>
                    <td style={{ ...td, color: ACTION_COLOR[a.action] ?? "#333", fontWeight: 700 }}>
                      {a.action}
                    </td>
                    <td style={td}>
                      {a.targetType}
                      <div style={{ fontSize: 11, color: "#aaa", fontFamily: "monospace" }}>
                        {a.targetId}
                      </div>
                      {detail?.title != null && (
                        <div style={{ fontSize: 11, color: "#888" }}>“{String(detail.title)}”</div>
                      )}
                      {detail?.email != null && (
                        <div style={{ fontSize: 11, color: "#888" }}>{String(detail.email)}</div>
                      )}
                    </td>
                    <td style={{ ...td, maxWidth: 320, color: "#555", lineHeight: 1.5 }}>
                      {a.reason}
                      {detail?.indefinite === true && (
                        <div style={{ fontSize: 11, color: "#b91c1c", marginTop: 2 }}>indefinite</div>
                      )}
                      {typeof detail?.days === "number" && (
                        <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>{detail.days} days</div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const cardStyle: React.CSSProperties = {
  background: "#fff", border: "1px solid rgba(0,0,0,.08)", borderRadius: 14, padding: 14,
}
const labelStyle: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: 5, fontSize: 11, color: "#777", fontWeight: 700,
}
const fieldStyle: React.CSSProperties = {
  minHeight: 36, padding: "7px 9px", borderRadius: 7, border: "1px solid rgba(0,0,0,.16)", background: "#fff", color: "#111", fontSize: 12,
}
const buttonStyle: React.CSSProperties = {
  minHeight: 36, padding: "8px 12px", border: 0, borderRadius: 7, background: "#17201b", color: "#fff", fontWeight: 700, fontSize: 12,
}
