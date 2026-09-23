import prisma from "@/lib/prisma"
import { CATEGORY_LABEL, toWireCategory } from "@/lib/moderation"
import { SAFE_ZONE_TYPE_LABELS, type SafeZoneTypeValue } from "@/lib/safe-zones"

/**
 * The numbers behind /admin/reports.
 *
 * ── WHY A LIBRARY AND NOT THE PAGE ──────────────────────────
 *
 * The page needs these figures twice: once to render, once inside the printable
 * report. Both readings must be the same reading, or the PDF somebody is handed
 * disagrees with the screen it was exported from.
 *
 * ── COUNTED, NOT SUMMED IN THE BROWSER ──────────────────────
 *
 * Every headline figure and every category breakdown is an aggregate the
 * database computes. Counting fetched rows in JS would silently cap at whatever
 * `take` was set to, and produce a bar chart whose tallest bar means "the first
 * 100 rows".
 *
 * The one exception is the three MONTHLY series (reports, new accounts, Leaves).
 * Those are bucketed here from rows that carry only the one or two columns they
 * need and have no `take`, so they cannot be truncated. They are bucketed in JS
 * because the month boundary has to fall in REPORT_TIME_ZONE, which a plain
 * database group-by would not do for us without dialect-specific SQL.
 *
 * ── THE WINDOW IS A PARAMETER ────────────────
 *
 * The window is chosen by the caller, because a 7-day view and a 90-day view are
 * different questions and both are legitimate. Two things always ignore it and
 * say so on screen: "right now" counts (open queues) and all-time totals. A
 * backlog is not a rate, and a total that changed when you picked a window would
 * be a total of nothing in particular.
 *
 * ── ONE TIME ZONE FOR THE WHOLE REPORT ──────────────────────
 *
 * Month buckets, the period labels and the "generated" stamp all use
 * REPORT_TIME_ZONE. Without that, something that happened at 7am on the 1st in
 * Cebu lands in the previous month's bar, and a printed date depends on which
 * server rendered it. The zone is named on the page so nobody has to guess.
 */

export const REPORT_TIME_ZONE = "Asia/Manila"

export const WINDOW_OPTIONS = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
  { days: 365, label: "Last 12 months" },
] as const

export const DEFAULT_WINDOW_DAYS = 30

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/**
 * Resolves a raw query value to a supported window, defaulting when unknown.
 * Next can hand a repeated query parameter over as an array, so take the first.
 */
export function normaliseWindowDays(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw
  const parsed = Number(value)
  const match = WINDOW_OPTIONS.find((option) => option.days === parsed)
  return match ? match.days : DEFAULT_WINDOW_DAYS
}

export interface SeriesPoint {
  /** Stable identity for React keys. Falls back to the label when absent. */
  key?: string
  label: string
  value: number
  /** True for a month only partly inside the window; charts mark it. */
  partial?: boolean
}

export interface RankRow {
  key: string
  cells: (string | number)[]
}

export interface ActorRow {
  id: string
  name: string
  role: string
  count: number
}

export interface ReportTotals {
  users: number
  admins: number
  suspended: number
  deleted: number
  newUsersInWindow: number
  listings: number
  listingsAvailable: number
  listingsHidden: number
  listingsInWindow: number
  tradesCompleted: number
  tradesInWindow: number
  reportsInWindow: number
  reportsResolvedInWindow: number
  idPending: number
  idDecidedInWindow: number
  idApprovedInWindow: number
  appealsOpen: number
  appealsDecidedInWindow: number
  appealsOverturnedInWindow: number
  hubsActive: number
  hubsInactive: number
  tasksCompletedInWindow: number
  actionsInWindow: number
}

