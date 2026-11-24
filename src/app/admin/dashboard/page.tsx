import Link from "next/link"
import { ArrowRight, Flag, IdCard, Building2, Gavel, Scale, type LucideIcon } from "lucide-react"
import prisma from "@/lib/prisma"
import { CATEGORY_LABEL, suspendedWhere, toWireCategory } from "@/lib/moderation"
import { actionPhrase, timeAgo } from "@/lib/admin-display"
import { OverviewCards, type OverviewMetric } from "./OverviewCards"
import { REPORT } from "@/lib/report-case"
import { getQueueCounts } from "@/lib/admin-queues"

export const dynamic = "force-dynamic"
export const revalidate = 0

/** How many items the merged list shows. Each queue contributes this many of
 *  its oldest, which is always enough to pick the oldest overall even when
 *  they all come from one queue. */
const INBOX_SIZE = 8
const PER_QUEUE = INBOX_SIZE

interface InboxItem {
  key: string
  kind: string
  title: string
  since: Date
  href: string
  icon: LucideIcon
}

const panel: React.CSSProperties = {
  background: "var(--adm-panel)",
  border: "1px solid var(--adm-border)",
  borderRadius: "var(--adm-radius-panel)",
  padding: 24,
  minWidth: 0,
}
const panelTitle: React.CSSProperties = { fontSize: 16, fontWeight: 700, color: "var(--adm-text)" }
const muted: React.CSSProperties = { color: "var(--adm-text-muted)", fontSize: 13 }

