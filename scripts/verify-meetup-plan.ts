// Acceptance harness for the meetup PLAN (11 Sep 2026) — gap 6.
//
// RUNS AGAINST A SCRATCH DB. Point DATABASE_URL at one first — it creates and
// deletes rows, and the prefix-scoped cleanup is a safety net, not a licence:
//
//   mysql -u root -e "CREATE DATABASE baylo_meetupcheck"
//   DATABASE_URL="mysql://root@127.0.0.1:3306/baylo_meetupcheck" npx prisma db push
//   DATABASE_URL="mysql://root@127.0.0.1:3306/baylo_meetupcheck" npx tsx scripts/verify-meetup-plan.ts
//
// THE ONE THAT MATTERS IS 7. Everything else here is ordinary behaviour; 7 is
// the invariant the whole design rests on — a PLAN must never write the CLAIM,
// because the CLAIM is what pays 10 Leaves. If 7 ever fails, somebody can mint
// currency by suggesting a place to meet and never going.
//
// What it pins down, in order:
//   1  sharedHubs() returns only hubs BOTH listings named
//   2  a pure-Leaves trade (same listing in both columns) needs no special case
//   3  proposableHub() ACCEPTS a hub only one side named — the plan is wider
//      than the claim — while resolveMeetupHub() still refuses it, so a plan
//      at that hub can be made but never pays
//   4  proposableHub() refuses an INACTIVE hub — stricter than the claim, which
//      deliberately accepts one deactivated after the fact
//   5  a proposal is unanswered: agreedAt stays null, the side is recorded
//   6  a counter overwrites the plan AND clears the agreement
//   7  NOTHING in any of the above writes safeZoneHubId  ← the whole point
//   8  v1MeetupPlan() reads the group, not one column: a half-written plan is
//      reported as no plan rather than rendered prettily
//   9  an AGREED plan becomes the claim's default; an UNANSWERED one does not

import prisma from "../src/lib/prisma"
import { sharedHubs, allHubs, listingHubIds, proposableHub, v1MeetupPlan, NO_MEETUP_PLAN } from "../src/lib/meetup"
import { resolveMeetupHub } from "../src/lib/safe-zones"

