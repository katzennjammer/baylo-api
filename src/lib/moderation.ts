import type { Prisma, PrismaClient } from "@/generated/prisma/client"

/**
 * Report vocabulary, suspension, and the audit writer.
 *
 * Shared between the reporting routes, the block routes and the /api/admin
 * surface. Two neighbours own the other halves:
 *
 *   @/lib/api-auth   requireRole(), which lives beside resolveSession() because
 *                    it IS an authentication concern -- and because putting it
 *                    here would make this module import api-auth while api-auth
 *                    imports suspensionState() from here, a cycle.
 *   @/lib/blocking   block enforcement, which is a query-shape concern.
 *
 * NOTHING IN THIS MODULE IMPORTS @/lib/api-auth. Keep it that way.
 */

// ── Suspension ───────────────────────────────────────────────────────────────

export interface SuspensionState {
  suspended: boolean
  /** True when the suspension in force has no endsAt. */
  indefinite: boolean
  /** When the suspension in force began, or null when there is none. */
  since: Date | null
  until: Date | null
  /** What the admin wrote when imposing it. SHOWN TO THE USER at sign-in. */
  reason: string | null
  /** Which suspension this is for the account: 1 = first, 2 = second, ... */
  level: number | null
}

/**
 * A Suspension row that is IN FORCE at `now`: not lifted, and either
 * indefinite (endsAt IS NULL) or still running (endsAt in the future).
 *
 * The trap this exists to close: `endsAt == null` looks like "over" and means
 * the opposite — an indefinite suspension. And a row merely EXISTING means
 * nothing at all, because rows are kept as history. So nothing tests a column
 * alone; every reader goes through this, suspensionState() or
 * notSuspendedWhere().
 *
 * A lapsed suspension (endsAt is in the past) reads as not in force and the
 * row is left alone. There is no sweep and none is needed: nothing accrues
 * while a suspension runs, so lazily deciding "is it over?" at read time gives
 * exactly the same answer a sweep would have written.
 */
export function activeSuspensionWhere(now: Date = new Date()): Prisma.SuspensionWhereInput {
  return { liftedAt: null, OR: [{ endsAt: null }, { endsAt: { gt: now } }] }
}

/**
 * How a reader loads what suspensionState() needs:
 * `suspensions: activeSuspension()` in a User select or include.
 */
export function activeSuspension(now: Date = new Date()) {
  return {
    where: activeSuspensionWhere(now),
    select: { startsAt: true, endsAt: true, liftedAt: true, reason: true, level: true },
    take: 1,
  } satisfies Prisma.User$suspensionsArgs
}

/**
 * The ONLY correct reading of a user's suspensions.
 *
 * Applies the in-force rule itself rather than trusting that the rows it was
 * handed were loaded with activeSuspension(): a caller that selected the whole
 * history must not read as suspended because of a row from last year.
 */
export function suspensionState(user: {
  suspensions: { startsAt: Date; endsAt: Date | null; liftedAt: Date | null; reason?: string; level?: number }[]
}): SuspensionState {
  const now = Date.now()
  const s = user.suspensions.find((s) => !s.liftedAt && (s.endsAt === null || s.endsAt.getTime() > now))
  if (!s) return { suspended: false, indefinite: false, since: null, until: null, reason: null, level: null }
  return {
    suspended: true, indefinite: s.endsAt === null, since: s.startsAt, until: s.endsAt,
    reason: s.reason ?? null, level: s.level ?? null,
  }
}

/**
 * The 403 body a sign-in route answers a suspended account with.
 *
 * ONLY EVER SENT AFTER THE CALLER HAS PROVED THE ACCOUNT IS THEIRS -- a correct
 * password, or a Google ID token for its email. Before that point "suspended"
 * is an answer about somebody else's account, and saying it would let anyone
 * enumerate who is suspended and why.
 *
 * `error` is the whole message for a client that shows nothing else; the other
 * fields let the app lay out a proper notice: the reason the admin gave, when
 * it started and ends, and which suspension this is for the account.
 */
