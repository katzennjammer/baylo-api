/**
 * Acceptance checks for organisations, perishables and category matching.
 *
 * Run: npx tsx --env-file=.env scripts/verify-orgs-and-perishables.ts
 *
 * ── IT WRITES, AND IT CLEANS UP AFTER ITSELF ────────────────────────────────
 *
 * Every row it creates carries the RUN_TAG below and is deleted in a finally
 * block, so a failed assertion does not leave an organisation behind. It
 * refuses to run against a database whose URL does not look local or scratch
 * unless BAYLO_ALLOW_LIVE=1 — the same live-guard every writing script in this
 * repo carries, for the reason the bracket-trading scripts record.
 *
 * ── WHAT IT ASSERTS, AND WHY EACH ONE IS HERE ───────────────────────────────
 *
 *   1  the isOrgAccount biconditional. The column is stored rather than
 *      derived, and the argument for that is "it cannot drift". This is the
 *      check that makes it true rather than asserted.
 *   2  the Leaf invariant, across an org. SUM(User.leaves) ==
 *      SUM(LeafTransaction.amount) is the one thing the whole economy is
 *      checked against, and an org is a User row now.
 *   3  the perishable clamp. That a perishable cannot self-assign a bracket is
 *      the security property of this feature; it is worth a test that uses the
 *      real valuation model rather than a made-up suggestion.
 *   4  the matcher's empty-list behaviour. `[]` must mean "no preference", not
 *      "wants everything" — the difference between a matcher and a broadcast.
 *   5  the matcher's direction and self-exclusion.
 *   6  expiry, including that it is replayable and leaves IN_TRADE alone.
 */

import prisma from "../src/lib/prisma"
import { createOrganization, notAnOrgWhere, resolveActingIdentity } from "../src/lib/organizations"
import { decidePerishableValue, expirePerishableItems } from "../src/lib/perishable"
import { decideItemValue } from "../src/lib/valuation-server"
import { findCategoryMatches } from "../src/lib/category-match"
import { valueCap } from "../src/lib/trade-rules"
import { bracketOf } from "../src/lib/brackets"

const RUN_TAG = `verify-orgs-${Date.now()}`

let failures = 0
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

function guardLive() {
  const url = process.env.DATABASE_URL ?? ""
  const looksLive = !/localhost|127\.0\.0\.1|scratch/i.test(url)
  if (looksLive && process.env.BAYLO_ALLOW_LIVE !== "1") {
    console.error(
      "Refusing to write to what looks like a live database.\n" +
        "Set BAYLO_ALLOW_LIVE=1 to override, or point DATABASE_URL at a scratch schema.",
    )
    process.exit(2)
  }
  if (looksLive) console.log("!! running against a non-local database (BAYLO_ALLOW_LIVE=1)\n")
}

