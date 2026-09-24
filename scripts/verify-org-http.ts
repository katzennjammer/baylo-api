/**
 * The organisation endpoints, over real HTTP.
 *
 * Run (with `npm run dev` up):
 *   npx tsx --env-file=.env scripts/verify-org-http.ts
 *
 * ── WHY OVER HTTP AND NOT THROUGH THE LIBS ──────────────────────────────────
 *
 * verify-orgs-and-perishables.ts already exercises the libraries directly, and
 * it passes. What it cannot see is everything BETWEEN the client and them: the
 * X-Baylo-Org header actually being read, the 403 a revoked membership produces,
 * whether a staff member's listing really lands on the org's id, and which
 * gate applies: the person's own ID when posting as themselves, the org's
 * review ALONE when posting for a verified org, and a flat refusal when
 * posting for a PENDING or REJECTED one (24 Sep 2026). Those are the parts most likely to be wrong and the only way
 * to test them is to make the requests.
 *
 * The document upload is NOT exercised here: it needs Cloudinary credentials
 * and posting a real image, and a failure there is a credentials problem rather
 * than a logic one. Organisations are created through the library for that
 * reason, and everything after creation goes over the wire.
 */

import prisma from "../src/lib/prisma"
import { createOrganization, orgPostingRefusal } from "../src/lib/organizations"
import { signAccessToken } from "../src/lib/auth-tokens"
import { ORG_WELCOME_LEAVES } from "../src/lib/task-constants"

const BASE = process.env.BAYLO_BASE_URL ?? "http://localhost:3000"

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  ok    ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

interface Called {
  status: number
  body: Record<string, unknown>
}

/**
 * Who a created listing belongs to.
 *
 * POST /api/items is a LEGACY route and answers shapeItem()'s shape, which
 * spreads the row -- so the author is `userId`, with a nested `user` block.
 * It is NOT the v1 `owner` shape; asserting that name here passed the request
 * and failed the check, which is the sort of test bug that looks like a
 * product bug. `userId` is the column the attribution actually lives in, so it
 * is the thing worth asserting on.
 */
function authorOf(body: Record<string, unknown>): string | undefined {
  const direct = body.userId
  if (typeof direct === "string") return direct
  return (body.user as { id?: string } | undefined)?.id
}