export function suspendedBody(state: SuspensionState) {
  return {
    error: state.indefinite
      ? "This account has been suspended. Contact support if you think that is a mistake."
      : `This account is suspended until ${state.until!.toLocaleDateString()}.`,
    code: "ACCOUNT_SUSPENDED",
    indefinite: state.indefinite,
    since: state.since,
    until: state.until,
    reason: state.reason,
    level: state.level,
  }
}

/**
 * suspensionState() as a WHERE fragment: "this user is not suspended RIGHT NOW".
 *
 * The same rule as the function above. `suspensions: { none: {} }` is the
 * obvious shorthand and is wrong in a way that reads as correct: it keeps
 * hiding a user whose suspension EXPIRED or was lifted, because the row stays.
 * A seven-day suspension would become permanent for every query that took the
 * shortcut.
 *
 * A single relation key, so it composes into a `where` that already has an
 * `OR` of its own without either clobbering the other.
 */
export function notSuspendedWhere(now: Date = new Date()): Prisma.UserWhereInput {
  return { suspensions: { none: activeSuspensionWhere(now) } }
}

/** The opposite of notSuspendedWhere(): "this user IS suspended right now". */
export function suspendedWhere(now: Date = new Date()): Prisma.UserWhereInput {
  return { suspensions: { some: activeSuspensionWhere(now) } }
}

const DAY_MS = 24 * 60 * 60 * 1000

