import type { PrismaClient } from "@/generated/prisma/client"
import prisma from "@/lib/prisma"

/**
 * Organisations / MSMEs: who they are, who may act as them, and what a badge
 * is allowed to claim about them.
 *
 * ── AN ORGANISATION IS A User ROW ───────────────────────────────────────────
 *
 * Read the note on the `Organization` model before changing anything here. The
 * short version: everything that makes an account visible on Baylo is a
 * required foreign key to User, so an organisation that were merely a row
 * beside a user could own no items, be followed by nobody and hold no Leaves.
 * Backing it with a User row means every one of those FKs keeps working with no
 * change at all — `Item.userId = orgUserId` is the same column, the same query
 * and the same shape on the wire as any other listing.
 *
 * It also means the Leaf ledger is untouched. An org holds Leaves on its own
 * User row, so SUM(User.leaves) == SUM(LeafTransaction.amount) stays true
 * across orgs without a line of @/lib/leaves or @/lib/bridge-fee changing.
 *
 * ── THE ORG CONTEXT IS A HEADER, RE-CHECKED EVERY REQUEST. NOT A JWT CLAIM ──
 *
 * The obvious design is to mint the active organisation into the access token,
 * and it has a hole this codebase has already decided it will not accept.
 * Access tokens here are stateless and live 15 minutes, which is precisely why
 * resolveSession() re-reads deletion and suspension from the database on every
 * single request — its own note says a moderator who suspends an account at
 * 10:00 must not have to wait until 10:15. Org membership is the same kind of
 * fact: an owner who removes a staff member at 10:00 must not watch them keep
 * posting as the organisation until 10:15.
 *
 * So the client names the organisation it is acting as in `X-Baylo-Org`, and
 * `resolveActingIdentity()` below re-derives the permission from an ACTIVE
 * OrganizationMember row on every call. A stale or revoked context is refused
 * at once, and switching organisations costs no round trip to re-mint anything.
 * The header is a REQUEST, never a grant; the row is the grant.
 *
 * ── ORGS DO NOT CLIMB THE TRUST LADDER ──────────────────────────────────────
 *
 * The trade-count trust tiers and the leaf-rank badge are about a person
 * building a reputation. An organisation's badge is its `verificationStatus`
 * and nothing else, so every discovery query that ranks or suggests PEOPLE
 * spreads in `notAnOrgWhere()`, and the shaping helpers emit `org` in place of
 * `trustTier` rather than alongside it — see `identityBadge()`.
 */

/** The header a client names its acting organisation in. See the note above. */
export const ORG_CONTEXT_HEADER = "x-baylo-org"

/**
 * Exclude organisation accounts from a `User` where-clause.
 *
 * Spread into every aggregate or suggestion that is about PEOPLE: the trust
 * ladder, the leaf-rank ranking, the home feed's "traders near you". An
 * organisation appearing in a list of people to follow is a category error,
 * and one appearing in a trust-tier distribution silently skews it.
 *
 * A PREDICATE AND NOT A JOIN, which is the whole reason `isOrgAccount` is a
 * stored column rather than `organization: { is: null }`. See the note on the
 * User model.
 */
export function notAnOrgWhere() {
  return { isOrgAccount: false } as const
}

/** Exactly the Organization columns a badge or profile header needs. */
export const ORG_PUBLIC_SELECT = {
  id: true,
  name: true,
  logoUrl: true,
  businessCategory: true,
  verificationStatus: true,
} as const

export type OrgPublicRow = {
  id: string
  name: string
  logoUrl: string | null
  businessCategory: string
  verificationStatus: "PENDING" | "VERIFIED" | "REJECTED"
}

export interface OrgBadge {
  id: string
  name: string
  logoUrl: string | null
  businessCategory: string
  /** What the checkmark is allowed to claim. Only VERIFIED earns the badge. */
  verified: boolean
}

/**
 * The public badge for an organisation.
 *
 * `verified` is derived here and nowhere else, so that "Verified MSME" cannot
 * come to mean "an Organization row exists". A PENDING org is a real account
 * that can trade — it has no checkmark yet and cannot post (see
 * orgPostingRefusal), and a client that renders a badge off the mere presence
 * of this object would be claiming a review that has not happened.
 */
