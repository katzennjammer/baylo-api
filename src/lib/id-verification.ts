import crypto from "crypto"
import { NextResponse } from "next/server"
import prisma from "@/lib/prisma"
import { forbidden } from "@/lib/v1/envelope"
import type { Prisma, PrismaClient } from "@/generated/prisma/client"

/**
 * Government ID verification: the vocabulary, the digest, and the gate.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 *
 * It is NOT `User.isVerified`, and the two must never be folded together.
 * `isVerified` means "controls this mailbox": it is free, instant, and it gates
 * the 20-Leaf signup grant. This is the heavy one — a photographed government
 * ID, looked at by a human — and it gates exactly two acts:
 *
 *   REQUIRES IT      POST /api/items          (listing an item)
 *                    POST /api/v1/contracts   (PROPOSING a deferred agreement)
 *
 *   DOES NOT         browsing, searching, messaging, liking, commenting,
 *                    ACCEPTING a trade, ACCEPTING a DPA
 *
 * THE ACCEPT PATHS ARE OPEN ON PURPOSE and it is the most important line here.
 * A trade or a DPA reaches an unverified user because SOMEBODY ELSE proposed
 * it. Refusing their accept does not protect anyone — it strands a counterparty
 * mid-trade in a situation they did not cause and cannot resolve, with an item
 * already promised. The same asymmetry enforceCanInitiateTrade() draws for DPA
 * defaulters, for the same reason: block the act that creates exposure, never
 * the act that discharges it.
 *
 * ── WHERE THE ANSWER LIVES ──────────────────────────────────────────────────
 *
 * There is no `User.idVerified` boolean. "Is this account ID-verified?" is
 * DERIVED, by isIdVerified() below, from two facts:
 *
 *   an APPROVED IdVerification row, or
 *   a non-null User.idVerifiedGrandfatheredAt
 *
 * A denormalised flag would be a cached copy of a permission — the same mistake
 * the proxy would make by putting `role` in the JWT, and the same one
 * User.totalTrades has already made by drifting above the real trade count. One
 * indexed query on the two write paths that need it is the whole cost.
 *
 * ── THE UI IS NOT THE GATE ──────────────────────────────────────────────────
 *
 * The mobile prompt exists so somebody finds out before they have filled in a
 * seven-step wizard. It is a courtesy. Deleting every screen in the app must
 * change nothing about what the server permits, which is why both enforcement
 * points are route-level and read the database.
 */

// ── ID types ─────────────────────────────────────────────────────────────────

/**
 * The accepted documents, in the order the picker shows them.
 *
 * NO STUDENT IDs. They are held disproportionately by minors — this platform is
 * 18+ — and they are the easiest document on any Philippine list to forge
 * convincingly, because every school prints its own and no reviewer can know
 * what any given one is supposed to look like. Everything below is issued by a
 * national agency against a registry, which is what makes "does this look
 * right?" a question a non-expert reviewer can actually answer.
 *
 * Lower_snake on the wire, SCREAMING_SNAKE in the database, translated by the
 * two explicit maps below rather than by `.toLowerCase()` — a wire value
 * generated from an enum name changes the day somebody renames the enum, and by
 * then a mobile client has shipped against the old spelling. The same call
 * ReportCategory and SafeZoneType make.
 */
export const ID_TYPES = [
  "national_id",
  "drivers_licence",
  "passport",
  "umid",
  "philhealth",
  "postal_id",
  "voters_id",
] as const

export type IdTypeWire = (typeof ID_TYPES)[number]
export type IdTypeDb =
  | "NATIONAL_ID"
  | "DRIVERS_LICENCE"
  | "PASSPORT"
  | "UMID"
  | "PHILHEALTH"
  | "POSTAL_ID"
  | "VOTERS_ID"

const ID_TYPE_TO_DB: Record<IdTypeWire, IdTypeDb> = {
  national_id: "NATIONAL_ID",
  drivers_licence: "DRIVERS_LICENCE",
  passport: "PASSPORT",
  umid: "UMID",
  philhealth: "PHILHEALTH",
  postal_id: "POSTAL_ID",
  voters_id: "VOTERS_ID",
}

