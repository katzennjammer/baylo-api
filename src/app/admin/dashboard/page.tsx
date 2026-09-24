import Link from "next/link"
import prisma from "@/lib/prisma"
import { OverviewCards, type OverviewMetric } from "./OverviewCards"

export const dynamic = "force-dynamic"
export const revalidate = 0

const cardStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid rgba(0,0,0,.08)",
  borderRadius: 14,
  padding: 18,
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 800 }}>Dashboard overview</h1>
        <p style={{ fontSize: 13, color: "#777", marginTop: 4 }}>
          A quick view of the moderation and safety queues that need attention.
        </p>
      </div>
      <OverviewCards metrics={metrics} />
      <section style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
          <h2 style={{ fontSize: 17, fontWeight: 800 }}>Recent audit actions</h2>
          <Link href="/admin/audit" style={{ color: "#21643d", fontSize: 13, fontWeight: 700 }}>View audit log →</Link>
        </div>
        {recentAudit.length === 0 ? (
          <p style={{ color: "#888", fontSize: 13, marginTop: 16 }}>No moderation actions yet.</p>
        ) : (
          <div style={{ marginTop: 12 }}>
            {recentAudit.map((action) => (
              <div key={action.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "11px 0", borderTop: "1px solid rgba(0,0,0,.06)", fontSize: 13 }}>
                <div>
                  <strong>{action.action}</strong>
                  <span style={{ color: "#777" }}> · {action.targetType} {action.targetId}</span>
                  <div style={{ color: "#888", fontSize: 11, marginTop: 3 }}>by {action.actor.name}</div>
                </div>
                <time dateTime={action.createdAt.toISOString()} style={{ color: "#888", whiteSpace: "nowrap", fontSize: 12 }}>
                  {action.createdAt.toLocaleString()}
                </time>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