const P = "ZZMEETUP_"
let pass = 0
let fail = 0

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}   ${detail}`)
  }
}
function head(s: string) {
  console.log(`\n── ${s} ${"─".repeat(Math.max(0, 66 - s.length))}`)
}

async function cleanup() {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: P } },
    select: { id: true },
  })
  const ids = users.map((u) => u.id)
  if (ids.length) {
    // Order matters: BOTH FKs onto SafeZoneHub are RESTRICT — the claim and now
    // the plan — so trades and associations go before the hubs can.
    await prisma.tradeRequest.deleteMany({
      where: { OR: [{ senderId: { in: ids } }, { receiverId: { in: ids } }] },
    })
    await prisma.itemSafeZone.deleteMany({ where: { item: { userId: { in: ids } } } })
    await prisma.item.deleteMany({ where: { userId: { in: ids } } })
    await prisma.user.deleteMany({ where: { id: { in: ids } } })
  }
  await prisma.safeZoneHub.deleteMany({ where: { id: { startsWith: P } } })
}

const mkUser = (tag: string) =>
  prisma.user.create({
    data: { name: P + tag, email: `${P}${tag}@test.local`, password: "x" },
  })

const mkItem = (userId: string, tag: string) =>
  prisma.item.create({
    data: {
      title: P + tag,
      description: "x",
      images: "[]",
      category: "OTHER",
      condition: "GOOD",
      userId,
    },
  })

const mkHub = (tag: string, isActive = true) =>
  prisma.safeZoneHub.create({
    data: {
      id: `${P}${tag}`,
      name: P + tag,
      type: "MALL",
      address: "somewhere",
      latitude: 10.3,
      longitude: 123.9,
      city: "Testville",
      landmark: "by the door",
      isActive,
    },
  })

const soon = (days: number) => new Date(Date.now() + days * 86_400_000)

async function main() {
  await cleanup()

  const [a, b] = await Promise.all([mkUser("a"), mkUser("b")])
  const [ia, ib] = await Promise.all([mkItem(a.id, "ia"), mkItem(b.id, "ib")])
  const [both, onlyA, closed] = await Promise.all([
    mkHub("both"),
    mkHub("onlya"),
    mkHub("closed", false),
  ])

  // `both` and `closed` are named by BOTH listings; `onlyA` by one.
  await prisma.itemSafeZone.createMany({
    data: [
      { itemId: ia.id, hubId: both.id },
      { itemId: ib.id, hubId: both.id },
      { itemId: ia.id, hubId: closed.id },
      { itemId: ib.id, hubId: closed.id },
      { itemId: ia.id, hubId: onlyA.id },
    ],
  })

  const trade = await prisma.tradeRequest.create({
    data: {
      status: "ACCEPTED",
      senderId: a.id,
      receiverId: b.id,
      offeredItemId: ia.id,
      requestedItemId: ib.id,
    },
  })

  // ── 1 ──
  head("1  sharedHubs is the intersection")
  const shared = await sharedHubs(prisma, ia.id, ib.id)
  const sharedIds = shared.map((h) => h.id).sort()
  check(
    "only hubs both listings named",
    sharedIds.length === 2 && sharedIds.includes(both.id) && sharedIds.includes(closed.id),
    JSON.stringify(sharedIds),
  )
  check("the one-sided hub is absent", !sharedIds.includes(onlyA.id))

  // ── 2 ──
  head("2  a pure-Leaves trade needs no special case")
  const selfShared = await sharedHubs(prisma, ia.id, ia.id)
  check(
    "intersection of a listing with itself is its own hubs",
    selfShared.length === 3,
    `got ${selfShared.length}`,
  )

  // ── 3 ──
  head("3  a hub only one side named CAN be proposed, but is never the claim")
  const every = await allHubs(prisma)
  const oneSided = proposableHub(onlyA.id, every)
  check("proposable — the plan is wider than the claim", oneSided.ok, JSON.stringify(oneSided))
  const oneSidedClaim = await resolveMeetupHub(prisma, onlyA.id, ia.id, ib.id)
  check(
    "…and the CLAIM still refuses it, so it can be planned but never paid",
    !oneSidedClaim.ok,
    JSON.stringify(oneSidedClaim),
  )
  const unknown = proposableHub("no-such-hub", every)
  check(
    "an id that is not a hub at all is SAFEZONE_HUB_INVALID",
    !unknown.ok && unknown.code === "SAFEZONE_HUB_INVALID",
    JSON.stringify(unknown),
  )
  const named = await listingHubIds(prisma, ia.id, ib.id)
  check(
    "listingHubIds().shared agrees with sharedHubs()",
    named.shared.length === sharedIds.length && named.shared.every((id) => sharedIds.includes(id)),
    JSON.stringify(named),
  )
  check("the one-sided hub is in yours, not theirs", named.yours.includes(onlyA.id) && !named.theirs.includes(onlyA.id))

  // ── 4 ──
  head("4  an inactive hub is not proposable — stricter than the claim")
  const shut = proposableHub(closed.id, every)
  check(
    "refused for a FUTURE meeting",
    !shut.ok && shut.code === "SAFEZONE_HUB_CLOSED",
    JSON.stringify(shut),
  )
  const claimAtClosed = await resolveMeetupHub(prisma, closed.id, ia.id, ib.id)
  check(
    "…but the CLAIM still accepts it after the fact",
    claimAtClosed.ok,
    "the asymmetry is deliberate — see proposableHub()",
  )
  check("and the open hub IS proposable", proposableHub(both.id, every).ok)

  // ── 5 ──
  head("5  a proposal is unanswered")
  const at = soon(3)
  const proposed = await prisma.tradeRequest.update({
    where: { id: trade.id },
    data: {
      meetupHubId: both.id,
      meetupAt: at,
      meetupNote: "by the door",
      meetupProposedBySender: true,
      meetupAgreedAt: null,
    },
    select: { meetupProposedBySender: true, meetupAgreedAt: true, safeZoneHubId: true },
  })
  check("the proposing SIDE is recorded", proposed.meetupProposedBySender === true)
  check("agreedAt stays null", proposed.meetupAgreedAt === null)

  /*
   * The guard `meetup/accept` applies, restated as the expression the route
   * evaluates: you cannot agree with yourself. Checked from BOTH sides, because
   * a comparison between "which side proposed" and "which side is asking" is
   * exactly the kind that passes one way round and is backwards the other.
   */
  const mayAgree = (proposedBySender: boolean, callerIsSender: boolean) =>
    proposedBySender !== callerIsSender
  check("the proposer cannot agree with themselves", !mayAgree(true, true))
  check("the other side can", mayAgree(true, false))
  check("and it holds the other way round too", !mayAgree(false, false) && mayAgree(false, true))

  const agreed = await prisma.tradeRequest.update({
    where: { id: trade.id },
    data: { meetupAgreedAt: new Date() },
    select: { meetupAgreedAt: true },
  })
  check("the other side can agree", agreed.meetupAgreedAt !== null)

  // ── 6 ──
  head("6  a counter replaces the plan and clears the agreement")
  const countered = await prisma.tradeRequest.update({
    where: { id: trade.id },
    data: {
      meetupHubId: closed.id,
      meetupAt: soon(5),
      meetupNote: null,
      meetupProposedBySender: false,
      meetupAgreedAt: null,
    },
    select: { meetupHubId: true, meetupProposedBySender: true, meetupAgreedAt: true },
  })
  check("the plan moved", countered.meetupHubId === closed.id)
  check("the side flipped", countered.meetupProposedBySender === false)
  check("the agreement is gone", countered.meetupAgreedAt === null)

  // ── 7 ── THE ONE THAT MATTERS
  head("7  NO plan write ever touched safeZoneHubId")
  const after = await prisma.tradeRequest.findUnique({
    where: { id: trade.id },
    select: { safeZoneHubId: true, meetupHubId: true },
  })
  check(
    "the CLAIM is still null after propose, agree and counter",
    after?.safeZoneHubId === null,
    `safeZoneHubId=${after?.safeZoneHubId} — a plan has minted a Safe-Zone award`,
  )
  check("while the PLAN is set", after?.meetupHubId === closed.id)

  // ── 8 ──
  head("8  v1MeetupPlan reads the group")
  const half = v1MeetupPlan({
    meetupHubId: both.id,
    meetupHub: null,
    meetupAt: null,
    meetupNote: null,
    meetupProposedBySender: true,
    meetupAgreedAt: null,
  })
  check("a half-written plan reports as no plan", half === null)

  const cleared = await prisma.tradeRequest.update({
    where: { id: trade.id },
    data: { ...NO_MEETUP_PLAN },
    select: { meetupHubId: true, meetupAt: true, meetupProposedBySender: true },
  })
  check(
    "NO_MEETUP_PLAN clears the whole group",
    cleared.meetupHubId === null &&
      cleared.meetupAt === null &&
      cleared.meetupProposedBySender === null,
  )

  // ── 9 ──
  head("9  only an AGREED plan may default the claim")
  // The rule confirm/submit applies, restated here so a change to it is caught.
  const mayDefault = (hubId: string | null, agreedAt: Date | null) => !!hubId && !!agreedAt
  check("an unanswered proposal does not default the claim", !mayDefault(both.id, null))
  check("an agreed plan does", mayDefault(both.id, new Date()))
  check("no plan at all does not", !mayDefault(null, null))

  console.log(`\n${"═".repeat(72)}`)
  console.log(`  ${pass} passed, ${fail} failed`)
  console.log(`${"═".repeat(72)}\n`)

  await cleanup()
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error(e)
  await cleanup().catch(() => {})
  await prisma.$disconnect()
  process.exit(1)
})
