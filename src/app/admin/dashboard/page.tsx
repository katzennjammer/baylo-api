import Link from "next/link"
import { IdCard, Gavel, Scale, type LucideIcon } from "lucide-react"
import prisma from "@/lib/prisma"
import { CountUp } from "@/components/admin/CountUp"
import { OverviewCards, type OverviewMetric } from "./OverviewCards"

export const dynamic = "force-dynamic"
export const revalidate = 0

/** Tone color for an audit action's own label -- the same closed set the
 *  /admin/audit page colors by, kept in sync by hand since both read the
 *  same AdminAction.action strings. */
const ACTION_TONE: Record<string, string> = {
  REPORT_REVIEWING: "var(--adm-info)",
  REPORT_DISMISSED: "var(--adm-neutral)",
  REPORT_ACTIONED: "var(--adm-good)",
  LISTING_HIDDEN: "var(--adm-warn)",
  LISTING_UNHIDDEN: "var(--adm-good)",
  USER_SUSPENDED: "var(--adm-warn)",
  USER_UNSUSPENDED: "var(--adm-good)",
  LISTING_VALUE_APPROVED: "var(--adm-good)",
  LISTING_VALUE_REJECTED: "var(--adm-queue)",
  LISTING_APPEAL_UPHELD: "var(--adm-warn)",
  LISTING_APPEAL_OVERTURNED: "var(--adm-good)",
  ACHIEVEMENT_CREATED: "var(--adm-good)",
  ACHIEVEMENT_UPDATED: "var(--adm-info)",
  ACHIEVEMENT_DEACTIVATED: "var(--adm-warn)",
  ACHIEVEMENT_REACTIVATED: "var(--adm-good)",
  HUB_CREATED: "var(--adm-good)",
  ID_VERIFICATION_APPROVED: "var(--adm-good)",
  ID_VERIFICATION_REJECTED: "var(--adm-warn)",
}

