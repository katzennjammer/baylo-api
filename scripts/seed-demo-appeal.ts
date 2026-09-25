// One demo appeal, so the /admin/appeals queue has a row to look at before
// the mobile client can file one.
//
//   npx tsx --env-file=.env scripts/seed-demo-appeal.ts --live            # apply (upsert)
//   npx tsx --env-file=.env scripts/seed-demo-appeal.ts --remove --live   # delete it again
//
// WHAT IT WRITES, all with ids starting `demo-apl-` so --remove finds them:
//
//   Item          demo-apl-rejected   on the seed account aya@baylo.test,
//                                     VALUE_REJECTED, asked 2,200 (bracket 6)
//                                     against a 480 suggestion (bracket 3)
//   AdminAction   demo-apl-rejection  LISTING_VALUE_REJECTED, the decision the
//                                     appeal is against. Its ACTOR is the
//                                     first ADMIN whose email is on the list
//                                     below (the operator's own accounts), so
//                                     the row is attributed to nobody else.
//   ListingAppeal demo-apl-appeal     OPEN, in Aya's words
//
// Nothing else: no notification (Aya is a seed account), no ledger row. The
// rejection audit row is a fixture and says so in its reason.
//
// Live-guarded like every writing script: refuses `public` without --live.

import prisma from "../src/lib/prisma"
import { bracketOf } from "../src/lib/brackets"
import { requireScratchSchema } from "./lib/live-guard"

const PREFIX = "demo-apl-"
const OWNER_EMAIL = "aya@baylo.test"
/** The rejection is attributed to the first of these that exists and is staff. */
const ACTOR_EMAILS = ["jmjumuad2@gmail.com", "jamaica051705@gmail.com"]

const REQUESTED = 2200
const SUGGESTED = 480

async function apply() {
  const owner = await prisma.user.findUnique({ where: { email: OWNER_EMAIL }, select: { id: true, name: true } })
  if (!owner) throw new Error(`${OWNER_EMAIL} is not seeded here -- run npm run seed first`)
  const actor = await prisma.user.findFirst({
    where: { email: { in: ACTOR_EMAILS }, role: "ADMIN" },
    select: { id: true, name: true, email: true },
  })
  if (!actor) throw new Error(`none of ${ACTOR_EMAILS.join(", ")} is a staff account here`)

  const item = await prisma.item.upsert({
    where: { id: `${PREFIX}rejected` },
    create: {
      id: `${PREFIX}rejected`,
      title: "Canon EOS M50 Mark II, kit lens",
      description:
        "24MP mirrorless with the 15-45mm kit lens, two batteries, strap and a 64GB card. Shutter count under 4,000. Demo listing for the appeals queue.",
      images: JSON.stringify(["https://images.unsplash.com/photo-1516035069371-29a1b244cc32?w=800&q=75"]),
      category: "ELECTRONICS",
      condition: "GOOD",
      valueLeaves: REQUESTED,
      suggestedLeaves: SUGGESTED,
      valuationSource: "category_band",
      valueSetByUser: true,
      status: "VALUE_REJECTED",
      valueRejectionReason: "ABOVE_MARKET",
      userId: owner.id,
    },
    update: {
      status: "VALUE_REJECTED",
      valueRejectionReason: "ABOVE_MARKET",
      valueLeaves: REQUESTED,
      suggestedLeaves: SUGGESTED,
      moderationHiddenAt: null,
    },
    select: { id: true, title: true },
  })

  const action = await prisma.adminAction.upsert({
    where: { id: `${PREFIX}rejection` },
    create: {
      id: `${PREFIX}rejection`,
      actorId: actor.id,
      action: "LISTING_VALUE_REJECTED",
      targetType: "LISTING",
      targetId: item.id,
      reason: "ABOVE_MARKET: DEMO FIXTURE — three M50 bodies with kit lens listed at 450–520",
      detail: JSON.stringify({
        title: item.title,
        ownerId: owner.id,
        requestedLeaves: REQUESTED,
        suggestedLeaves: SUGGESTED,
        requestedBracket: bracketOf(REQUESTED),
        suggestedBracket: bracketOf(SUGGESTED),
        reasonCode: "ABOVE_MARKET",
        note: "DEMO FIXTURE — three M50 bodies with kit lens listed at 450–520",
        demo: true,
      }),
    },
    update: { actorId: actor.id },
    select: { id: true },
  })

  const appeal = await prisma.listingAppeal.upsert({
    where: { id: `${PREFIX}appeal` },
    create: {
      id: `${PREFIX}appeal`,
      itemId: item.id,
      ownerId: owner.id,
      kind: "VALUE_REJECTION",
      actionId: action.id,
      message:
        "The comparables are body-only. Mine has the kit lens, a second battery and under 4,000 shutter actuations — the last one like this on here went for 2,100. Please look again.",
    },
    update: { status: "OPEN", decidedById: null, decidedAt: null, decisionReason: null, actionId: action.id },
    select: { id: true, status: true },
  })

  console.log(`  ${item.id}  "${item.title}"  VALUE_REJECTED  ${REQUESTED} (bracket ${bracketOf(REQUESTED)}) vs ${SUGGESTED} (bracket ${bracketOf(SUGGESTED)})  owner ${owner.name}`)
  console.log(`  ${action.id}  LISTING_VALUE_REJECTED  by ${actor.name} <${actor.email}>`)
  console.log(`  ${appeal.id}  ${appeal.status}`)
  console.log(`\n  open /admin/appeals. Signed in as ${actor.email} you will see the same-reviewer warning; as any other admin you will not.`)
}

async function remove() {
  const appeals = await prisma.listingAppeal.deleteMany({ where: { id: { startsWith: PREFIX } } })
  // Decisions ON the demo appeal (if somebody upheld/overturned it while it
  // was up) and the demo rejection itself.
  const actions = await prisma.adminAction.deleteMany({
    where: { OR: [{ id: { startsWith: PREFIX } }, { targetType: "LISTING_APPEAL", targetId: { startsWith: PREFIX } }, { targetType: "LISTING", targetId: { startsWith: PREFIX } }] },
  })
  const notes = await prisma.notification.deleteMany({ where: { entityId: { startsWith: PREFIX } } })
  const items = await prisma.item.deleteMany({ where: { id: { startsWith: PREFIX } } })
  console.log(`  removed ${appeals.count} appeal(s), ${actions.count} audit row(s), ${notes.count} notification(s), ${items.count} listing(s)`)
}

async function main() {
  requireScratchSchema("scripts/seed-demo-appeal.ts")
  const removing = process.argv.includes("--remove")
  console.log(removing ? "\nRemoving the demo appeal" : "\nSeeding the demo appeal")
  if (removing) await remove()
  else await apply()
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