async function call(
  path: string,
  opts: { token: string; orgId?: string | null; method?: string; body?: unknown } ,
): Promise<Called> {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
      ...(opts.orgId ? { "X-Baylo-Org": opts.orgId } : {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, body }
}

async function main() {
  // Fail fast and clearly rather than 35 confusing connection errors.
  try {
    await fetch(`${BASE}/api/v1/hubs`, { method: "GET" })
  } catch {
    console.error(`No server at ${BASE}. Start it with \`npm run dev\` first.`)
    process.exit(2)
  }

  const tag = `verify-org-http-${Date.now()}`
  const created = { users: [] as string[], orgs: [] as string[], items: [] as string[] }

  try {
    const owner = await prisma.user.create({
      data: {
        name: `${tag}-owner`,
        email: `${tag}-owner@test.invalid`,
        isVerified: true,
        // Past the personal ID gate, so posting as themselves works. Posting
        // for an org never consults it; the ID-less path is its own section
        // further down.
        idVerifiedGrandfatheredAt: new Date(),
      },
      select: { id: true },
    })
    created.users.push(owner.id)

    const staff = await prisma.user.create({
      data: {
        name: `${tag}-staff`,
        email: `${tag}-staff@test.invalid`,
        isVerified: true,
        idVerifiedGrandfatheredAt: new Date(),
      },
      select: { id: true },
    })
    created.users.push(staff.id)

    const outsider = await prisma.user.create({
      data: {
        name: `${tag}-outsider`,
        email: `${tag}-outsider@test.invalid`,
        isVerified: true,
        idVerifiedGrandfatheredAt: new Date(),
      },
      select: { id: true },
    })
    created.users.push(outsider.id)

    const org = await createOrganization({
      founderUserId: owner.id,
      name: `${tag} Store`,
      businessCategory: "SARI_SARI",
    })
    created.orgs.push(org.organizationId)
    created.users.push(org.orgUserId)
    // VERIFIED straight away, by hand. Only a verified org may post as itself,
    // and the header, invitation and revocation sections below are about the
    // context, not the review. The review itself, and the welcome grant it
    // pays, go through the real admin endpoint in the posting-gate section.
    await prisma.organization.update({
      where: { id: org.organizationId },
      data: { verificationStatus: "VERIFIED" },
    })

    const ownerToken = await signAccessToken(owner.id)
    const staffToken = await signAccessToken(staff.id)
    const outsiderToken = await signAccessToken(outsider.id)

    // ── the org context header ────────────────────────────────────────────
    console.log("\nthe X-Baylo-Org header")

    const listing = {
      title: `${tag} rice`,
      description: "x",
      category: "FOOD",
      condition: "NEW",
      images: [],
      lookingForCategories: ["PLANTS"],
    }

    const asSelf = await call("/api/items", { token: ownerToken, method: "POST", body: listing })
    check("posting with no header succeeds", asSelf.status === 201, `status ${asSelf.status}`)
    if (asSelf.status === 201) {
      created.items.push(String(asSelf.body.id))
      check(
        "it is attributed to the person",
        authorOf(asSelf.body) === owner.id,
        `author ${authorOf(asSelf.body)}`,
      )
      check("postedAs is null", asSelf.body.postedAs === null)
    }

    const asOrg = await call("/api/items", {
      token: ownerToken,
      orgId: org.organizationId,
      method: "POST",
      body: { ...listing, title: `${tag} org rice` },
    })
    check("posting with the header succeeds", asOrg.status === 201, `status ${asOrg.status}`)
    if (asOrg.status === 201) {
      created.items.push(String(asOrg.body.id))
      check(
        "IT IS ATTRIBUTED TO THE ORG, not the person",
        authorOf(asOrg.body) === org.orgUserId,
        `author ${authorOf(asOrg.body)}, expected ${org.orgUserId}`,
      )
      check(
        "postedAs names the organisation",
        (asOrg.body.postedAs as { organizationId?: string } | null)?.organizationId ===
          org.organizationId,
      )
    }

    const asStranger = await call("/api/items", {
      token: outsiderToken,
      orgId: org.organizationId,
      method: "POST",
      body: { ...listing, title: `${tag} stolen` },
    })
    check(
      "a non-member is refused with 403",
      asStranger.status === 403,
      `status ${asStranger.status}`,
    )
    check("and the refusal is branchable", asStranger.body.code === "ORG_CONTEXT_REFUSED")

    // ── an invitation is not a permission ─────────────────────────────────
    console.log("\ninvitations")

    const invited = await call(`/api/v1/organizations/${org.organizationId}/members`, {
      token: ownerToken,
      method: "POST",
      body: { email: `${tag}-staff@test.invalid` },
    })
    check("an owner can invite", invited.status === 200, `status ${invited.status}`)
    const membershipId = (invited.body as { data?: { membershipId?: string } }).data?.membershipId

    const staffTooEarly = await call("/api/items", {
      token: staffToken,
      orgId: org.organizationId,
      method: "POST",
      body: { ...listing, title: `${tag} premature` },
    })
    check(
      "a PENDING invitee cannot post as the org",
      staffTooEarly.status === 403,
      `status ${staffTooEarly.status}`,
    )

    const staffInvite = await call(
      `/api/v1/organizations/${org.organizationId}/members/${membershipId}`,
      { token: staffToken, method: "PATCH", body: { action: "accept" } },
    )
    check("the invitee can accept", staffInvite.status === 200, `status ${staffInvite.status}`)

    const staffPost = await call("/api/items", {
      token: staffToken,
      orgId: org.organizationId,
      method: "POST",
      body: { ...listing, title: `${tag} staff rice` },
    })
    check("ACTIVE staff can post as the org", staffPost.status === 201, `status ${staffPost.status}`)
    if (staffPost.status === 201) {
      created.items.push(String(staffPost.body.id))
      check(
        "the staff member's listing belongs to the org",
        authorOf(staffPost.body) === org.orgUserId,
        `author ${authorOf(staffPost.body)}, expected ${org.orgUserId}`,
      )
    }

    // THE REVOCATION TEST. This is the whole argument for the header being
    // re-read per request instead of minted into the token.
    const staffMembership = await prisma.organizationMember.findFirst({
      where: { organizationId: org.organizationId, userId: staff.id },
      select: { id: true },
    })
    await call(
      `/api/v1/organizations/${org.organizationId}/members/${staffMembership!.id}`,
      { token: ownerToken, method: "DELETE" },
    )
    const afterRemoval = await call("/api/items", {
      // THE SAME TOKEN as the successful post above. Nothing was re-issued.
      token: staffToken,
      orgId: org.organizationId,
      method: "POST",
      body: { ...listing, title: `${tag} revoked` },
    })
    check(
      "REVOKED STAFF ARE REFUSED ON THE SAME TOKEN",
      afterRemoval.status === 403,
      `status ${afterRemoval.status}`,
    )

    // ── owner-only staff management ───────────────────────────────────────
    console.log("\nowner-only actions")

    const strangerInvite = await call(`/api/v1/organizations/${org.organizationId}/members`, {
      token: outsiderToken,
      method: "POST",
      body: { email: `${tag}-staff@test.invalid` },
    })
    check(
      "a non-member cannot invite",
      strangerInvite.status === 403,
      `status ${strangerInvite.status}`,
    )

    const strangerRoster = await call(`/api/v1/organizations/${org.organizationId}/members`, {
      token: outsiderToken,
    })
    check(
      "a non-member cannot read the roster (404, not 403)",
      strangerRoster.status === 404,
      `status ${strangerRoster.status}`,
    )

    const ownerMembership = await prisma.organizationMember.findFirst({
      where: { organizationId: org.organizationId, userId: owner.id },
      select: { id: true },
    })
    const lastOwner = await call(
      `/api/v1/organizations/${org.organizationId}/members/${ownerMembership!.id}`,
      { token: ownerToken, method: "PATCH", body: { role: "STAFF" } },
    )
    check(
      "the last owner cannot demote themselves",
      lastOwner.status === 409,
      `status ${lastOwner.status}`,
    )

    // ── the profile and the badge ─────────────────────────────────────────
    console.log("\nthe org profile")

    const profile = await call(`/api/v1/profile/${org.orgUserId}`, { token: outsiderToken })
    check("an org profile loads", profile.status === 200, `status ${profile.status}`)
    const pdata = (profile.body as { data?: Record<string, unknown> }).data
    const puser = pdata?.user as Record<string, unknown> | undefined
    const pcounts = pdata?.counts as Record<string, unknown> | undefined
    check("it carries the org block", puser?.org != null)
    check(
      "trustTier is null on it",
      puser?.trustTier === null,
      `got ${JSON.stringify(puser?.trustTier)}`,
    )
    check("it carries the verified badge", (puser?.org as { verified?: boolean })?.verified === true)
    check("the staff count is present", typeof pcounts?.staff === "number", String(pcounts?.staff))

    // ── the Organizations filter ──────────────────────────────────────────
    console.log("\nthe Organizations filter")

    const all = await call("/api/v1/browse?limit=50", { token: outsiderToken })
    const orgsOnly = await call("/api/v1/browse?limit=50&orgsOnly=true", { token: outsiderToken })
    check("browse works unfiltered", all.status === 200, `status ${all.status}`)
    check("browse works filtered", orgsOnly.status === 200, `status ${orgsOnly.status}`)

    const orgItems = ((orgsOnly.body as { data?: { items?: { owner: { id: string } }[] } }).data
      ?.items ?? []) as { owner: { id: string; org: unknown } }[]
    check(
      "every result is posted by an organisation",
      orgItems.length > 0 && orgItems.every((i) => i.owner.org != null),
      `${orgItems.length} results`,
    )
    check(
      "the org's own listings are among them",
      orgItems.some((i) => i.owner.id === org.orgUserId),
    )

    // ── the posting gate, and the verified-MSME welcome grant ──────────────
    console.log("\nthe posting gate and the welcome grant")

    // A staff member with NO personal ID verification at all, and an admin to
    // approve the org.
    const idless = await prisma.user.create({
      data: { name: `${tag}-idless`, email: `${tag}-idless@test.invalid`, isVerified: true },
      select: { id: true },
    })
    created.users.push(idless.id)
    const admin = await prisma.user.create({
      data: { name: `${tag}-admin`, email: `${tag}-admin@test.invalid`, isVerified: true, role: "ADMIN" },
      select: { id: true },
    })
    created.users.push(admin.id)
    const idlessToken = await signAccessToken(idless.id)
    const adminToken = await signAccessToken(admin.id)

    // Two fresh orgs with the same owner: one to stay PENDING until the admin
    // approves it, one the admin rejects.
    const reviewOrg = await createOrganization({
      founderUserId: owner.id,
      name: `${tag} Review Store`,
      businessCategory: "SARI_SARI",
    })
    created.orgs.push(reviewOrg.organizationId)
    created.users.push(reviewOrg.orgUserId)
    const rejectedOrg = await createOrganization({
      founderUserId: owner.id,
      name: `${tag} Rejected Store`,
      businessCategory: "SARI_SARI",
    })
    created.orgs.push(rejectedOrg.organizationId)
    created.users.push(rejectedOrg.orgUserId)

    await prisma.organizationMember.create({
      data: {
        organizationId: reviewOrg.organizationId,
        userId: idless.id,
        role: "STAFF",
        status: "ACTIVE",
        joinedAt: new Date(),
      },
    })

    const personalFlag = (c: Called) =>
      (c.body as { data?: { hasPersonalActivity?: boolean } }).data?.hasPersonalActivity

    const meBefore = await call("/api/v1/profile/me", { token: idlessToken })
    check(
      "a member with no activity reports hasPersonalActivity = false",
      personalFlag(meBefore) === false,
      `status ${meBefore.status}, got ${JSON.stringify(personalFlag(meBefore))}`,
    )
    const ownerMe = await call("/api/v1/profile/me", { token: ownerToken })
    check(
      "the owner, who posted as themselves above, reports hasPersonalActivity = true",
      personalFlag(ownerMe) === true,
      `got ${JSON.stringify(personalFlag(ownerMe))}`,
    )

    // ── PENDING: refused, whatever the poster's own ID says ──
    const pendingMessage = orgPostingRefusal("PENDING", null)!.message
    const pendingIdless = await call("/api/items", {
      token: idlessToken,
      orgId: reviewOrg.organizationId,
      method: "POST",
      body: { ...listing, title: `${tag} pending-org idless` },
    })
    check(
      "PENDING org: ID-less staff are refused with ORG_VERIFICATION_PENDING",
      pendingIdless.status === 403 && pendingIdless.body.code === "ORG_VERIFICATION_PENDING",
      `status ${pendingIdless.status} code ${String(pendingIdless.body.code)}`,
    )
    const pendingVerifiedPerson = await call("/api/items", {
      token: ownerToken,
      orgId: reviewOrg.organizationId,
      method: "POST",
      body: { ...listing, title: `${tag} pending-org owner` },
    })
    check(
      "PENDING org: an owner WITH a verified personal ID is refused too (no fallback)",
      pendingVerifiedPerson.status === 403 &&
        pendingVerifiedPerson.body.code === "ORG_VERIFICATION_PENDING",
      `status ${pendingVerifiedPerson.status} code ${String(pendingVerifiedPerson.body.code)}`,
    )
    check(
      "PENDING org: the refusal carries the under-review sentence",
      pendingVerifiedPerson.body.error === pendingMessage,
      String(pendingVerifiedPerson.body.error),
    )
    const pendingAsSelf = await call("/api/items", {
      token: ownerToken,
      method: "POST",
      body: { ...listing, title: `${tag} pending-org owner as self` },
    })
    check(
      "PENDING org: the same owner can still post AS THEMSELVES",
      pendingAsSelf.status === 201,
      `status ${pendingAsSelf.status}`,
    )
    if (pendingAsSelf.status === 201) created.items.push(String(pendingAsSelf.body.id))

    const ownerOrgs = await call("/api/v1/organizations", { token: ownerToken })
    const listedOrgs = ((ownerOrgs.body as { data?: { organizations?: unknown[] } }).data
      ?.organizations ?? []) as { id: string; postingRefusal: { code: string; message: string } | null }[]
    check(
      "the org list tells the phone up front: the PENDING org carries its refusal",
      listedOrgs.find((o) => o.id === reviewOrg.organizationId)?.postingRefusal?.message === pendingMessage,
      JSON.stringify(listedOrgs.find((o) => o.id === reviewOrg.organizationId)?.postingRefusal),
    )
    check(
      "and the VERIFIED org carries none",
      listedOrgs.find((o) => o.id === org.organizationId)?.postingRefusal === null,
    )

    // ── REJECTED: refused, and told why ──
    const reject = await call(`/api/admin/organizations/${rejectedOrg.organizationId}`, {
      token: adminToken,
      method: "POST",
      body: { decision: "reject", reason: `${tag} rejected`, rejectionReason: "BLURRY_DOCUMENT" },
    })
    check("an admin can reject an org", reject.status === 200, `status ${reject.status}`)
    const rejectedMessage = orgPostingRefusal("REJECTED", "BLURRY_DOCUMENT")!.message
    const rejectedVerifiedPerson = await call("/api/items", {
      token: ownerToken,
      orgId: rejectedOrg.organizationId,
      method: "POST",
      body: { ...listing, title: `${tag} rejected-org owner` },
    })
    check(
      "REJECTED org: an owner WITH a verified personal ID is refused with ORG_VERIFICATION_REJECTED",
      rejectedVerifiedPerson.status === 403 &&
        rejectedVerifiedPerson.body.code === "ORG_VERIFICATION_REJECTED",
      `status ${rejectedVerifiedPerson.status} code ${String(rejectedVerifiedPerson.body.code)}`,
    )
    check(
      "REJECTED org: the refusal names the stored reason and what to do",
      rejectedVerifiedPerson.body.error === rejectedMessage &&
        (rejectedVerifiedPerson.body.organization as { rejectionReason?: string } | undefined)
          ?.rejectionReason === "BLURRY_DOCUMENT",
      String(rejectedVerifiedPerson.body.error),
    )
    await prisma.organizationMember.create({
      data: {
        organizationId: rejectedOrg.organizationId,
        userId: idless.id,
        role: "STAFF",
        status: "ACTIVE",
        joinedAt: new Date(),
      },
    })
    const rejectedIdless = await call("/api/items", {
      token: idlessToken,
      orgId: rejectedOrg.organizationId,
      method: "POST",
      body: { ...listing, title: `${tag} rejected-org idless` },
    })
    check(
      "REJECTED org: ID-less staff are refused the same way",
      rejectedIdless.status === 403 && rejectedIdless.body.code === "ORG_VERIFICATION_REJECTED",
      `status ${rejectedIdless.status} code ${String(rejectedIdless.body.code)}`,
    )
    const rejectedGrant = await prisma.leafTransaction.count({
      where: { userId: rejectedOrg.orgUserId, type: "SIGNUP_GRANT" },
    })
    check("a rejection pays no welcome grant", rejectedGrant === 0, `count=${rejectedGrant}`)

    // ── Approval: the grant, and then ID-less staff may post ──
    const orgUserBefore = await prisma.user.findUniqueOrThrow({
      where: { id: reviewOrg.orgUserId },
      select: { leaves: true, lifetimeLeaves: true },
    })
    const approve = await call(`/api/admin/organizations/${reviewOrg.organizationId}`, {
      token: adminToken,
      method: "POST",
      body: { decision: "verify", reason: `${tag} approved` },
    })
    check("an admin can verify the org", approve.status === 200, `status ${approve.status} ${JSON.stringify(approve.body)}`)
    check(
      `the response reports ${ORG_WELCOME_LEAVES} welcome Leaves`,
      (approve.body as { data?: { welcomeLeaves?: number } }).data?.welcomeLeaves === ORG_WELCOME_LEAVES,
      JSON.stringify(approve.body),
    )
    const orgUserAfter = await prisma.user.findUniqueOrThrow({
      where: { id: reviewOrg.orgUserId },
      select: { leaves: true, lifetimeLeaves: true },
    })
    check(
      "THE ORG'S OWN BALANCE rose by the welcome grant",
      orgUserAfter.leaves - orgUserBefore.leaves === ORG_WELCOME_LEAVES &&
        orgUserAfter.lifetimeLeaves - orgUserBefore.lifetimeLeaves === ORG_WELCOME_LEAVES,
      `${orgUserBefore.leaves} -> ${orgUserAfter.leaves}`,
    )
    const grantRows = await prisma.leafTransaction.findMany({
      where: { userId: reviewOrg.orgUserId, type: "SIGNUP_GRANT" },
      select: { amount: true },
    })
    check(
      "exactly one SIGNUP_GRANT ledger row explains it",
      grantRows.length === 1 && grantRows[0].amount === ORG_WELCOME_LEAVES,
      JSON.stringify(grantRows),
    )
    const ownerLedger = await prisma.leafTransaction.count({
      where: { userId: owner.id, type: "SIGNUP_GRANT" },
    })
    check("the owner's own balance got nothing", ownerLedger === 0, `count=${ownerLedger}`)

    const again = await call(`/api/admin/organizations/${reviewOrg.organizationId}`, {
      token: adminToken,
      method: "POST",
      body: { decision: "verify", reason: `${tag} again` },
    })
    const grantRowsAfter = await prisma.leafTransaction.count({
      where: { userId: reviewOrg.orgUserId, type: "SIGNUP_GRANT" },
    })
    check(
      "a second approval is a conflict and pays nothing",
      again.status === 409 && grantRowsAfter === 1,
      `status ${again.status}, rows ${grantRowsAfter}`,
    )

    const verifiedOrgPost = await call("/api/items", {
      token: idlessToken,
      orgId: reviewOrg.organizationId,
      method: "POST",
      body: { ...listing, title: `${tag} verified-org idless` },
    })
    check(
      "ID-LESS STAFF CAN POST FOR A VERIFIED ORG",
      verifiedOrgPost.status === 201,
      `status ${verifiedOrgPost.status} ${JSON.stringify(verifiedOrgPost.body)}`,
    )
    if (verifiedOrgPost.status === 201) {
      created.items.push(String(verifiedOrgPost.body.id))
      check(
        "and the listing belongs to the org",
        authorOf(verifiedOrgPost.body) === reviewOrg.orgUserId,
        `author ${authorOf(verifiedOrgPost.body)}`,
      )
    }

    const idlessSelfPost = await call("/api/items", {
      token: idlessToken,
      method: "POST",
      body: { ...listing, title: `${tag} idless self` },
    })
    check(
      "but posting AS THEMSELVES still needs their own ID",
      idlessSelfPost.status === 403 && idlessSelfPost.body.code === "ID_VERIFICATION_REQUIRED",
      `status ${idlessSelfPost.status}`,
    )

    const meAfter = await call("/api/v1/profile/me", { token: idlessToken })
    check(
      "posting for the org does not count as personal activity",
      personalFlag(meAfter) === false,
      `got ${JSON.stringify(personalFlag(meAfter))}`,
    )

    // ── an organisation cannot log in ─────────────────────────────────────
    console.log("\nthe backing row")

    const orgUser = await prisma.user.findUniqueOrThrow({
      where: { id: org.orgUserId },
      select: { email: true },
    })
    const login = await fetch(`${BASE}/api/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: orgUser.email, password: "anything-at-all" }),
    })
    check("an org account cannot log in", login.status === 401, `status ${login.status}`)
  } finally {
    // The approval's audit rows. AdminAction.actor has no cascade, so the
    // admin row cannot be deleted while they exist.
    await prisma.adminAction.deleteMany({
      where: { OR: [{ actorId: { in: created.users } }, { targetId: { in: created.orgs } }] },
    })
    await prisma.item.deleteMany({ where: { id: { in: created.items } } })
    await prisma.item.deleteMany({ where: { userId: { in: created.users } } })
    await prisma.organization.deleteMany({ where: { id: { in: created.orgs } } })
    await prisma.user.deleteMany({ where: { id: { in: created.users } } })
    await prisma.$disconnect()
  }

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