export function orgBadge(row: OrgPublicRow): OrgBadge {
  return {
    id: row.id,
    name: row.name,
    logoUrl: row.logoUrl,
    businessCategory: row.businessCategory,
    verified: row.verificationStatus === "VERIFIED",
  }
}

/**
 * The ONE badge an account carries, as an either/or.
 *
 * An organisation gets `org`; a person gets `trustTier`. Never both, and that
 * is the point — the spec asks for the verified-organisation badge to REPLACE
 * the trust-tier badge rather than sit beside it, and a shape that can carry
 * both is a shape where some client will eventually render both.
 */
export type IdentityBadge =
  | { kind: "org"; org: OrgBadge }
  | { kind: "person"; trustTier: string | null }

export function identityBadge(
  owner: { organization?: OrgPublicRow | null },
  trustTier: string | null,
): IdentityBadge {
  return owner.organization
    ? { kind: "org", org: orgBadge(owner.organization) }
    : { kind: "person", trustTier }
}

// ── Why a review said no, and what posting as the org is allowed to do ───────

export const ORG_REJECTION_REASONS = [
  "BLURRY_DOCUMENT",
  "NAME_MISMATCH",
  "EXPIRED_REGISTRATION",
  "WRONG_DOCUMENT_TYPE",
  "NOT_A_BUSINESS_DOCUMENT",
] as const

export type OrgRejectionReason = (typeof ORG_REJECTION_REASONS)[number]

export const ORG_REJECTION_LABEL: Record<OrgRejectionReason, string> = {
  BLURRY_DOCUMENT: "Too blurry to read",
  NAME_MISMATCH: "Name does not match the account",
  EXPIRED_REGISTRATION: "Registration has expired",
  WRONG_DOCUMENT_TYPE: "Not a document we accept",
  NOT_A_BUSINESS_DOCUMENT: "Not a business document",
}

/**
 * What the applicant is told, per reason. The FIX, not the verdict.
 *
 * Same rule as REJECTION_FIX next door: "rejected" tells somebody nothing they
 * can act on, and the entire value of a closed reason list is that each value
 * maps to a sentence describing what to do about it.
 */
export const ORG_REJECTION_FIX: Record<OrgRejectionReason, string> = {
  BLURRY_DOCUMENT:
    "We could not read your business document. Retake the photo in good light with the whole page in frame.",
  NAME_MISMATCH:
    "The name on the document does not match your organisation's name on Baylo. Update one to match the other and send it again.",
  EXPIRED_REGISTRATION:
    "That registration has expired. Send a current DTI/SEC registration or barangay permit.",
  WRONG_DOCUMENT_TYPE:
    "We accept a DTI or SEC registration, or a barangay business permit. Send one of those.",
  NOT_A_BUSINESS_DOCUMENT:
    "That does not look like a business document. Send your DTI/SEC registration or barangay permit.",
}

export type OrgVerificationStatus = "PENDING" | "VERIFIED" | "REJECTED"

/** The two refusal codes a client branches on. See orgPostingRefusal(). */
export const ORG_VERIFICATION_PENDING = "ORG_VERIFICATION_PENDING"
export const ORG_VERIFICATION_REJECTED = "ORG_VERIFICATION_REJECTED"

export interface OrgPostingRefusal {
  code: typeof ORG_VERIFICATION_PENDING | typeof ORG_VERIFICATION_REJECTED
  /** Shown to the person verbatim, on the phone before the wizard and in the 403. */
  message: string
  /** The reviewer's closed reason, for a REJECTED org that has one. */
  rejectionReason: OrgRejectionReason | null
}

/**
 * Whether a listing may be posted AS this organisation, and if not, what to
 * tell the person trying.
 *
 * ── ONLY A VERIFIED ORG POSTS ───────────────────────────────────────────────
 *
 * Posting as an org puts a business's name on a listing, so it is the business
 * that has to have been checked. A PENDING org has not been; a REJECTED one was
 * checked and failed. Neither may post, and a staff member's own verified ID is
 * NOT a way around that: a person's ID says who they are, not that the shop
 * they claim is real. (A VERIFIED org, conversely, needs no personal ID from
 * its staff at all. See POST /api/items.)
 *
 * Posting AS ONESELF never comes through here. Somebody whose shop is still in
 * review lists their own things under the personal ID rule exactly as before.
 *
 * ONE function for both the enforcement and the explanation: the 403 from POST
 * /api/items and the sentence the phone shows before the wizard opens are the
 * same string, so they cannot drift.
 *
 * The REJECTED sentence says "contact support to resubmit" rather than just
 * "resubmit" because there is no resubmission flow yet: the only way from
 * REJECTED back to PENDING today is a person doing it by hand.
 */
