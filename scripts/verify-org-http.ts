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
 * whether a staff member's listing really lands on the org's id, and whether
 * the ID gate still fires for somebody acting as a verified organisation. Those
 * are the parts most likely to be wrong and the only way to test them is to
 * make the requests.
 *
 * The document upload is NOT exercised here: it needs Cloudinary credentials
 * and posting a real image, and a failure there is a credentials problem rather
 * than a logic one. Organisations are created through the library for that
 * reason, and everything after creation goes over the wire.
 */

import prisma from "../src/lib/prisma"
import { createOrganization } from "../src/lib/organizations"
import { signAccessToken } from "../src/lib/auth-tokens"

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
        // The ID gate fires before the org context is read, so both actors need
        // to be past it or every POST /api/items here is a 403 about IDs.
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
    check("it is not verified yet", (puser?.org as { verified?: boolean })?.verified === false)
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
