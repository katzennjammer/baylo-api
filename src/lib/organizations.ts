import type { PrismaClient } from "@/generated/prisma/client"
import prisma from "@/lib/prisma"

/**
 * Organisations / SMMEs: who they are, who may act as them, and what a badge
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
 * `verified` is derived here and nowhere else, so that "Verified org" cannot
 * come to mean "an Organization row exists". A PENDING org is a real account
 * that can post and trade — it simply has no checkmark yet, and a client that
 * renders one off the mere presence of this object would be claiming a review
 * that has not happened.
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
  organization: { id: string; name: string; role: OrgMemberRole; verified: boolean } | null
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
      organization: { select: { id: true, name: true, orgUserId: true, verificationStatus: true } },
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
): Promise<{ id: string; name: string; logoUrl: string | null; role: OrgMemberRole; verified: boolean }[]> {
  const rows = await db.organizationMember.findMany({
    where: { userId, status: "ACTIVE" },
    select: {
      role: true,
      organization: { select: ORG_PUBLIC_SELECT },
    },
    orderBy: { joinedAt: "asc" },
  })
  return rows.map((r) => ({
    id: r.organization.id,
    name: r.organization.name,
    logoUrl: r.organization.logoUrl,
    role: r.role as OrgMemberRole,
    verified: r.organization.verificationStatus === "VERIFIED",
  }))
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
        // PENDING by default. The org can post and trade while it waits; what
        // it does not have yet is the checkmark.
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