export function orgPostingRefusal(
  status: OrgVerificationStatus,
  rejectionReason: string | null,
): OrgPostingRefusal | null {
  if (status === "VERIFIED") return null
  if (status === "PENDING") {
    return {
      code: ORG_VERIFICATION_PENDING,
      message:
        "Your business verification is still under review — you'll be able to post once it's approved.",
      rejectionReason: null,
    }
  }
  const reason = (ORG_REJECTION_REASONS as readonly string[]).includes(rejectionReason ?? "")
    ? (rejectionReason as OrgRejectionReason)
    : null
  return {
    code: ORG_VERIFICATION_REJECTED,
    message: reason
      ? `Your business verification was not approved (${ORG_REJECTION_LABEL[reason]}). ${ORG_REJECTION_FIX[reason]} Contact support to resubmit your documents.`
      : "Your business verification was not approved. Contact support to resubmit your documents.",
    rejectionReason: reason,
  }
}

// ── Acting as an organisation ────────────────────────────────────────────────

export type OrgMemberRole = "OWNER" | "STAFF"

/**
 * Who a request is acting AS, once the org context has been checked.
 *
 * `actingUserId` is the id every write should use as the author — it is the
 * org's backing row when acting as an org, and the person's own row otherwise.
 * `humanUserId` is always the real person, and it is what an audit trail,
 * a rate limit and a moderation report must use: "the org posted this" is not
 * an answer to "who posted this".
 */
export interface ActingIdentity {
  actingUserId: string
  humanUserId: string
  organization: {
    id: string
    name: string
    role: OrgMemberRole
    verified: boolean
    verificationStatus: OrgVerificationStatus
    rejectionReason: string | null
  } | null
}

export type ActingResult =
  | { ok: true; acting: ActingIdentity }
  /** The header named an org this person may not act as, or that is not there. */
  | { ok: false; reason: "not_a_member" | "membership_pending" | "unknown_org" }

/**
 * Resolve "who am I acting as" from a person's id and a requested org id.
 *
 * THE MEMBERSHIP IS RE-READ HERE, EVERY TIME, and that is the whole reason this
 * function exists rather than a claim on the token. See the header.
 *
 * A null or absent `requestedOrgId` is the ordinary case and costs no query:
 * the person acts as themselves.
 */
export async function resolveActingIdentity(
  db: Pick<PrismaClient, "organizationMember">,
  humanUserId: string,
  requestedOrgId: string | null | undefined,
): Promise<ActingResult> {
  if (!requestedOrgId) {
    return { ok: true, acting: { actingUserId: humanUserId, humanUserId, organization: null } }
  }

  const membership = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: requestedOrgId, userId: humanUserId } },
    select: {
      role: true,
      status: true,
      organization: {
        select: { id: true, name: true, orgUserId: true, verificationStatus: true, rejectionReason: true },
      },
    },
  })

  // Absent membership and absent organisation are ONE answer to the caller,
  // which then returns one status. Telling them apart would let anybody probe
  // for which organisation ids exist by watching the error change.
  if (!membership) return { ok: false, reason: "not_a_member" }
  if (membership.status !== "ACTIVE") return { ok: false, reason: "membership_pending" }

  const org = membership.organization
  return {
    ok: true,
    acting: {
      actingUserId: org.orgUserId,
      humanUserId,
      organization: {
        id: org.id,
        name: org.name,
        role: membership.role as OrgMemberRole,
        verified: org.verificationStatus === "VERIFIED",
        verificationStatus: org.verificationStatus as OrgVerificationStatus,
        rejectionReason: org.rejectionReason ?? null,
      },
    },
  }
}