const ID_TYPE_TO_WIRE: Record<IdTypeDb, IdTypeWire> = {
  NATIONAL_ID: "national_id",
  DRIVERS_LICENCE: "drivers_licence",
  PASSPORT: "passport",
  UMID: "umid",
  PHILHEALTH: "philhealth",
  POSTAL_ID: "postal_id",
  VOTERS_ID: "voters_id",
}

export const toDbIdType = (t: IdTypeWire): IdTypeDb => ID_TYPE_TO_DB[t]
export const toWireIdType = (t: string): IdTypeWire =>
  ID_TYPE_TO_WIRE[t as IdTypeDb] ?? "national_id"

/** Human labels. Reworded freely; never sent as an id. */
export const ID_TYPE_LABEL: Record<IdTypeWire, string> = {
  national_id: "PhilSys National ID",
  drivers_licence: "Driver's licence",
  passport: "Passport",
  umid: "UMID",
  philhealth: "PhilHealth ID",
  postal_id: "Postal ID",
  voters_id: "Voter's ID",
}

// ── Rejection reasons ────────────────────────────────────────────────────────

/**
 * The closed list of refusals.
 *
 * A CLOSED LIST AND NOT FREE TEXT. The entire value of a rejection to the
 * person who receives it is that they can fix it and try again — and they only
 * get three tries, so "rejected" with no reason costs them a third of their
 * budget on a guess. Each entry below names something the submitter can
 * actually do differently.
 *
 * `fix` is the sentence the USER reads. `label` is what the moderator picks
 * from. They are separate strings because the moderator's shorthand ("blurry")
 * is not an instruction, and the instruction is the point.
 */
export const REJECTION_REASONS = [
  "blurry_photo",
  "name_mismatch",
  "expired_id",
  "wrong_document_type",
  "not_government_id",
] as const

export type RejectionReasonWire = (typeof REJECTION_REASONS)[number]
export type RejectionReasonDb =
  | "BLURRY_PHOTO"
  | "NAME_MISMATCH"
  | "EXPIRED_ID"
  | "WRONG_DOCUMENT_TYPE"
  | "NOT_GOVERNMENT_ID"

const REASON_TO_DB: Record<RejectionReasonWire, RejectionReasonDb> = {
  blurry_photo: "BLURRY_PHOTO",
  name_mismatch: "NAME_MISMATCH",
  expired_id: "EXPIRED_ID",
  wrong_document_type: "WRONG_DOCUMENT_TYPE",
  not_government_id: "NOT_GOVERNMENT_ID",
}

const REASON_TO_WIRE: Record<RejectionReasonDb, RejectionReasonWire> = {
  BLURRY_PHOTO: "blurry_photo",
  NAME_MISMATCH: "name_mismatch",
  EXPIRED_ID: "expired_id",
  WRONG_DOCUMENT_TYPE: "wrong_document_type",
  NOT_GOVERNMENT_ID: "not_government_id",
}

export const toDbRejectionReason = (r: RejectionReasonWire): RejectionReasonDb => REASON_TO_DB[r]
export const toWireRejectionReason = (r: string): RejectionReasonWire =>
  REASON_TO_WIRE[r as RejectionReasonDb] ?? "not_government_id"

export const REJECTION_LABEL: Record<RejectionReasonWire, string> = {
  blurry_photo: "Photo too blurry to read",
  name_mismatch: "Name does not match the account",
  expired_id: "ID has expired",
  wrong_document_type: "Not one of the accepted ID types",
  not_government_id: "Not a government-issued ID",
}

/** What the submitter is told, and what to do about it. */
export const REJECTION_FIX: Record<RejectionReasonWire, string> = {
  blurry_photo:
    "We could not read the photo. Retake it in good light, flat on a dark surface, with the whole ID inside the frame and nothing cut off.",
  name_mismatch:
    "The name on the ID does not match the name on this account. Update your profile name to match your ID exactly, then submit again.",
  expired_id:
    "That ID has expired. Send a current one — any of the accepted types will do.",
  wrong_document_type:
    "That document is not one we accept. Student IDs, company IDs and barangay certificates are not on the list; a national ID, driver's licence, passport, UMID, PhilHealth, postal ID or voter's ID is.",
  not_government_id:
    "That is not a government-issued ID. It has to be a document issued by a national agency — the accepted list is on the submission screen.",
}