function initials(name: string | null) {
  if (!name) return "—"
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "—"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

export default async function AdminDashboardPage() {
  const [reportCounts, pendingIds, suspendedUsers, hiddenListings, inactiveHubs, defaults, openAppeals, activeAchievements, recentAudit] =
    await Promise.all([
      prisma.report.groupBy({ by: ["status"], _count: { id: true } }),
      prisma.idVerification.count({ where: { status: "PENDING" } }),
      prisma.user.count({
        where: {
          deletedAt: null,
          suspendedAt: { not: null },
          OR: [{ suspendedUntil: null }, { suspendedUntil: { gt: new Date() } }],
        },
      }),
      prisma.item.count({ where: { moderationHiddenAt: { not: null } } }),
      prisma.safeZoneHub.count({ where: { isActive: false } }),
      prisma.item.count({ where: { status: "PENDING_REVIEW" } }),
      prisma.listingAppeal.count({ where: { status: "OPEN" } }),
      prisma.achievement.count({ where: { isActive: true }}),
      prisma.adminAction.findMany({
        take: 8,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          id: true, action: true, targetType: true, targetId: true, createdAt: true,
          actor: { select: { name: true } },
        },
      }),
    ])

  const reports = Object.fromEntries(reportCounts.map((row) => [row.status, row._count.id]))
  const metrics: OverviewMetric[] = [
    { label: "Open reports", value: (reports.OPEN ?? 0) + (reports.REVIEWING ?? 0), href: "/admin", tone: "queue" },
    { label: "Pending ID checks", value: pendingIds, href: "/admin/id-verification?status=PENDING", tone: "queue" },
    { label: "Suspended users", value: suspendedUsers, href: "/admin/users?status=suspended", tone: "warn" },
    { label: "Hidden listings", value: hiddenListings, href: "/admin/listings?status=hidden", tone: "warn" },
    { label: "Inactive hubs", value: inactiveHubs, href: "/admin/hubs?status=inactive", tone: "warn" },
    { label: "Values in review", value: defaults, href: "/admin/review-queue", tone: "queue" },
    { label: "Open appeals", value: openAppeals, href: "/admin/appeals", tone: "queue" },
    { label: "Achievements", value: activeAchievements, href: "/admin/achievements", tone: "good" },
  ]

  // "N items waiting on a decision" -- computed from counts already fetched
  // above for the metric tiles, per DESIGN_SPEC.md §4.1/§7#6. Not a new
  // query: the same three numbers the "Pending ID checks", "Open appeals"
  // and "Values in review" tiles already show, just summed.
  const waitingTotal = pendingIds + openAppeals + defaults

  const attentionGroups: { label: string; count: number; href: string; icon: LucideIcon }[] = [
    { label: "ID checks", count: pendingIds, href: "/admin/id-verification?status=PENDING", icon: IdCard },
    { label: "Appeals", count: openAppeals, href: "/admin/appeals", icon: Gavel },
    { label: "Values in review", count: defaults, href: "/admin/review-queue", icon: Scale },
  ]

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      <div>
        <h1 style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--adm-text)" }}>Dashboard overview</h1>
        <p style={{ fontSize: 14, fontWeight: 500, color: "var(--adm-text-secondary)", marginTop: 6, maxWidth: "72ch", lineHeight: 1.6 }}>
          A quick view of the moderation and safety queues that need attention.
        </p>
      </div>

      <div className="adm-dashboard-grid">
        <div style={{ display: "flex", flexDirection: "column", gap: 32, minWidth: 0 }}>
          <OverviewCards metrics={metrics} />

          <section
            style={{
              background: "var(--adm-panel)",
              border: "1px solid var(--adm-border)",
              borderRadius: "var(--adm-radius-panel)",
              padding: 24,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--adm-text)" }}>Recent audit actions</h2>
              <Link href="/admin/audit" style={{ color: "var(--adm-accent-text)", fontSize: 13, fontWeight: 600, textDecoration: "none" }}>
                View audit log →
              </Link>
            </div>
            {recentAudit.length === 0 ? (
              <p style={{ color: "var(--adm-text-muted)", fontSize: 13, marginTop: 16 }}>No moderation actions yet.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
                {recentAudit.map((action) => (
                  <div
                    key={action.id}
                    className="adm-row-hover"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 14,
                      flexWrap: "wrap",
                      background: "var(--adm-panel-flat)",
                      border: "1px solid var(--adm-border)",
                      borderRadius: "var(--adm-radius-tile)",
                      padding: "14px 18px",
                    }}
                  >
                    <span
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 999,
                        background: "var(--adm-accent-tint)",
                        color: "var(--adm-accent-soft)",
                        display: "grid",
                        placeItems: "center",
                        fontSize: 12,
                        fontWeight: 800,
                        flexShrink: 0,
                      }}
                      aria-hidden="true"
                    >
                      {initials(action.actor.name)}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.02em", color: ACTION_TONE[action.action] ?? "var(--adm-text)" }}>
                        {action.action}
                      </span>
                      <div style={{ fontSize: 13, color: "var(--adm-text-muted)", marginTop: 2, overflowWrap: "anywhere" }}>
                        {action.targetType} · {action.targetId} · by {action.actor.name ?? "—"}
                      </div>
                    </div>
                    <time dateTime={action.createdAt.toISOString()} style={{ color: "var(--adm-text-muted)", whiteSpace: "nowrap", fontSize: 12 }}>
                      {action.createdAt.toLocaleString()}
                    </time>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <aside style={{ display: "flex", flexDirection: "column", gap: 28, minWidth: 0 }}>
          <div>
            <h2 style={{ fontSize: 22, fontWeight: 700, color: "var(--adm-text)", marginBottom: 12 }}>Needs attention</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {attentionGroups.map((group) => (
                <Link
                  key={group.label}
                  href={group.href}
                  className="adm-lift"
                  style={{
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    background: "var(--adm-panel-flat)",
                    border: "1px solid var(--adm-border)",
                    borderRadius: "var(--adm-radius-tile)",
                    padding: "14px 16px",
                    textDecoration: "none",
                    color: "var(--adm-text)",
                  }}
                >
                  <span
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 999,
                      background: group.count > 0 ? "var(--adm-queue-bg)" : "var(--adm-accent-tint)",
                      color: group.count > 0 ? "var(--adm-queue)" : "var(--adm-accent-soft)",
                      display: "grid",
                      placeItems: "center",
                      flexShrink: 0,
                    }}
                    aria-hidden="true"
                  >
                    <group.icon size={18} strokeWidth={2} />
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 15, fontWeight: 700 }}>
                      {group.count} {group.count === 1 ? "item" : "items"}
                    </span>
                    <span style={{ display: "block", fontSize: 12, color: "var(--adm-text-muted)", marginTop: 2 }}>{group.label}</span>
                  </span>
                  {group.count > 0 ? (
                    <span
                      style={{
                        padding: "3px 9px",
                        borderRadius: 999,
                        background: "var(--adm-accent-2)",
                        color: "var(--adm-text-on-soft)",
                        fontSize: 11,
                        fontWeight: 800,
                      }}
                    >
                      {group.count}
                    </span>
                  ) : null}
                </Link>
              ))}
            </div>
          </div>

          <div
            style={{
              background: "var(--adm-highlight)",
              borderRadius: "var(--adm-radius-panel)",
              padding: "32px 24px",
              color: "var(--adm-text-on-soft)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 6,
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 64, fontWeight: 800, letterSpacing: "-0.04em", lineHeight: 1 }}>
              <CountUp value={waitingTotal} />
            </div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{waitingTotal === 1 ? "item" : "items"} waiting on a decision</div>
            <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.8 }}>
              {pendingIds} ID check{pendingIds === 1 ? "" : "s"} · {openAppeals} appeal{openAppeals === 1 ? "" : "s"} · {defaults} value{defaults === 1 ? "" : "s"} in review
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