// Manila, spelled out: the server's own zone and locale are whatever the host
// happens to be, and this date is read by a person in the Philippines.
const noticeDate = (d: Date) =>
  d.toLocaleDateString("en-PH", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Manila" })

/**
 * The words of the "your suspension is over" notice. Pure, so the wording is
 * checkable without a database (scripts/verify-suspension-subscription.ts).
 *
 * It restates the reason and the length because the notice is read days after
 * the lockout screen was: "your suspension ended" with nothing beside it leaves
 * the person to remember what it was for. A reason is quoted verbatim but cut
 * at 200 characters -- this is one row in a list, not the appeal record.
 */
export function suspensionEndedMessage(s: {
  reason: string
  startsAt: Date
  endsAt: Date | null
  liftedAt: Date | null
}): string {
  const reason = s.reason.length > 200 ? `${s.reason.slice(0, 200).trimEnd()}…` : s.reason
  const why = `It was placed for: "${reason}"`
  const close = "Thank you for your patience. Please keep to the community rules so this stays behind you."

  // Lifted by staff before it would have ended (or it had no end at all).
  if (s.liftedAt && (s.endsAt === null || s.liftedAt.getTime() < s.endsAt.getTime())) {
    return `Welcome back. Our team lifted the suspension on your account on ${noticeDate(s.liftedAt)}${
      s.endsAt ? ", ahead of its end date" : ""
    }. ${why} ${close}`
  }
  // Ran its course. endsAt is set here: an indefinite one can only be lifted.
  const days = Math.max(1, Math.round((s.endsAt!.getTime() - s.startsAt.getTime()) / DAY_MS))
  return `Welcome back. Your ${days}-day suspension ended on ${noticeDate(s.endsAt!)}. ${why} ${close}`
}

/**
 * Tells an account its suspension is over. Called by the sign-in routes, after
 * they have established the account is NOT suspended right now.
 *
 * AT SIGN-IN, NOT AT THE MOMENT IT ENDS, because for half the cases there is no
 * such moment: a timed suspension simply stops being in force when the clock
 * passes endsAt, and nothing runs then (see activeSuspensionWhere()). Doing it
 * here covers that case and the admin's unsuspend with one code path, and
 * costs the user nothing -- they could not have read it any earlier.
 *
 * ONCE PER SUSPENSION: the notice carries the Suspension's id as its entity,
 * and a second sign-in finds it and stops.
 *
 * NEVER THROWS. A courtesy notice must not be able to fail a sign-in; a failure
 * is logged and the next sign-in tries again.
 */
export async function notifySuspensionEnded(db: PrismaClient, userId: string): Promise<void> {
  try {
    const now = new Date()
    const last = await db.suspension.findFirst({
      where: { userId, OR: [{ liftedAt: { not: null } }, { endsAt: { lte: now } }] },
      orderBy: { startsAt: "desc" },
    })
    if (!last) return

    const told = await db.notification.findFirst({
      where: { userId, entityType: "suspension", entityId: last.id },
      select: { id: true },
    })
    if (told) return

    await db.notification.create({
      data: {
        userId,
        type: "SUSPENSION_LIFTED",
        message: suspensionEndedMessage(last),
        // No `actorId`: the user must not learn which moderator handled it.
        entityType: "suspension",
        entityId: last.id,
      },
    })
  } catch (e) {
    console.error("[moderation] could not write the suspension-ended notice", e)
  }
}

// ── Report vocabulary ────────────────────────────────────────────────────────

/**
 * The wire spelling of a report category, and the closed set of them.
 *
 * Lower-case snake on the wire, SCREAMING_SNAKE in the database. The two maps
 * below are the whole translation, and they are explicit rather than derived
 * (`.toLowerCase()`) for the reason Item.valuationSource records: a wire value
 * generated from a database enum name changes the day somebody renames the
 * enum, and by then a mobile client has shipped against the old spelling.
 */
export const REPORT_CATEGORIES = [
  "spam",
  "prohibited_item",
  "scam_or_fraud",
  "harassment",
  "counterfeit",
  "other",
] as const

export type ReportCategoryWire = (typeof REPORT_CATEGORIES)[number]
export type ReportCategoryDb =
  | "SPAM"
  | "PROHIBITED_ITEM"
  | "SCAM_OR_FRAUD"
  | "HARASSMENT"
  | "COUNTERFEIT"
  | "OTHER"

const CATEGORY_TO_DB: Record<ReportCategoryWire, ReportCategoryDb> = {
  spam: "SPAM",
  prohibited_item: "PROHIBITED_ITEM",
  scam_or_fraud: "SCAM_OR_FRAUD",
  harassment: "HARASSMENT",
  counterfeit: "COUNTERFEIT",
  other: "OTHER",
}

const CATEGORY_TO_WIRE: Record<ReportCategoryDb, ReportCategoryWire> = {
  SPAM: "spam",
  PROHIBITED_ITEM: "prohibited_item",
  SCAM_OR_FRAUD: "scam_or_fraud",
  HARASSMENT: "harassment",
  COUNTERFEIT: "counterfeit",
  OTHER: "other",
}

export const toDbCategory = (c: ReportCategoryWire): ReportCategoryDb => CATEGORY_TO_DB[c]
export const toWireCategory = (c: string): ReportCategoryWire =>
  CATEGORY_TO_WIRE[c as ReportCategoryDb] ?? "other"

/** Human labels for the admin queue. Reworded freely; never sent as an id. */
export const CATEGORY_LABEL: Record<ReportCategoryWire, string> = {
  spam: "Spam",
  prohibited_item: "Prohibited item",
  scam_or_fraud: "Scam or fraud",
  harassment: "Harassment",
  counterfeit: "Counterfeit",
  other: "Other",
}

export const REPORT_TARGET_TYPES = ["listing", "user", "message", "story"] as const
export type ReportTargetWire = (typeof REPORT_TARGET_TYPES)[number]
export type ReportTargetDb = "LISTING" | "USER" | "MESSAGE" | "STORY"

const TARGET_TO_DB: Record<ReportTargetWire, ReportTargetDb> = {
  listing: "LISTING",
  user: "USER",
  message: "MESSAGE",
  story: "STORY",
}
const TARGET_TO_WIRE: Record<ReportTargetDb, ReportTargetWire> = {
  LISTING: "listing",
  USER: "user",
  MESSAGE: "message",
  STORY: "story",
}

export const toDbTarget = (t: ReportTargetWire): ReportTargetDb => TARGET_TO_DB[t]
export const toWireTarget = (t: string): ReportTargetWire =>
  TARGET_TO_WIRE[t as ReportTargetDb] ?? "user"

/**
 * Cap on the reporter's free text.
 *
 * `notes` is @db.Text (64 KB). 2,000 characters is enough to describe what
 * happened and short enough that a moderator reads it rather than skimming it —
 * and short enough that the report table is not a place to store a novel per
 * button press.
 */
export const MAX_REPORT_NOTES = 2000

/** Statuses that count as still open. Both of them, everywhere. */
export const LIVE_REPORT_STATUSES = ["OPEN", "REVIEWING"] as const

/**
 * The value of Report.openKey while a report is live.
 *
 * A single shared literal because it appears in a unique index: two spellings
 * would silently permit two live reports per target, which is the exact thing
 * the index exists to prevent.
 */
export const OPEN_KEY = "live"

// ── The audit writer ─────────────────────────────────────────────────────────

export type AdminActionKind =
  | "REPORT_REVIEWING"
  | "REPORT_DISMISSED"
  | "REPORT_ACTIONED"
  | "LISTING_HIDDEN"
  | "LISTING_UNHIDDEN"
  | "USER_SUSPENDED"
  | "USER_UNSUSPENDED"
  // Safe-Zone hubs. These are acts on SHARED INFRASTRUCTURE rather than on a
  // person or their content, which is a new kind of entry in this log and
  // deliberately kept in the same one: a hub coordinate that quietly moved 400
  // metres, with nobody named against the change, is a worse failure than most
  // takedowns -- people navigate to these places, and the first sign of trouble
  // is two strangers standing in different car parks.
  | "HUB_CREATED"
  | "HUB_UPDATED"
  | "HUB_DEACTIVATED"
  | "HUB_REACTIVATED"
  // Government ID decisions. A third kind of entry again: not an act on a
  // person's content and not one on shared infrastructure, but a decision about
  // WHO SOMEBODY IS -- the only thing in this log that grants a privilege
  // rather than removing one. It belongs in the same place for exactly that
  // reason: an approval that let a forged ID through is the entry you most want
  // to be able to find next to the suspensions that followed it.
  //
  // The row is the ONLY durable record of the decision. The submission's image
  // is destroyed by the same transaction that writes this, and the ID number
  // was never stored in the first place -- so "who approved this, and when" is
  // answerable here or nowhere.
  | "ID_VERIFICATION_APPROVED"
  | "ID_VERIFICATION_REJECTED"
  | "ROLE_CHANGED"
  // Bracket trading (16 Sep 2026). A value review is a decision about what a
  // listing may CLAIM to be worth -- the bracket it trades in -- and both
  // outcomes are recorded with both numbers in `detail`. A reward reversal
  // moves Leaves, which is the one thing nothing else in this log does; the
  // ledger rows it writes point at the trade, this row says who and why. A
  // cancellation is an act on the parties' behalf and names the reason.
  | "LISTING_VALUE_APPROVED"
  | "LISTING_VALUE_REJECTED"
  | "TRADE_REWARD_REVERSED"
  | "TRADE_CANCELLED"
  // Listing appeals (18 Sep 2026). A decision about a DECISION: the target is
  // the appeal, and `detail` names the audit row it was against, both values,
  // and `sameReviewer` when the decider is the one being appealed.
  | "LISTING_APPEAL_UPHELD"
  | "LISTING_APPEAL_OVERTURNED"
  // Achievements (admin surface). The target is the Achievement DEFINITION,
  // not a user's earned copy -- creating and editing a badge is a decision
  // about what can be earned, and `detail` carries the prior/new field values.
  | "ACHIEVEMENT_CREATED"
  | "ACHIEVEMENT_UPDATED"
  | "ACHIEVEMENT_DEACTIVATED"
  | "ACHIEVEMENT_REACTIVATED"
  // Business-document reviews (23 Sep 2026). The same KIND of entry as the ID
  // pair above -- a decision about who somebody is, granting rather than
  // removing -- with one difference worth knowing when reading the log: a
  // rejection here takes nothing away. A refused ID means the account still
  // cannot post; a refused business document means the organisation carries on
  // trading without a checkmark. So an ORGANIZATION_REJECTED row is never the
  // cause of anything that follows it, which an ID_VERIFICATION_REJECTED row
  // very often is.
  //
  // As with the ID pair, this row is the only durable record: the document is
  // destroyed by the same transaction that writes this.
  | "ORGANIZATION_VERIFIED"
  | "ORGANIZATION_REJECTED"

export type AdminTargetType =
  | "REPORT"
  | "LISTING"
  | "USER"
  | "HUB"
  | "ID_VERIFICATION"
  | "TRADE"
  | "LISTING_APPEAL"
  | "ACHIEVEMENT"
  // The Organization row, never its backing User row. A reader following this
  // target id wants the review and its document history, not an account page
  // that shows a synthetic row with no password and no email anybody reads.
  | "ORGANIZATION"

/** A Prisma client or a transaction client. */
type Db = PrismaClient | Prisma.TransactionClient

/**
 * Writes one audit row.
 *
 * ALWAYS CALLED INSIDE THE SAME TRANSACTION AS THE CHANGE IT DESCRIBES, and
 * that is the only rule this function has. An audit row written afterwards, on
 * its own connection, is an audit row that can fail to exist for a change that
 * did happen — and a moderation log with holes in it is worse than no log,
 * because it invites the reader to trust the rows that are there.
 *
 * It deliberately does NOT swallow errors, unlike awardTaskAsync() next door.
 * A task reward that fails to record costs somebody ten Leaves; an admin action
 * that fails to record costs the ability to answer "who suspended this user?".
 * If the audit write throws, the moderation action rolls back with it. That is
 * the correct outcome.
 */
export async function writeAudit(
  db: Db,
  input: {
    actorId: string
    action: AdminActionKind
    targetType: AdminTargetType
    targetId: string
    /** The moderation case (report or appeal) this answers. Stored as AdminAction.caseId. */
    reportId?: string | null
    reason: string
    detail?: unknown
  },
) {
  return db.adminAction.create({
    data: {
      actorId: input.actorId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      caseId: input.reportId ?? null,
      reason: input.reason,
      detail: input.detail === undefined ? null : JSON.stringify(input.detail),
    },
  })
}

/**
 * Closes a report and tells the reporter.
 *
 * Three things move together, in one transaction:
 *   1. the report's status, resolvedBy/resolvedAt, and openKey -> NULL
 *   2. the audit row
 *   3. the REPORT_RESOLVED notification to the reporter
 *
 * ON (1): `openKey` is nulled in the SAME UPDATE as `status`. Two statements
 * would leave a window in which the report reads as resolved while still
 * holding its slot in the unique index, and a reporter refiling in that window
 * gets a spurious conflict. See the long note on the column.
 *
 * ON (3): the notification is inside the transaction, not fired afterwards.
 * /trust promises the reporter an outcome and Google Play's UGC policy expects
 * one; a resolution that silently fails to notify is a promise this system is
 * quietly not keeping, and the way to find out is never.
 *
 * `note` is what the reporter reads. It is written by the moderator and passed
 * through verbatim — it is not a template, because the useful half of "we
 * removed the listing" is which listing and why.
 */
export async function resolveReport(
  db: Db,
  input: {
    reportId: string
    reporterId: string
    actorId: string
    status: "ACTIONED" | "DISMISSED"
    note: string
  },
) {
  const now = new Date()

  // A REPORT row of ModerationCase (schema v2). The `type` in the WHERE means
  // an appeal id can never be closed through this path.
  await db.moderationCase.update({
    where: { id: input.reportId, type: "REPORT" },
    data: {
      status: input.status,
      // Same statement as `status`. Never its own.
      openKey: null,
      decidedById: input.actorId,
      decidedAt: now,
      decisionNote: input.note,
    },
  })

  await writeAudit(db, {
    actorId: input.actorId,
    action: input.status === "ACTIONED" ? "REPORT_ACTIONED" : "REPORT_DISMISSED",
    targetType: "REPORT",
    targetId: input.reportId,
    reportId: input.reportId,
    reason: input.note,
  })

  await db.notification.create({
    data: {
      userId: input.reporterId,
      type: "REPORT_RESOLVED",
      message:
        input.status === "ACTIONED"
          ? `We reviewed your report and took action. ${input.note}`
          : `We reviewed your report and did not find a policy violation. ${input.note}`,
      // No `actorId`: the reporter must not learn which moderator handled it,
      // and on a harassment report they must certainly not be handed a name to
      // go and contact. The audit row knows; the notification does not.
      link: "/dashboard",
      entityType: "report",
      entityId: input.reportId,
    },
  })
}