// ── The cap ──────────────────────────────────────────────────────────────────

/**
 * Three submissions per account, for the lifetime of the account.
 *
 * Not a rate limit — a budget. The in-memory limiter in @/lib/rate-limit is per
 * process and resets on restart, which is fine for "stop a script" and useless
 * for "stop somebody grinding forged IDs past a tired reviewer". This one is a
 * COUNT(*) over durable rows, so it survives everything.
 *
 * Three and not one because the commonest rejection is a blurry photo taken by
 * a real person with a real ID, and three and not ten because each attempt is a
 * human review. After the third, support — a person, not a form.
 */
export const MAX_ID_SUBMISSIONS = 3

// ── The digest ───────────────────────────────────────────────────────────────

/**
 * Normalises an ID number before it is hashed.
 *
 * WITHOUT THIS THE UNIQUENESS CONSTRAINT DOES NOT WORK. "S01-23-456789",
 * "s0123456789" and "S01 23 456789" are one ID to a human and three different
 * digests to SHA-256, so an attacker re-presenting an approved ID only has to
 * add a dash. Upper-case, and strip everything that is not a letter or a digit.
 *
 * The cost is a collision that a stricter rule would not have: two genuinely
 * different documents whose numbers differ only in punctuation would now clash.
 * Across seven document types that is a fair trade against the alternative,
 * which is a constraint anybody can walk around with a space bar.
 */
export function normaliseIdNumber(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "")
}

/**
 * SHA-256 of the normalised number, hex. THE ONLY FORM THAT IS EVER STORED.
 *
 * SHA-256 and not bcrypt, matching EmailVerificationToken.tokenHash: this
 * digest is LOOKED UP, not verified against a candidate, so the uniqueness
 * check is a unique-index hit and a work factor would make it impossible.
 *
 * State the weakness plainly rather than implying the digest is a vault: an ID
 * number is low-entropy enough that anyone holding this table could brute-force
 * a target number they already suspected. The digest defends against casual
 * reading, against the number turning up in a backup or a log, and against a
 * dump being directly useful. It does not defend against a determined attacker
 * who already has the database. Storing the number itself would be worse in
 * every one of those cases, which is the comparison that matters.
 */
export function hashIdNumber(raw: string): string {
  return crypto.createHash("sha256").update(normaliseIdNumber(raw)).digest("hex")
}

/**
 * Minimum plausible length AFTER normalisation.
 *
 * Not a format check, and deliberately not one. Seven document types with seven
 * formats, several of which have changed within the lifetime of IDs still in
 * circulation; a regex here would reject valid documents and would have to be
 * maintained by somebody who does not have a specimen of each. The human
 * reviewer is the format check. This only catches an empty box and a typo.
 */
export const MIN_ID_NUMBER_LENGTH = 5
export const MAX_ID_NUMBER_LENGTH = 40

// ── Development escape hatch ─────────────────────────────────────────────────

/**
 * Instant approval, for walking the flow.
 *
 * TWO INDEPENDENT CONDITIONS, and both have to hold: the env var must be set
 * AND NODE_ENV must not be "production". Either alone would be one typo away
 * from an ID gate that approves everybody in production — an env var copied
 * into a deploy config, or a NODE_ENV that is unset in some runner. The pair
 * cannot be reached by one mistake.
 *
 * Set `ID_VERIFICATION_DEV_AUTO_APPROVE=1` in .env and a submission is APPROVED
 * on the spot, image destroyed as usual, no queue entry. Everything else about
 * the flow — the cap, the uniqueness constraint, the audit row — behaves
 * exactly as it does in production, so what you are testing is still the real
 * thing with the wait taken out.
 */
export function devAutoApprove(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.ID_VERIFICATION_DEV_AUTO_APPROVE === "1"
  )
}

/**
 * Whether a moderator may decide their OWN submission.
 *
 * Allowed in development, refused in production, and the split is the whole
 * reason this is a function. In development one person is the user, the
 * reviewer and the admin, and forbidding self-review means keeping two accounts
 * open to test one screen. In production it is separation of duties: a
 * moderator who can approve their own ID can approve a forged one, and the
 * audit row would faithfully record them doing it.
 */
export function selfReviewAllowed(): boolean {
  return process.env.NODE_ENV !== "production"
}