/**
 * The organisations this person may act as right now, for the context switcher.
 *
 * ACTIVE only. A PENDING row is an invitation that has not been accepted, and
 * an invitation is not a permission — listing it here would put an org in the
 * switcher that every write path then refuses.
 */
export async function activeOrgsFor(
  db: Pick<PrismaClient, "organizationMember">,
  userId: string,
): Promise<{
  id: string
  /** The backing User row -- what GET /api/v1/profile/[id] takes, for "view my shop". */
  orgUserId: string
  name: string
  logoUrl: string | null
  role: OrgMemberRole
  verified: boolean
  verificationStatus: OrgVerificationStatus
  /**
   * Non-null when this org may not post: why, in the sentence to show. The
   * phone reads it to stop somebody before the post wizard rather than after.
   */
  postingRefusal: { code: OrgPostingRefusal["code"]; message: string } | null
}[]> {
  const rows = await db.organizationMember.findMany({
    where: { userId, status: "ACTIVE" },
    select: {
      role: true,
      organization: { select: { ...ORG_PUBLIC_SELECT, orgUserId: true, rejectionReason: true } },
    },
    orderBy: { joinedAt: "asc" },
  })
  return rows.map((r) => ({
    id: r.organization.id,
    orgUserId: r.organization.orgUserId,
    name: r.organization.name,
    logoUrl: r.organization.logoUrl,
    role: r.role as OrgMemberRole,
    verified: r.organization.verificationStatus === "VERIFIED",
    verificationStatus: r.organization.verificationStatus as OrgVerificationStatus,
    postingRefusal: (() => {
      const refusal = orgPostingRefusal(
        r.organization.verificationStatus as OrgVerificationStatus,
        r.organization.rejectionReason ?? null,
      )
      return refusal ? { code: refusal.code, message: refusal.message } : null
    })(),
  }))
}

/**
 * Has this person EVER done anything on Baylo as themselves, as opposed to as
 * one of their organisations?
 *
 * The Profile tab reads this, beside the membership list, to decide whether a
 * shop owner or staff member needs a personal profile at all. Somebody who has
 * only ever listed and traded for a shop gets the shop, and a separate
 * "personal profile" with an empty shelf would just confuse them.
 *
 * ── WHAT COUNTS ─────────────────────────────────────────────────────────────
 *
 * Any Item row they authored, in ANY status, and any TradeRequest or Offer they
 * sent or received as themselves. Rows the org made carry the org's backing id,
 * never the person's, so they do not count. Items are never hard-deleted
 * (withdrawal is a status), so one personal listing, even a withdrawn one,
 * keeps the personal profile reachable for good.
 *
 * ── WHAT DELIBERATELY DOES NOT COUNT ────────────────────────────────────────
 *
 *   TaskCompletion FIRST_LISTING  paid to the HUMAN even when they posted for
 *                                 the org (see POST /api/items), so it says
 *                                 nothing about personal activity.
 *   LeafTransaction rows          the signup grant and VERIFY_ACCOUNT land on
 *                                 every verified person with no activity.
 *   User.totalTrades              completed trades only; an open offer is
 *                                 activity too.
 *
 * Three existence probes (`findFirst` on an id, each served by the FK index)
 * rather than counts, because only yes or no is needed.
 */
export async function hasPersonalActivity(
  db: Pick<PrismaClient, "item" | "tradeRequest" | "offer">,
  userId: string,
): Promise<boolean> {
  const [item, trade, offer] = await Promise.all([
    db.item.findFirst({ where: { userId }, select: { id: true } }),
    db.tradeRequest.findFirst({
      where: { OR: [{ senderId: userId }, { receiverId: userId }] },
      select: { id: true },
    }),
    db.offer.findFirst({
      where: { OR: [{ senderId: userId }, { receiverId: userId }] },
      select: { id: true },
    }),
  ])
  return item !== null || trade !== null || offer !== null
}

/**
 * Refuse anyone who is not an OWNER of this organisation.
 *
 * Staff management and org settings are the two things only an owner may do.
 * Everything else an organisation can do — posting, trading, messaging — is
 * open to STAFF, which is what makes staff worth having.
 */