export interface ReportSummary {
  windowDays: number
  windowLabel: string
  generatedAt: Date
  from: Date
  to: Date
  totals: ReportTotals
  leavesByMonth: SeriesPoint[]
  reportsByMonth: SeriesPoint[]
  usersByMonth: SeriesPoint[]
  reportsByCategory: SeriesPoint[]
  reportsByStatus: SeriesPoint[]
  listingsByCategory: SeriesPoint[]
  listingsByCondition: SeriesPoint[]
  tasksCompleted: SeriesPoint[]
  actionsByKind: SeriesPoint[]
  hubPlans: SeriesPoint[]
  hubClaims: SeriesPoint[]
  hubByType: SeriesPoint[]
  /** Share of reports FILED in the window that are resolved so far, 0-100. */
  resolutionRate: number | null
  /** Median hours to resolve, over reports filed in the window and resolved so far. */
  medianResolutionHours: number | null
  averageRating: number | null
  reviewsInWindow: number
  actionsByActor: ActorRow[]
  topHubs: RankRow[]
  topCities: RankRow[]
}

// ── Formatting, shared with the page so screen and print agree ───────────

/** "Sep 21, 2026", in the report's time zone. */
export function formatReportDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: REPORT_TIME_ZONE,
  })
}

/** "Sep 21, 2026, 3:04 PM GMT+8", in the report's time zone, zone named. */
export function formatReportDateTime(d: Date): string {
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: REPORT_TIME_ZONE,
    timeZoneName: "short",
  })
}

// ── Small helpers ───────────────────────────────────────────

/**
 * Turns a SCREAMING_SNAKE enum value into something a person reads.
 * split/join rather than a regex, so no escape sequence in a string literal can
 * be misread.
 */