// ── Reading the state ────────────────────────────────────────────────────────

type Db = PrismaClient | Prisma.TransactionClient

export type IdVerificationWireStatus =
  /** Never submitted, or the last one was rejected and they may try again. */
  | "unverified"
  | "pending"
  | "approved"
  /** Rejected, with attempts left. */
  | "rejected"
  /** Rejected three times. Support only. */
  | "exhausted"

export interface IdVerificationState {
  /** THE GATE READS THIS AND NOTHING ELSE. */
  verified: boolean
  status: IdVerificationWireStatus
  /** True when the account was let past without a review. */
  grandfathered: boolean
  attemptsUsed: number
  attemptsRemaining: number
  maxAttempts: number
  /** The most recent submission, if any. */
  latest: {
    id: string
    idType: IdTypeWire
    status: "PENDING" | "APPROVED" | "REJECTED"
    rejectionReason: RejectionReasonWire | null
    /** The sentence the user should act on. Null unless rejected. */
    rejectionFix: string | null
    submittedAt: Date
    reviewedAt: Date | null
    attemptCount: number
  } | null
}

/**
 * The whole verification state of one account, in one query plus a count.
 *
 * Everything the prompt screen, the status screen, the profile payload and both
 * gates need, derived in one place. The alternative — each caller assembling
 * its own view — is how "verified" ends up meaning four slightly different
 * things depending on which screen you are looking at.
 */
export async function loadIdVerificationState(
  userId: string,
  db: Db = prisma,
): Promise<IdVerificationState> {
  const [user, latest, attemptsUsed] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: { idVerifiedGrandfatheredAt: true },
    }),
    db.idVerification.findFirst({
      where: { userId },
      orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        idType: true,
        status: true,
        rejectionReason: true,
        submittedAt: true,
        reviewedAt: true,
        attemptCount: true,
      },
    }),
    db.idVerification.count({ where: { userId } }),
  ])

  const grandfathered = !!user?.idVerifiedGrandfatheredAt
  // An APPROVED row anywhere in the history counts, not merely the latest one.
  // In practice approval ends the flow so the latest IS the approved one, but
  // reading "latest.status === APPROVED" would make the answer depend on row
  // ordering, and a permission should not.
  const approved =
    latest?.status === "APPROVED" ||
    (await db.idVerification.count({ where: { userId, status: "APPROVED" } })) > 0

  const attemptsRemaining = Math.max(0, MAX_ID_SUBMISSIONS - attemptsUsed)

  const status: IdVerificationWireStatus = approved
    ? "approved"
    : latest?.status === "PENDING"
      ? "pending"
      : latest?.status === "REJECTED"
        ? attemptsRemaining > 0
          ? "rejected"
          : "exhausted"
        : "unverified"

  const reason = latest?.rejectionReason ? toWireRejectionReason(latest.rejectionReason) : null

  return {
    // Grandfathered OR approved. Note that grandfathering does NOT change
    // `status`: a grandfathered account reads as "approved" for the gate and
    // `grandfathered: true` beside it, so a screen can say "you were let
    // through when this launched" rather than claiming a review that never
    // happened.
    verified: grandfathered || approved,
    status: grandfathered && !approved ? "approved" : status,
    grandfathered,
    attemptsUsed,
    attemptsRemaining,
    maxAttempts: MAX_ID_SUBMISSIONS,
    latest: latest
      ? {
          id: latest.id,
          idType: toWireIdType(latest.idType),
          status: latest.status as "PENDING" | "APPROVED" | "REJECTED",
          rejectionReason: reason,
          rejectionFix: latest.status === "REJECTED" && reason ? REJECTION_FIX[reason] : null,
          submittedAt: latest.submittedAt,
          reviewedAt: latest.reviewedAt,
          attemptCount: latest.attemptCount,
        }
      : null,
  }
}

/**
 * The gate's own question, as cheaply as it can be asked.
 *
 * Two indexed reads and no assembly, because this runs on the hot path of every
 * listing creation and every DPA proposal. loadIdVerificationState() above is
 * for screens; this is for gates.
 */
export async function isIdVerified(userId: string, db: Db = prisma): Promise<boolean> {
  const [user, approved] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: { idVerifiedGrandfatheredAt: true },
    }),
    db.idVerification.count({ where: { userId, status: "APPROVED" } }),
  ])
  return !!user?.idVerifiedGrandfatheredAt || approved > 0
}