export async function isOrgOwner(
  db: Pick<PrismaClient, "organizationMember">,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const row = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { role: true, status: true },
  })
  return row?.status === "ACTIVE" && row.role === "OWNER"
}

// ── Creating one ─────────────────────────────────────────────────────────────

export interface CreateOrganizationInput {
  /** The person creating it. Becomes the first ACTIVE OWNER. */
  founderUserId: string
  name: string
  businessCategory: string
  logoUrl?: string | null
  /** The uploaded DTI/SEC/barangay permit. Destroyed when a decision is made. */
  businessDocUrl?: string | null
  businessDocPublicId?: string | null
  /** As typed. Stored and shown to the reviewer; never checked against DTI. */
  dtiRegistrationNumber?: string | null
}

/**
 * Create an organisation, its backing account and its first owner — in ONE
 * transaction, which is not negotiable.
 *
 * ── WHY ONE TRANSACTION ─────────────────────────────────────────────────────
 *
 * Three rows, and every pair of them is a bug on its own:
 *
 *   a User without an Organization     is a synthetic account that reads as a
 *                                      PERSON to every query in this codebase,
 *                                      right down to the trust-tier aggregates.
 *   an Organization without an owner   is an account nobody can ever act as,
 *                                      and nobody can ever be invited to.
 *   a member without either            is a dangling grant.
 *
 * `isOrgAccount` is set in the SAME statement that creates the backing row, so
 * the row is never observable as a person at any point — which is the argument
 * for it being a stored column and is recorded on the User model.
 *
 * ── THE BACKING ROW CANNOT LOG IN ───────────────────────────────────────────
 *
 * `password: null`, `isVerified: false`, and a synthesised email that no mailbox
 * answers. POST /api/auth/token refuses `isOrgAccount` rows outright, so none of
 * those is the only thing standing between an attacker and the account — but a
 * backing row with a settable password would be an account with no owner and no
 * recovery path, so it has none.
 *
 * `signupGrantClaimed: true` is deliberate and it is a LEDGER decision: the
 * signup grant is paid at email verification, an org has no mailbox to verify,
 * and an ungated grant on an account anybody can create is a Leaf faucet. The
 * org starts at zero and earns like everybody else.
 */
export async function createOrganization(
  input: CreateOrganizationInput,
): Promise<{ organizationId: string; orgUserId: string }> {
  return prisma.$transaction(async (tx) => {
    const orgUser = await tx.user.create({
      data: {
        name: input.name,
        // Unique, unroutable, and obviously synthetic to anybody reading the
        // table. The uniqueness is what matters — User.email is @unique and a
        // collision here would fail the whole transaction, which is correct.
        email: `org+${crypto.randomUUID()}@accounts.baylo.invalid`,
        password: null,
        isVerified: false,
        // See the note above. Not a convenience — a faucet guard.
        signupGrantClaimed: true,
        isOrgAccount: true,
        avatar: input.logoUrl ?? null,
      },
      select: { id: true },
    })

    const organization = await tx.organization.create({
      data: {
        orgUserId: orgUser.id,
        name: input.name,
        logoUrl: input.logoUrl ?? null,
        businessCategory: input.businessCategory as never,
        businessDocUrl: input.businessDocUrl ?? null,
        businessDocPublicId: input.businessDocPublicId ?? null,
        dtiRegistrationNumber: input.dtiRegistrationNumber ?? null,
        // PENDING by default. The org can trade while it waits, but it cannot
        // post until it is VERIFIED (see orgPostingRefusal).
        members: {
          create: {
            userId: input.founderUserId,
            role: "OWNER",
            status: "ACTIVE",
            joinedAt: new Date(),
          },
        },
      },
      select: { id: true },
    })

    return { organizationId: organization.id, orgUserId: orgUser.id }
  })
}

/**
 * Load the organisation behind a user id, if that row is one.
 *
 * Returns null for every human row, which is the common case and the reason
 * this is a single indexed lookup rather than something the callers join.
 */
export async function organizationForUser(
  db: Pick<PrismaClient, "organization">,
  orgUserId: string,
): Promise<OrgPublicRow | null> {
  return (await db.organization.findUnique({
    where: { orgUserId },
    select: ORG_PUBLIC_SELECT,
  })) as OrgPublicRow | null
}