export default async function AdminDashboardPage() {
  const [
    queues, suspendedUsers, hiddenListings, inactiveHubs, activeAchievements,
    recentAudit, oldestReports, oldestIds, oldestOrgs, oldestValues, oldestAppeals,
  ] = await Promise.all([
    // Shared with the layout's rail badges: one set of counts per request.
    getQueueCounts(),
    prisma.user.count({ where: { deletedAt: null, ...suspendedWhere() } }),
    prisma.item.count({ where: { moderationHiddenAt: { not: null } } }),
    prisma.safeZoneHub.count({ where: { isActive: false } }),
    prisma.achievement.count({ where: { isActive: true } }),
    prisma.adminAction.findMany({
      take: 8,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, action: true, createdAt: true, actor: { select: { name: true } } },
    }),
    // The oldest waiting items of each queue -- the same WHERE each queue page
    // uses, oldest first, because the person at the front has waited longest.
    prisma.moderationCase.findMany({
      where: { ...REPORT, status: { in: ["OPEN", "REVIEWING"] } },
      select: { id: true, category: true, createdAt: true, filedBy: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
      take: PER_QUEUE,
    }),
    prisma.idVerification.findMany({
      where: { status: "PENDING" },
      select: { id: true, submittedAt: true, user: { select: { name: true } } },
      orderBy: { submittedAt: "asc" },
      take: PER_QUEUE,
    }),
    prisma.organization.findMany({
      where: { verificationStatus: "PENDING" },
      select: { id: true, name: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: PER_QUEUE,
    }),
    prisma.item.findMany({
      where: { status: "PENDING_REVIEW" },
      select: { id: true, title: true, updatedAt: true },
      orderBy: { updatedAt: "asc" },
      take: PER_QUEUE,
    }),
    prisma.moderationCase.findMany({
      where: { type: "LISTING_APPEAL", status: "OPEN" },
      select: { id: true, createdAt: true, item: { select: { title: true } } },
      orderBy: { createdAt: "asc" },
      take: PER_QUEUE,
    }),
  ])

  const { openReports, pendingIds, pendingOrgs, valuesInReview, openAppeals } = queues
  const pendingDocuments = pendingIds + pendingOrgs
  const waitingTotal = openReports + pendingDocuments + valuesInReview + openAppeals

  const metrics: OverviewMetric[] = [
    { label: "User reports", value: openReports, href: "/admin", tone: "queue" },
    { label: "Documents to verify", value: pendingDocuments, href: "/admin/id-verification?status=PENDING", tone: "queue" },
    { label: "Values in review", value: valuesInReview, href: "/admin/review-queue", tone: "queue" },
    { label: "Open appeals", value: openAppeals, href: "/admin/appeals", tone: "queue" },
  ]

  const inbox: InboxItem[] = [
    ...oldestReports.map((row) => ({
      key: "report" + row.id,
      kind: "User report",
      title: (row.category ? CATEGORY_LABEL[toWireCategory(row.category)] : "Report") + (row.filedBy?.name ? ` · filed by ${row.filedBy.name}` : ""),
      since: row.createdAt,
      href: `/admin/reports/${row.id}`,
      icon: Flag,
    })),
    ...oldestIds.map((row) => ({
      key: "id" + row.id,
      kind: "ID verification",
      title: row.user.name ?? "Unnamed user",
      since: row.submittedAt,
      href: `/admin/id-verification/${row.id}`,
      icon: IdCard,
    })),
    ...oldestOrgs.map((row) => ({
      key: "org" + row.id,
      kind: "Business documents",
      title: row.name,
      since: row.createdAt,
      href: `/admin/organizations/${row.id}`,
      icon: Building2,
    })),
    ...oldestValues.map((row) => ({
      key: "value" + row.id,
      kind: "Listing value",
      title: row.title,
      since: row.updatedAt,
      href: "/admin/review-queue",
      icon: Scale,
    })),
    ...oldestAppeals.map((row) => ({
      key: "appeal" + row.id,
      kind: "Appeal",
      title: row.item?.title ?? "Listing appeal",
      since: row.createdAt,
      href: "/admin/appeals",
      icon: Gavel,
    })),
  ]
    .sort((a, b) => a.since.getTime() - b.since.getTime())
    .slice(0, INBOX_SIZE)

  // Not queues: nobody is waiting on these, they are the current state of the
  // platform. Kept small and below the work.
  const state = [
    { label: "Suspended users", value: suspendedUsers, href: "/admin/users?status=suspended" },
    { label: "Hidden listings", value: hiddenListings, href: "/admin/listings?status=hidden" },
    { label: "Inactive hubs", value: inactiveHubs, href: "/admin/hubs?status=inactive" },
    { label: "Active achievements", value: activeAchievements, href: "/admin/achievements" },
  ]

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <div>
        <h1 style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--adm-text)" }}>Overview</h1>
        <p style={{ fontSize: 14, fontWeight: 500, color: "var(--adm-text-secondary)", marginTop: 6, lineHeight: 1.6 }}>
          {waitingTotal === 0
            ? "Nothing is waiting on a decision."
            : `${waitingTotal} ${waitingTotal === 1 ? "item is" : "items are"} waiting on a decision.`}
        </p>
      </div>

      <OverviewCards metrics={metrics} />

      <div className="adm-dashboard-grid">
        <section style={panel}>
          <h2 style={panelTitle}>Waiting on you</h2>
          <p style={{ ...muted, marginTop: 4 }}>Across every queue, longest wait first.</p>
          {inbox.length === 0 ? (
            <p style={{ ...muted, marginTop: 20 }}>All queues are clear.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
              {inbox.map((item) => (
                <Link
                  key={item.key}
                  href={item.href}
                  className="adm-row-hover"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    background: "var(--adm-panel-flat)",
                    border: "1px solid var(--adm-border)",
                    borderRadius: "var(--adm-radius-tile)",
                    padding: "12px 16px",
                    textDecoration: "none",
                    color: "var(--adm-text)",
                  }}
                >
                  <span
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 999,
                      background: "var(--adm-queue-bg)",
                      color: "var(--adm-queue)",
                      display: "grid",
                      placeItems: "center",
                      flexShrink: 0,
                    }}
                    aria-hidden="true"
                  >
                    <item.icon size={17} strokeWidth={2} />
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 14, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {item.title}
                    </span>
                    <span style={{ display: "block", fontSize: 12, color: "var(--adm-text-muted)", marginTop: 2 }}>{item.kind}</span>
                  </span>
                  <time dateTime={item.since.toISOString()} style={{ fontSize: 12, color: "var(--adm-text-secondary)", whiteSpace: "nowrap" }}>
                    {timeAgo(item.since)}
                  </time>
                  <ArrowRight size={15} aria-hidden="true" style={{ color: "var(--adm-accent-text)", flexShrink: 0 }} />
                </Link>
              ))}
            </div>
          )}
          {waitingTotal > inbox.length ? (
            <p style={{ ...muted, fontSize: 12, marginTop: 14 }}>
              Showing the {inbox.length} oldest of {waitingTotal}. Open a queue above for the rest.
            </p>
          ) : null}
        </section>

        <section style={panel}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
            <h2 style={panelTitle}>Recent activity</h2>
            <Link href="/admin/audit" style={{ color: "var(--adm-accent-text)", fontSize: 13, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>
              Audit log →
            </Link>
          </div>
          {recentAudit.length === 0 ? (
            <p style={{ ...muted, marginTop: 16 }}>No admin actions yet.</p>
          ) : (
            <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }}>
              {recentAudit.map((action, i) => (
                <li key={action.id} style={{ padding: "12px 0", borderTop: i === 0 ? "none" : "1px solid var(--adm-divider)" }}>
                  <div style={{ fontSize: 13, color: "var(--adm-text-secondary)", lineHeight: 1.5 }}>
                    <strong style={{ color: "var(--adm-text)", fontWeight: 700 }}>{action.actor.name ?? "An admin"}</strong>{" "}
                    {actionPhrase(action.action)}
                  </div>
                  <time dateTime={action.createdAt.toISOString()} style={{ display: "block", fontSize: 12, color: "var(--adm-text-muted)", marginTop: 2 }}>
                    {timeAgo(action.createdAt)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section style={{ ...panel, padding: "18px 24px" }}>
        <h2 style={{ ...panelTitle, fontSize: 13, fontWeight: 600, color: "var(--adm-text-muted)" }}>Platform state</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 16, marginTop: 12 }}>
          {state.map((entry) => (
            <Link key={entry.label} href={entry.href} style={{ textDecoration: "none", color: "var(--adm-text)" }}>
              <span style={{ display: "block", fontSize: 24, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{entry.value.toLocaleString()}</span>
              <span style={{ display: "block", fontSize: 13, color: "var(--adm-text-secondary)", marginTop: 2 }}>{entry.label}</span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  )
}