function humanise(value: string): string {
  const lower = value.split("_").join(" ").toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

const zonedParts = new Intl.DateTimeFormat("en-US", {
  timeZone: REPORT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

/** The calendar year / month / day a moment falls on in REPORT_TIME_ZONE. */
function zonedYmd(d: Date): { year: number; month: number; day: number } {
  let year = 0
  let month = 0
  let day = 0
  for (const part of zonedParts.formatToParts(d)) {
    if (part.type === "year") year = Number(part.value)
    else if (part.type === "month") month = Number(part.value)
    else if (part.type === "day") day = Number(part.value)
  }
  return { year: year, month: month, day: day }
}

function monthKey(year: number, month: number): string {
  return year + "-" + String(month).padStart(2, "0")
}

/** The month key a moment falls in. Must agree with monthBuckets(). */
function bucketKey(d: Date): string {
  const ymd = zonedYmd(d)
  return monthKey(ymd.year, ymd.month)
}

interface MonthBucket {
  key: string
  label: string
  partial: boolean
}

/**
 * Month buckets across the window, oldest first, labelled for a human.
 *
 * Walks integer (year, month) pairs rather than nudging a Date, so a month can
 * never be skipped or doubled by day-of-month overflow or a zone offset.
 * The first bucket is partial when the window starts after the 1st; the last is
 * always partial, because the current month is still in progress.
 */
function monthBuckets(from: Date, to: Date): MonthBucket[] {
  const start = zonedYmd(from)
  const end = zonedYmd(to)
  const buckets: MonthBucket[] = []

  let year = start.year
  let month = start.month
  while (year < end.year || (year === end.year && month <= end.month)) {
    const label = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
      month: "short",
      year: "2-digit",
      timeZone: "UTC",
    })
    const isFirst = buckets.length === 0
    const isLast = year === end.year && month === end.month
    buckets.push({
      key: monthKey(year, month),
      label: label,
      partial: (isFirst && start.day > 1) || isLast,
    })
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return buckets
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2
  return sorted[mid]
}

/** null-safe map read, so no non-null assertion is needed at the call site. */
function get(map: Map<string, number>, key: string): number {
  const found = map.get(key)
  return found === undefined ? 0 : found
}

/** Counts rows per month, oldest first, across the window. */
function monthlySeries(dates: Date[], buckets: MonthBucket[]): SeriesPoint[] {
  const counts = new Map<string, number>()
  for (const date of dates) {
    const key = bucketKey(date)
    counts.set(key, get(counts, key) + 1)
  }
  return buckets.map((b) => ({ key: b.key, label: b.label, value: get(counts, b.key), partial: b.partial }))
}

/**
 * Sums points that share a label, then sorts largest first. Two database values
 * can map to one human label (several report categories share a wire category),
 * and two bars with one label would be both confusing and a duplicate React key.
 */
function mergeByLabel(points: SeriesPoint[]): SeriesPoint[] {
  const merged = new Map<string, number>()
  for (const point of points) {
    merged.set(point.label, get(merged, point.label) + point.value)
  }
  return [...merged.entries()]
    .map(([label, value]) => ({ key: label, label: label, value: value }))
    .sort((a, b) => b.value - a.value)
}

interface HubInfo {
  name: string
  city: string
  type: string
  active: boolean
}

function hubLabel(hub: HubInfo): string {
  // "Mall — Cebu City" reads better than the name alone when two hubs share
  // a name, which they do ("SM City" exists in more than one city).
  return hub.name + " — " + hub.city
}

function hubTypeLabel(type: string): string {
  return SAFE_ZONE_TYPE_LABELS[type as SafeZoneTypeValue] ?? humanise(type)
}

const REMOVED_HUB_KEY = "removed-hubs"
const REMOVED_HUB_LABEL = "Removed hubs"

export async function loadReportSummary(requestedDays: number): Promise<ReportSummary> {
  const windowDays = normaliseWindowDays(String(requestedDays))
  const to = new Date()
  const from = new Date(to.getTime() - windowDays * DAY_MS)
  const range = { gte: from, lte: to }

  // ── Named where-fragments ───────────────
  // Deliberately flat. A deeply nested object literal in a long expression is
  // where this file's predecessor went wrong, and named fragments are also what
  // makes each query readable on its own line.
  const onlyLive = { deletedAt: null }
  const onlyAdmins = { role: "ADMIN" as const, deletedAt: null }
  const onlyDeleted = { deletedAt: { not: null } }
  const joinedInWindow = { createdAt: range }
  const resolvedInWindow = { resolvedAt: range }
  const hidden = { moderationHiddenAt: { not: null } }
  // NOTE: this filters on createdAt, so it counts trades STARTED in the window
  // that are completed now. If TradeRequest has a completion timestamp, swap it
  // in here and drop "started in period" from the hint on the page.
  const completedInWindow = { status: "COMPLETED" as const, createdAt: range }
  const pendingIds = { status: "PENDING" as const }
  const decidedIds: ("APPROVED" | "REJECTED")[] = ["APPROVED", "REJECTED"]
  const decidedIdsInWindow = { status: { in: decidedIds }, reviewedAt: range }
  const approvedIdsInWindow = { status: "APPROVED" as const, reviewedAt: range }
  const openAppeals = { status: "OPEN" as const }
  const decidedAppealsInWindow = { decidedAt: range }
  const overturnedAppealsInWindow = { status: "OVERTURNED" as const, decidedAt: range }
  const available = { status: "AVAILABLE" as const }
  const activeHubs = { isActive: true }
  const inactiveHubs = { isActive: false }
  const leavesInWindow = { eventAt: range }
  const plannedMeetups = { meetupHubId: { not: null } }
  const claimedMeetups = { safeZoneHubId: { not: null } }

  // "Suspended right now". suspendedUntil === null means INDEFINITE, not
  // "not suspended" -- see suspensionState() in @/lib/moderation. Both columns
  // must therefore be tested together, or a lapsed suspension still counts.
  const stillSuspended = { suspendedUntil: null }
  const runningUntil = { suspendedUntil: { gt: to } }
  const suspension = { deletedAt: null, suspendedAt: { not: null }, OR: [stillSuspended, runningUntil] }

  // ── Everything independent, in one round trip ───────────────────────
  // None of these reads depends on another, so they run together instead of as
  // ~35 sequential awaits. Only the staff-name lookup below has to wait, because
  // it needs the actor ids from `byActorRaw`.
  const [
    // counts
    users,
    admins,
    suspended,
    deleted,
    newUsersInWindow,
    listings,
    listingsAvailable,
    listingsHidden,
    listingsInWindow,
    tradesCompleted,
    tradesInWindow,
    reportsFiled,
    reportsResolved,
    idPending,
    idDecidedInWindow,
    idApprovedInWindow,
    appealsOpen,
    appealsDecidedInWindow,
    appealsOverturnedInWindow,
    hubsActive,
    hubsInactive,
    tasksCompletedInWindow,
    actionsInWindow,
    // grouped series
    byCategory,
    byStatus,
    byTask,
    byAction,
    listingsByCategoryRaw,
    listingsByConditionRaw,
    // hub meetup activity
    allHubs,
    planRows,
    claimRows,
    // review quality
    reviewAggregate,
    // raw rows for the monthly series and the resolution cohort
    leaves,
    reportRows,
    userRows,
    // who did the work
    byActorRaw,
  ] = await Promise.all([
    prisma.user.count({ where: onlyLive }),
    prisma.user.count({ where: onlyAdmins }),
    prisma.user.count({ where: suspension }),
    prisma.user.count({ where: onlyDeleted }),
    prisma.user.count({ where: joinedInWindow }),
    prisma.item.count(),
    prisma.item.count({ where: available }),
    prisma.item.count({ where: hidden }),
    prisma.item.count({ where: joinedInWindow }),
    prisma.tradeRequest.count({ where: { status: "COMPLETED" } }),
    prisma.tradeRequest.count({ where: completedInWindow }),
    prisma.report.count({ where: joinedInWindow }),
    prisma.report.count({ where: resolvedInWindow }),
    prisma.idVerification.count({ where: pendingIds }),
    prisma.idVerification.count({ where: decidedIdsInWindow }),
    prisma.idVerification.count({ where: approvedIdsInWindow }),
    prisma.listingAppeal.count({ where: openAppeals }),
    prisma.listingAppeal.count({ where: decidedAppealsInWindow }),
    prisma.listingAppeal.count({ where: overturnedAppealsInWindow }),
    prisma.safeZoneHub.count({ where: activeHubs }),
    prisma.safeZoneHub.count({ where: inactiveHubs }),
    prisma.taskCompletion.count({ where: joinedInWindow }),
    prisma.adminAction.count({ where: joinedInWindow }),

    prisma.report.groupBy({ by: ["category"], where: joinedInWindow, _count: { id: true }, orderBy: { _count: { id: "desc" } } }),
    prisma.report.groupBy({ by: ["status"], _count: { id: true } }),
    prisma.taskCompletion.groupBy({ by: ["task"], where: joinedInWindow, _count: { id: true }, orderBy: { _count: { id: "desc" } } }),
    prisma.adminAction.groupBy({ by: ["action"], where: joinedInWindow, _count: { id: true }, orderBy: { _count: { id: "desc" } } }),
    prisma.item.groupBy({ by: ["category"], _count: { id: true }, orderBy: { _count: { id: "desc" } } }),
    prisma.item.groupBy({ by: ["condition"], _count: { id: true }, orderBy: { _count: { id: "desc" } } }),

    // Two different questions, and the schema keeps two different columns for
    // them: `meetupHubId` is where a trade has ARRANGED to meet, `safeZoneHubId`
    // is where the parties SAID they met. Counting only one would answer half the
    // question, so both are counted and the page labels them separately.
    prisma.safeZoneHub.findMany({ select: { id: true, name: true, city: true, type: true, isActive: true } }),
    prisma.tradeRequest.groupBy({ by: ["meetupHubId"], where: plannedMeetups, _count: { id: true }, orderBy: { _count: { id: "desc" } } }),
    prisma.tradeRequest.groupBy({ by: ["safeZoneHubId"], where: claimedMeetups, _count: { id: true }, orderBy: { _count: { id: "desc" } } }),

    prisma.review.aggregate({ where: joinedInWindow, _avg: { rating: true }, _count: { id: true } }),

    prisma.leafTransaction.findMany({ where: leavesInWindow, select: { amount: true, eventAt: true } }),
    prisma.report.findMany({ where: joinedInWindow, select: { createdAt: true, resolvedAt: true } }),
    prisma.user.findMany({ where: joinedInWindow, select: { createdAt: true } }),

    prisma.adminAction.groupBy({ by: ["actorId"], where: joinedInWindow, _count: { id: true }, orderBy: { _count: { id: "desc" } }, take: 10 }),
  ])

  // ── Staff names: the one read that depends on another ────────────────
  const actorIds = byActorRaw.map((row) => row.actorId)
  const actorPeople =
    actorIds.length > 0
      ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, role: true } })
      : []
  const actorById = new Map(actorPeople.map((person) => [person.id, person]))

  // ── Hub meetup activity ─────────────────
  const hubById = new Map<string, HubInfo>()
  for (const hub of allHubs) {
    hubById.set(hub.id, { name: hub.name, city: hub.city, type: hub.type, active: hub.isActive })
  }

  interface PlanEntry {
    key: string
    label: string
    typeLabel: string
    state: string
    count: number
  }

  const planEntries: PlanEntry[] = []
  const cityPlans = new Map<string, number>()
  const typeTotals = new Map<string, number>()
  let removedPlans = 0

  for (const row of planRows) {
    const id = row.meetupHubId
    if (!id) continue
    const count = row._count.id
    const hub = hubById.get(id)

    if (!hub) {
      // Every deleted hub would otherwise be its own "Removed hub — —" row with
      // the same label. They are one fact, so they are one bar.
      removedPlans += count
      typeTotals.set("UNKNOWN", get(typeTotals, "UNKNOWN") + count)
      continue
    }

    planEntries.push({
      key: id,
      label: hubLabel(hub),
      typeLabel: hubTypeLabel(hub.type),
      state: hub.active ? "Active" : "Inactive",
      count: count,
    })
    cityPlans.set(hub.city, get(cityPlans, hub.city) + count)
    typeTotals.set(hub.type, get(typeTotals, hub.type) + count)
  }

  if (removedPlans > 0) {
    planEntries.push({ key: REMOVED_HUB_KEY, label: REMOVED_HUB_LABEL, typeLabel: "—", state: "Removed", count: removedPlans })
  }
  planEntries.sort((a, b) => b.count - a.count)

  const hubPlans: SeriesPoint[] = planEntries.map((entry) => ({ key: entry.key, label: entry.label, value: entry.count }))
  const topHubs: RankRow[] = planEntries
    .slice(0, 12)
    .map((entry) => ({ key: entry.key, cells: [entry.label, entry.typeLabel, entry.state, entry.count] }))

  const claimEntries: SeriesPoint[] = []
  let removedClaims = 0
  for (const row of claimRows) {
    const id = row.safeZoneHubId
    if (!id) continue
    const hub = hubById.get(id)
    if (!hub) {
      removedClaims += row._count.id
      continue
    }
    claimEntries.push({ key: id, label: hubLabel(hub), value: row._count.id })
  }
  if (removedClaims > 0) {
    claimEntries.push({ key: REMOVED_HUB_KEY, label: REMOVED_HUB_LABEL, value: removedClaims })
  }
  const hubClaims = claimEntries.sort((a, b) => b.value - a.value)

  // By hub TYPE: "which kind of place do people actually meet at" -- a mall
  // information desk, a barangay hall, a police station. This is the shape of
  // the answer when somebody asks where to add the next hub.
  const hubByType: SeriesPoint[] = [...typeTotals.entries()]
    .map(([type, value]) => ({ key: type, label: hubTypeLabel(type), value: value }))
    .sort((a, b) => b.value - a.value)

  const topCities: RankRow[] = [...cityPlans.entries()]
    .map(([city, count]) => ({ key: city, cells: [city, count] }))
    .sort((a, b) => Number(b.cells[1]) - Number(a.cells[1]))
    .slice(0, 10)

  // ── Monthly series ──────────────────────
  const buckets = monthBuckets(from, to)

  const leavesByKey = new Map<string, number>()
  for (const tx of leaves) {
    const key = bucketKey(tx.eventAt)
    leavesByKey.set(key, get(leavesByKey, key) + Math.abs(tx.amount))
  }

  const reportsByMonth = monthlySeries(reportRows.map((r) => r.createdAt), buckets)
  const usersByMonth = monthlySeries(userRows.map((u) => u.createdAt), buckets)
  const leavesByMonth: SeriesPoint[] = buckets.map((b) => ({
    key: b.key,
    label: b.label,
    value: get(leavesByKey, b.key),
    partial: b.partial,
  }))

  // ── Resolution: one cohort, so the ratio cannot pass 100% ───────────
  // `reportRows` is every report FILED in the window. The rate and the median
  // are both read from that same cohort. Counting resolutions in the window
  // against filings in the window (two different sets of reports) would let the
  // rate drift above 100% whenever an old backlog was cleared.
  let cohortResolved = 0
  const resolutionHours: number[] = []
  for (const row of reportRows) {
    if (row.resolvedAt) {
      cohortResolved += 1
      resolutionHours.push(Math.max(0, (row.resolvedAt.getTime() - row.createdAt.getTime()) / HOUR_MS))
    }
  }
  const rate = reportRows.length > 0 ? Math.round((cohortResolved / reportRows.length) * 100) : null

  const totals: ReportTotals = {
    users: users,
    admins: admins,
    suspended: suspended,
    deleted: deleted,
    newUsersInWindow: newUsersInWindow,
    listings: listings,
    listingsAvailable: listingsAvailable,
    listingsHidden: listingsHidden,
    listingsInWindow: listingsInWindow,
    tradesCompleted: tradesCompleted,
    tradesInWindow: tradesInWindow,
    reportsInWindow: reportsFiled,
    reportsResolvedInWindow: reportsResolved,
    idPending: idPending,
    idDecidedInWindow: idDecidedInWindow,
    idApprovedInWindow: idApprovedInWindow,
    appealsOpen: appealsOpen,
    appealsDecidedInWindow: appealsDecidedInWindow,
    appealsOverturnedInWindow: appealsOverturnedInWindow,
    hubsActive: hubsActive,
    hubsInactive: hubsInactive,
    tasksCompletedInWindow: tasksCompletedInWindow,
    actionsInWindow: actionsInWindow,
  }

  const reportsByCategory = mergeByLabel(
    byCategory.map((row) => ({ label: CATEGORY_LABEL[toWireCategory(row.category)], value: row._count.id })),
  )
  const reportsByStatus: SeriesPoint[] = byStatus.map((row) => ({ key: row.status, label: humanise(row.status), value: row._count.id }))
  const tasksCompleted: SeriesPoint[] = byTask.map((row) => ({ key: row.task, label: humanise(row.task), value: row._count.id }))
  const actionsByKind: SeriesPoint[] = byAction.map((row) => ({ key: row.action, label: humanise(row.action), value: row._count.id }))
  const listingsByCategory: SeriesPoint[] = listingsByCategoryRaw.map((row) => ({ key: row.category, label: humanise(row.category), value: row._count.id }))
  const listingsByCondition: SeriesPoint[] = listingsByConditionRaw.map((row) => ({ key: row.condition, label: humanise(row.condition), value: row._count.id }))

  const actionsByActor: ActorRow[] = byActorRaw.map((row) => {
    const person = actorById.get(row.actorId)
    return {
      id: row.actorId,
      name: person && person.name ? person.name : "Unknown",
      role: person ? person.role : "—",
      count: row._count.id,
    }
  })

  const windowOption = WINDOW_OPTIONS.find((option) => option.days === windowDays)
  const reviewsInWindow = reviewAggregate._count.id
  const average = reviewAggregate._avg.rating

  return {
    windowDays: windowDays,
    windowLabel: windowOption ? windowOption.label : "Last " + windowDays + " days",
    generatedAt: to,
    from: from,
    to: to,
    totals: totals,
    leavesByMonth: leavesByMonth,
    reportsByMonth: reportsByMonth,
    usersByMonth: usersByMonth,
    reportsByCategory: reportsByCategory,
    reportsByStatus: reportsByStatus,
    listingsByCategory: listingsByCategory,
    listingsByCondition: listingsByCondition,
    tasksCompleted: tasksCompleted,
    actionsByKind: actionsByKind,
    hubPlans: hubPlans,
    hubClaims: hubClaims,
    hubByType: hubByType,
    resolutionRate: rate,
    medianResolutionHours: median(resolutionHours),
    averageRating: average === null ? null : Math.round(average * 10) / 10,
    reviewsInWindow: reviewsInWindow,
    actionsByActor: actionsByActor,
    topHubs: topHubs,
    topCities: topCities,
  }
}