// ── The gate ─────────────────────────────────────────────────────────────────

/**
 * The stable error code both gates answer with.
 *
 * ONE CODE, TWO ROUTE FAMILIES. /api/items answers bare `{ error, code }` and
 * /api/v1/* answers the envelope, so the two helpers below differ in shape —
 * but a client branching on "the user needs to verify" sees the same string
 * either way, which is the only part it is allowed to depend on.
 */
export const ID_VERIFICATION_REQUIRED = "ID_VERIFICATION_REQUIRED"

/** What the user is told, once, in one place. */
function gateMessage(what: "post" | "propose", state: IdVerificationState): string {
  const act =
    what === "post" ? "post an item" : "propose a deferred agreement"

  switch (state.status) {
    case "pending":
      return `Your ID is still being reviewed. You can ${act} as soon as it is approved — usually within a day.`
    case "rejected":
      return `Your ID was not approved, so you cannot ${act} yet. You can submit again — ${state.attemptsRemaining} of ${state.maxAttempts} attempts left.`
    case "exhausted":
      return `Your ID was not approved after ${state.maxAttempts} attempts, so you cannot ${act}. Contact support to continue.`
    default:
      return `Verify your ID to ${act}. It takes a photo of a government ID and is usually reviewed within a day — everything else on Baylo stays open to you in the meantime.`
  }
}

/**
 * The public half of the state: what a 403 body and the profile payload carry.
 *
 * Advisory, always. The same query is re-run server-side on the next attempt,
 * and nothing a client sends back about its own verification state is read.
 */
export function publicIdVerification(state: IdVerificationState) {
  return {
    verified: state.verified,
    status: state.status,
    grandfathered: state.grandfathered,
    attemptsUsed: state.attemptsUsed,
    attemptsRemaining: state.attemptsRemaining,
    maxAttempts: state.maxAttempts,
    latest: state.latest
      ? {
          idType: state.latest.idType,
          status: state.latest.status,
          rejectionReason: state.latest.rejectionReason,
          rejectionFix: state.latest.rejectionFix,
          submittedAt: state.latest.submittedAt,
          reviewedAt: state.latest.reviewedAt,
          attemptCount: state.latest.attemptCount,
        }
      : null,
  }
}

/**
 * The gate for the pre-v1 routes: bare `{ error, code, … }`, 403.
 *
 * Returns a ready-to-return NextResponse or null, the same shape as
 * enforceRateLimit() and enforceInitiateTrade() — so a handler reads the same
 * way whichever kind of gate is refusing it.
 *
 * The 403 body carries the FULL state, not merely the refusal. A client that
 * has just been told "no" is exactly the client that needs to know whether the
 * answer is "submit one", "wait", "fix the photo and resubmit" or "talk to a
 * human", and making it ask a second endpoint to find out is a round trip in
 * front of an error screen.
 */
export async function enforceIdVerifiedLegacy(
  userId: string,
  what: "post" | "propose" = "post",
): Promise<NextResponse | null> {
  if (await isIdVerified(userId)) return null

  const state = await loadIdVerificationState(userId)
  return NextResponse.json(
    {
      error: gateMessage(what, state),
      code: ID_VERIFICATION_REQUIRED,
      idVerification: publicIdVerification(state),
    },
    { status: 403 },
  )
}

/**
 * The same gate in the /api/v1 envelope.
 *
 * The envelope's `code` is FORBIDDEN — that field is a closed set of transport
 * codes and adding to it would break the one guarantee it makes. The specific
 * reason goes in `meta.rule`, which is where every other v1 gate puts it
 * (DPA_MIN_COMPLETED_TRADES, TIER_ITEM_VALUE_CAP). Callers branch on
 * `meta.rule`, not on the message.
 */
export async function enforceIdVerifiedV1(
  userId: string,
  what: "post" | "propose" = "propose",
): Promise<NextResponse | null> {
  if (await isIdVerified(userId)) return null

  const state = await loadIdVerificationState(userId)
  return forbidden(gateMessage(what, state), {
    rule: ID_VERIFICATION_REQUIRED,
    idVerification: publicIdVerification(state),
  })
}