async function main() {
  guardLive()

  const created = { users: [] as string[], orgs: [] as string[], items: [] as string[] }

  try {
    // ── Fixtures ────────────────────────────────────────────────────────────
    const founder = await prisma.user.create({
      data: { name: `${RUN_TAG}-founder`, email: `${RUN_TAG}-founder@test.invalid`, isVerified: true },
      select: { id: true },
    })
    created.users.push(founder.id)

    const outsider = await prisma.user.create({
      data: { name: `${RUN_TAG}-outsider`, email: `${RUN_TAG}-outsider@test.invalid`, isVerified: true },
      select: { id: true },
    })
    created.users.push(outsider.id)

    // ── 1 ── organisations ──────────────────────────────────────────────────
    console.log("\norganisations")

    const org = await createOrganization({
      founderUserId: founder.id,
      name: `${RUN_TAG} Sari-Sari`,
      businessCategory: "SARI_SARI",
    })
    created.orgs.push(org.organizationId)
    created.users.push(org.orgUserId)

    const orgUser = await prisma.user.findUniqueOrThrow({
      where: { id: org.orgUserId },
      select: { isOrgAccount: true, password: true, signupGrantClaimed: true, leaves: true },
    })
    check("backing row is flagged isOrgAccount", orgUser.isOrgAccount)
    check("backing row cannot log in (no password)", orgUser.password === null)
    check("backing row claims no signup grant", orgUser.signupGrantClaimed === true)
    check("backing row starts at zero Leaves", orgUser.leaves === 0)

    const founderMembership = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: org.organizationId, userId: founder.id } },
      select: { role: true, status: true, joinedAt: true },
    })
    check("founder is an ACTIVE OWNER", founderMembership?.role === "OWNER" && founderMembership.status === "ACTIVE")
    check("joinedAt stamped with ACTIVE", founderMembership?.joinedAt != null)

    // The biconditional. THE reason isOrgAccount is allowed to be a stored
    // column rather than a join — see the note on the User model.
    const flaggedNotOrgs = await prisma.user.count({
      where: { isOrgAccount: true, organization: { is: null } },
    })
    const orgsNotFlagged = await prisma.organization.count({
      where: { orgUser: { isOrgAccount: false } },
    })
    check("every isOrgAccount row has an Organization", flaggedNotOrgs === 0, `${flaggedNotOrgs} stray`)
    check("every Organization's row is flagged", orgsNotFlagged === 0, `${orgsNotFlagged} unflagged`)

    // notAnOrgWhere() must actually exclude it.
    const peopleIncludingOrg = await prisma.user.count({ where: { id: org.orgUserId } })
    const peopleExcludingOrg = await prisma.user.count({
      where: { id: org.orgUserId, ...notAnOrgWhere() },
    })
    check("notAnOrgWhere() excludes the org", peopleIncludingOrg === 1 && peopleExcludingOrg === 0)

    // ── 2 ── acting as ──────────────────────────────────────────────────────
    console.log("\nacting as an organisation")

    const asOrg = await resolveActingIdentity(prisma, founder.id, org.organizationId)
    check(
      "owner acts as the org's backing row",
      asOrg.ok && asOrg.acting.actingUserId === org.orgUserId && asOrg.acting.humanUserId === founder.id,
    )

    const asSelf = await resolveActingIdentity(prisma, founder.id, null)
    check("no header means act as yourself", asSelf.ok && asSelf.acting.actingUserId === founder.id)

    const stranger = await resolveActingIdentity(prisma, outsider.id, org.organizationId)
    check("a non-member is refused", !stranger.ok && stranger.reason === "not_a_member")

    // A PENDING invitation is not a permission.
    await prisma.organizationMember.create({
      data: { organizationId: org.organizationId, userId: outsider.id, role: "STAFF", status: "PENDING" },
    })
    const invited = await resolveActingIdentity(prisma, outsider.id, org.organizationId)
    check("a PENDING invitation is refused", !invited.ok && invited.reason === "membership_pending")

    await prisma.organizationMember.update({
      where: { organizationId_userId: { organizationId: org.organizationId, userId: outsider.id } },
      data: { status: "ACTIVE", joinedAt: new Date() },
    })
    const staff = await resolveActingIdentity(prisma, outsider.id, org.organizationId)
    check("an ACTIVE staff member may act", staff.ok && staff.acting.actingUserId === org.orgUserId)

    // ── 3 ── the perishable clamp ───────────────────────────────────────────
    console.log("\nperishable valuation")

    // Real model, real suggestion — not a made-up number.
    const probe = await decideItemValue("FOOD", "NEW", null)
    const cap = valueCap(probe.data.suggestedLeaves)
    const ceiling = cap.maxValueWithoutReview

    if (ceiling == null) {
      console.log("  skip  FOOD/NEW suggests into the open-ended top bracket; clamp is unreachable")
    } else {
      const outrageous = ceiling * 50
      const valued = await decideItemValue("FOOD", "NEW", outrageous)
      check("an outrageous value would need review", valued.needsReview, `decision=${valued.decision}`)

      const clamped = decidePerishableValue(valued)
      check("perishable clamps rather than queues", clamped.clamped)
      check(
        "clamped value is exactly the cap",
        clamped.data.valueLeaves === ceiling,
        `got ${clamped.data.valueLeaves}, cap ${ceiling}`,
      )
      check(
        "clamped bracket is within the unreviewed cap",
        bracketOf(clamped.data.valueLeaves) <= cap.maxBracketWithoutReview,
      )
      check("the clamp is recorded as user-set", clamped.data.valueSetByUser)
      check("the owner is told", (clamped.notice ?? "").includes(ceiling.toLocaleString("en-US")))

      // The property that matters: no perishable can outrun the cap.
      const within = await decideItemValue("FOOD", "NEW", Math.floor(ceiling / 2))
      const untouched = decidePerishableValue(within)
      check("a value within the cap is untouched", !untouched.clamped && untouched.data.valueLeaves === Math.floor(ceiling / 2))
    }

    // ── 4 & 5 ── the matcher ────────────────────────────────────────────────
    console.log("\ncategory matching")

    // outsider wants FOOD and owns a PLANTS listing.
    const theirs = await prisma.item.create({
      data: {
        title: `${RUN_TAG} outsider plants`,
        description: "x",
        images: "[]",
        category: "PLANTS",
        condition: "GOOD",
        status: "AVAILABLE",
        userId: outsider.id,
        lookingForCategories: ["FOOD"],
      },
      select: { id: true },
    })
    created.items.push(theirs.id)

    // A listing with NO stated preference. Must never match.
    const silent = await prisma.item.create({
      data: {
        title: `${RUN_TAG} silent`,
        description: "x",
        images: "[]",
        category: "BOOKS",
        condition: "GOOD",
        status: "AVAILABLE",
        userId: outsider.id,
        lookingForCategories: [],
      },
      select: { id: true },
    })
    created.items.push(silent.id)

    const mine = await prisma.item.create({
      data: {
        title: `${RUN_TAG} founder food`,
        description: "x",
        images: "[]",
        category: "FOOD",
        condition: "NEW",
        status: "AVAILABLE",
        userId: founder.id,
        lookingForCategories: ["PLANTS"],
      },
      select: { id: true },
    })
    created.items.push(mine.id)

    const matches = await findCategoryMatches(prisma, {
      itemId: mine.id,
      authorUserId: founder.id,
      category: "FOOD",
      lookingForCategories: ["PLANTS"],
    })
    const hit = matches.find((m) => m.ownerId === outsider.id)
    check("a stated want is matched", hit != null)
    check("the mutual overlap is detected", hit?.mutual === true, `mutual=${hit?.mutual}`)
    check(
      "an empty lookingForCategories never matches",
      !matches.some((m) => m.itemId === silent.id),
    )
    check("the author's own items are excluded", !matches.some((m) => m.ownerId === founder.id))
    check("one row per owner", new Set(matches.map((m) => m.ownerId)).size === matches.length)

    // ── 6 ── expiry ─────────────────────────────────────────────────────────
    console.log("\nperishable expiry")

    const past = new Date(Date.now() - 48 * 60 * 60 * 1000)
    const stale = await prisma.item.create({
      data: {
        title: `${RUN_TAG} stale fish`,
        description: "x",
        images: "[]",
        category: "FOOD",
        condition: "NEW",
        status: "AVAILABLE",
        userId: founder.id,
        isPerishable: true,
        quantity: 2,
        quantityUnit: "KG",
        tradeWithinHours: 6,
        createdAt: past,
      },
      select: { id: true },
    })
    created.items.push(stale.id)

    const fresh = await prisma.item.create({
      data: {
        title: `${RUN_TAG} fresh fish`,
        description: "x",
        images: "[]",
        category: "FOOD",
        condition: "NEW",
        status: "AVAILABLE",
        userId: founder.id,
        isPerishable: true,
        tradeWithinHours: 24,
      },
      select: { id: true },
    })
    created.items.push(fresh.id)

    // In somebody's trade. Its window has stopped mattering.
    const locked = await prisma.item.create({
      data: {
        title: `${RUN_TAG} locked fish`,
        description: "x",
        images: "[]",
        category: "FOOD",
        condition: "NEW",
        status: "IN_TRADE",
        userId: founder.id,
        isPerishable: true,
        tradeWithinHours: 6,
        createdAt: past,
      },
      select: { id: true },
    })
    created.items.push(locked.id)

    const movedFirst = await expirePerishableItems(prisma, { userId: founder.id })
    check("the stale perishable expired", movedFirst >= 1, `moved ${movedFirst}`)

    const after = await prisma.item.findMany({
      where: { id: { in: [stale.id, fresh.id, locked.id, mine.id] } },
      select: { id: true, status: true },
    })
    const statusOf = (id: string) => after.find((r) => r.id === id)?.status
    check("stale is EXPIRED", statusOf(stale.id) === "EXPIRED", String(statusOf(stale.id)))
    check("fresh is still AVAILABLE", statusOf(fresh.id) === "AVAILABLE", String(statusOf(fresh.id)))
    check("IN_TRADE is left alone", statusOf(locked.id) === "IN_TRADE", String(statusOf(locked.id)))
    check("a standard listing is untouched", statusOf(mine.id) === "AVAILABLE", String(statusOf(mine.id)))

    const movedAgain = await expirePerishableItems(prisma, { userId: founder.id })
    check("the sweep is replayable (second run is a no-op)", movedAgain === 0, `moved ${movedAgain}`)

    // An EXPIRED listing must leave the matcher too.
    const afterExpiry = await findCategoryMatches(prisma, {
      itemId: theirs.id,
      authorUserId: outsider.id,
      category: "PLANTS",
      lookingForCategories: ["FOOD"],
    })
    check(
      "an EXPIRED listing is not matched",
      !afterExpiry.some((m) => m.itemId === stale.id),
    )

    // ── 7 ── the Leaf invariant, with an org in the table ───────────────────
    console.log("\nledger invariant")

    const [balances, ledger] = await Promise.all([
      prisma.user.aggregate({ _sum: { leaves: true } }),
      prisma.leafTransaction.aggregate({ _sum: { amount: true } }),
    ])
    const sumBalances = balances._sum.leaves ?? 0
    const sumLedger = ledger._sum.amount ?? 0
    check(
      "SUM(User.leaves) == SUM(LeafTransaction.amount)",
      sumBalances === sumLedger,
      `balances ${sumBalances} vs ledger ${sumLedger}`,
    )
  } finally {
    // Order matters: items and memberships cascade from their owners, but the
    // organisation's backing row is a user too, so orgs go before users.
    await prisma.item.deleteMany({ where: { id: { in: created.items } } })
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
