import Link from "next/link"
import prisma from "@/lib/prisma"
import UrlSyncedForm from "@/components/admin/primitives/UrlSyncedForm"

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

const th: React.CSSProperties = {
  padding: "10px 12px",
  textAlign: "left",
  color: "var(--adm-text-muted)",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
}
const td: React.CSSProperties = { padding: "12px", fontSize: 13, verticalAlign: "top" }

/** fg/bg pulled from the same tone tokens as everywhere else in the redesign.
 *  The four colors this mapped to before (red/amber/blue/green/gray) map
 *  onto warn/queue/info/good/neutral one for one. */
const ACTION_TONE: Record<string, { fg: string; bg: string }> = {
  REPORT_REVIEWING: { fg: "var(--adm-info)", bg: "var(--adm-info-bg)" },
  REPORT_DISMISSED: { fg: "var(--adm-neutral)", bg: "var(--adm-neutral-bg)" },
  REPORT_ACTIONED: { fg: "var(--adm-good)", bg: "var(--adm-good-bg)" },
  LISTING_HIDDEN: { fg: "var(--adm-warn)", bg: "var(--adm-warn-bg)" },
  LISTING_UNHIDDEN: { fg: "var(--adm-good)", bg: "var(--adm-good-bg)" },
  USER_SUSPENDED: { fg: "var(--adm-warn)", bg: "var(--adm-warn-bg)" },
  USER_UNSUSPENDED: { fg: "var(--adm-good)", bg: "var(--adm-good-bg)" },
  LISTING_VALUE_APPROVED: { fg: "var(--adm-good)", bg: "var(--adm-good-bg)" },
  LISTING_VALUE_REJECTED: { fg: "var(--adm-queue)", bg: "var(--adm-queue-bg)" },
  LISTING_APPEAL_UPHELD: { fg: "var(--adm-warn)", bg: "var(--adm-warn-bg)" },
  LISTING_APPEAL_OVERTURNED: { fg: "var(--adm-good)", bg: "var(--adm-good-bg)" },
  ACHIEVEMENT_CREATED: { fg: "var(--adm-good)", bg: "var(--adm-good-bg)" },
  ACHIEVEMENT_UPDATED: { fg: "var(--adm-info)", bg: "var(--adm-info-bg)" },
  ACHIEVEMENT_DEACTIVATED: { fg: "var(--adm-warn)", bg: "var(--adm-warn-bg)" },
  ACHIEVEMENT_REACTIVATED: { fg: "var(--adm-good)", bg: "var(--adm-good-bg)" },
}
const DEFAULT_TONE = { fg: "var(--adm-text-secondary)", bg: "var(--adm-neutral-bg)" }

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
      where: { role: "ADMIN", deletedAt: null },
      select: { id: true, name: true, email: true },
      orderBy: [{ name: "asc" }, { email: "asc" }],
    }),
  ])

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div>
        <h1 style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--adm-text)" }}>Audit log</h1>
        <p style={{ fontSize: 14, fontWeight: 500, color: "var(--adm-text-secondary)", marginTop: 6, maxWidth: "72ch", lineHeight: 1.6 }}>
          Every moderation action, with who did it and why. Rows are written inside the same
          transaction as the change they describe, and there is no route that edits or deletes
          one — a log with an edit button records what somebody was willing to admit to.
        </p>
      </div>

      <UrlSyncedForm
        action="/admin/audit"
        style={{
          background: "var(--adm-panel-flat)",
          borderRadius: "var(--adm-radius-panel)",
          padding: 18,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 12,
          alignItems: "end",
        }}
      >
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
        <div style={{ display: "flex", gap: 8 }}>
          <button type="submit" className="admin-btn-press" style={{ ...buttonStyle, flex: 1 }}>Filter</button>
          <Link
            href="/admin/audit"
            className="admin-btn-press"
            style={{
              ...buttonStyle,
              flex: 1,
              background: "transparent",
              color: "var(--adm-text)",
              border: "1px solid var(--adm-border-secondary)",
              textDecoration: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            Clear
          </Link>
        </div>
      </UrlSyncedForm>

      {actions.length === 0 ? (
        <p
          style={{
            fontSize: 14,
            color: "var(--adm-text-muted)",
            padding: 40,
            textAlign: "center",
            background: "var(--adm-panel-flat)",
            border: "1px dashed var(--adm-border-empty)",
            borderRadius: "var(--adm-radius-panel)",
          }}
        >
          No moderation actions yet.
        </p>
      ) : (
        <div style={{ background: "var(--adm-panel)", borderRadius: "var(--adm-radius-panel)", border: "1px solid var(--adm-border)", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
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
                const tone = ACTION_TONE[a.action] ?? DEFAULT_TONE
                return (
                  <tr key={a.id} className="admin-row-hover" style={{ borderTop: "1px solid var(--adm-divider)" }}>
                    <td style={{ ...td, whiteSpace: "nowrap", color: "var(--adm-text-secondary)" }}>
                      {a.createdAt.toLocaleString()}
                    </td>
                    <td style={td}>
                      <span style={{ color: "var(--adm-text)", fontWeight: 700 }}>{a.actor.name}</span>
                      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--adm-text-muted)", marginTop: 2 }}>
                        {a.actor.role}
                      </div>
                    </td>
                    <td style={td}>
                      <span
                        style={{
                          display: "inline-flex",
                          padding: "4px 10px",
                          borderRadius: 999,
                          background: tone.bg,
                          color: tone.fg,
                          fontSize: 11,
                          fontWeight: 800,
                          letterSpacing: "0.04em",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {a.action}
                      </span>
                    </td>
                    <td style={td}>
                      <span style={{ color: "var(--adm-text-secondary)", fontSize: 13, fontWeight: 600 }}>{a.targetType}</span>
                      <div style={{ fontSize: 11, color: "var(--adm-text-muted)", fontFamily: "var(--adm-font-mono)", marginTop: 3, overflowWrap: "anywhere" }}>
                        {a.targetId}
                      </div>
                      {detail?.title != null && (
                        <div style={{ fontSize: 12, color: "var(--adm-text-muted)", marginTop: 2 }}>“{String(detail.title)}”</div>
                      )}
                      {detail?.email != null && (
                        <div style={{ fontSize: 12, color: "var(--adm-text-muted)", marginTop: 2 }}>{String(detail.email)}</div>
                      )}
                    </td>
                    <td style={{ ...td, maxWidth: 320, color: "var(--adm-text-secondary)", lineHeight: 1.5, overflowWrap: "anywhere" }}>
                      {a.reason}
                      {detail?.indefinite === true && (
                        <div style={{ fontSize: 11, color: "var(--adm-warn)", marginTop: 3, fontWeight: 700 }}>indefinite</div>
                      )}
                      {typeof detail?.days === "number" && (
                        <div style={{ fontSize: 11, color: "var(--adm-text-muted)", marginTop: 3 }}>{detail.days} days</div>
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

const labelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--adm-text-muted)",
}
const fieldStyle: React.CSSProperties = {
  minHeight: 40,
  padding: "10px 12px",
  borderRadius: "var(--adm-radius-input)",
  border: "1px solid var(--adm-border-input)",
  background: "var(--adm-input)",
  color: "var(--adm-text)",
  fontSize: 13,
}
const buttonStyle: React.CSSProperties = {
  minHeight: 40,
  padding: "10px 16px",
  border: 0,
  borderRadius: 999,
  background: "var(--adm-accent)",
  color: "var(--adm-text-on-accent)",
  fontWeight: 700,
  fontSize: 13,
  cursor: "pointer",
}
