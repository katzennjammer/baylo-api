// Acceptance harness for 24-hour listing stories (1 Oct 2026).
//
// LIBRARY-LEVEL, not HTTP: the rules live in @/lib/stories and the four routes
// under /api/v1/stories are auth, zod and an envelope around them. Driving the
// library needs no second server, which matters because only one `next dev`
// may run per directory and the user's own is pointed at live.
//
// Covers, in order:
//   1  sharing: own AVAILABLE listing only; not someone else's, not TRADED,
//      not moderation-hidden; one live story per listing; shops refused;
//      caption trimmed and capped
//   2  the row: own first, then unseen, then seen; seen is per viewer and
//      idempotent
//   3  24 h expiry, with no sweep
//   4  a listing story drops early when the listing is traded or hidden
//   5  blocks in both directions and suspended authors; 404 on seen
//   6  delete: own only, idempotent, soft
//   7  the daily cap: 10 per rolling 24 h, deleted stories counted
//   8  the migration itself: the CHECK constraint, the STORY report target,
//      and the cascades
//
// Run on a scratch schema (it refuses `public`):
//   .\scripts\scratch.ps1 -Run scripts\verify-stories.ts
import prisma from "../src/lib/prisma"
import {
  STORY_DAILY_CAP,
  STORY_TTL_MS,
  createListingStory,
  deleteOwnStory,
  listStoryRow,
  markStorySeen,
} from "../src/lib/stories"
import { toDbTarget } from "../src/lib/moderation"
import { requireScratchSchema } from "./lib/live-guard"

const P = "zzstory-"

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`) }
}
function head(s: string) { console.log(`\n── ${s} ${"─".repeat(Math.max(0, 68 - s.length))}`) }

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: P } }, select: { id: true } })
  const ids = users.map((u) => u.id)
  if (ids.length === 0) return
  await prisma.moderationCase.deleteMany({ where: { filedById: { in: ids } } })
  await prisma.block.deleteMany({ where: { OR: [{ blockerId: { in: ids } }, { blockedId: { in: ids } }] } })
  // Story and StoryView cascade from User and Item; deleting the items and
  // users is the cascade test's other half (section 8).
  await prisma.item.deleteMany({ where: { userId: { in: ids } } })
  await prisma.user.deleteMany({ where: { id: { in: ids } } })
}

async function makeUser(tag: string, extra: { isOrgAccount?: boolean } = {}) {
  return prisma.user.create({
    data: {
      name: `${P}${tag}`, email: `${P}${tag}@test.local`,
      isVerified: true, leaves: 0, lifetimeLeaves: 0, ...extra,
    },
    select: { id: true },
  })
}

async function makeItem(userId: string, title: string) {
  return prisma.item.create({
    data: {
      title: `${P}${title}`, description: "fixture", 
      category: "BOOKS", condition: "GOOD", valueLeaves: 100,
      status: "AVAILABLE", userId,
    },
    select: { id: true },
  })
}

const H = 60 * 60 * 1000
const authorsIn = async (viewerId: string, now?: Date) =>
  (await listStoryRow(prisma, viewerId, now)).map((g) => g.user.id)

async function main() {
  requireScratchSchema("scripts/verify-stories.ts")
  console.log("Stories acceptance (library level)")
  await cleanup()

  const alice = await makeUser("alice")
  const bob = await makeUser("bob")
  const carol = await makeUser("carol")
  const shop = await makeUser("shop", { isOrgAccount: true })

  const aBook = await makeItem(alice.id, "Alice book")
  const aLamp = await makeItem(alice.id, "Alice lamp")
  const bBike = await makeItem(bob.id, "Bob bike")
  const cChair = await makeItem(carol.id, "Carol chair")
  const shopItem = await makeItem(shop.id, "Shop rice")

  // ═══════════════════════════════════════════════════════════════════════════
  head("1  Sharing rules")

  const s1 = await createListingStory(prisma, alice.id, { itemId: aBook.id, caption: "  Trade me!  " })
  check("own AVAILABLE listing can be shared", s1.ok)
  const s1id = s1.ok ? s1.storyId : ""
  const s1row = await prisma.story.findUnique({ where: { id: s1id } })
  check("caption is trimmed", s1row?.caption === "Trade me!", JSON.stringify(s1row?.caption))
  check("expiresAt = createdAt + 24 h",
    !!s1row && s1row.expiresAt.getTime() - s1row.createdAt.getTime() === STORY_TTL_MS)

  const dup = await createListingStory(prisma, alice.id, { itemId: aBook.id })
  check("a second live story of the same listing is ALREADY_SHARED",
    !dup.ok && dup.reason === "ALREADY_SHARED")

  const theirs = await createListingStory(prisma, alice.id, { itemId: bBike.id })
  check("someone else's listing is LISTING_NOT_SHAREABLE",
    !theirs.ok && theirs.reason === "LISTING_NOT_SHAREABLE")

  await prisma.item.update({ where: { id: aLamp.id }, data: { status: "TRADED" } })
  const traded = await createListingStory(prisma, alice.id, { itemId: aLamp.id })
  check("a TRADED listing cannot be shared", !traded.ok && traded.reason === "LISTING_NOT_SHAREABLE")
  await prisma.item.update({ where: { id: aLamp.id }, data: { status: "AVAILABLE", moderationHiddenAt: new Date() } })
  const hidden = await createListingStory(prisma, alice.id, { itemId: aLamp.id })
  check("a moderation-hidden listing cannot be shared", !hidden.ok && hidden.reason === "LISTING_NOT_SHAREABLE")
  await prisma.item.update({ where: { id: aLamp.id }, data: { moderationHiddenAt: null } })

  const shopTry = await createListingStory(prisma, shop.id, { itemId: shopItem.id })
  check("a shop's backing account is refused (PERSONAL_ONLY)", !shopTry.ok && shopTry.reason === "PERSONAL_ONLY")

  const long = await createListingStory(prisma, carol.id, { itemId: cChair.id, caption: "x".repeat(250) })
  const longRow = long.ok ? await prisma.story.findUnique({ where: { id: long.storyId } }) : null
  check("caption is capped at 200 by the library too", longRow?.caption?.length === 200)

  // ═══════════════════════════════════════════════════════════════════════════
  head("2  The row and seen state")

  const b1 = await createListingStory(prisma, bob.id, { itemId: bBike.id })
  const b1id = b1.ok ? b1.storyId : ""

  let row = await listStoryRow(prisma, alice.id)
  check("Alice's row lists Alice first (own)", row[0]?.user.id === alice.id && row[0].isOwn)
  check("own stories always read as seen", row[0]?.allSeen === true)
  check("Bob and Carol are both in Alice's row", row.some((g) => g.user.id === bob.id) && row.some((g) => g.user.id === carol.id))
  check("the item rides along in the feed's shape",
    row.find((g) => g.user.id === bob.id)?.stories[0]?.item.id === bBike.id)

  check("markStorySeen on a live story succeeds", await markStorySeen(prisma, alice.id, b1id))
  check("marking it again is idempotent", await markStorySeen(prisma, alice.id, b1id))
  const views = await prisma.storyView.count({ where: { storyId: b1id, viewerId: alice.id } })
  check("exactly one StoryView row after two marks", views === 1, `got ${views}`)

  row = await listStoryRow(prisma, alice.id)
  const order = row.map((g) => g.user.id)
  check("unseen (Carol) sorts before seen (Bob)", order.indexOf(carol.id) < order.indexOf(bob.id), JSON.stringify(order))
  check("Bob's group is allSeen for Alice", row.find((g) => g.user.id === bob.id)?.allSeen === true)
  const carolView = await listStoryRow(prisma, carol.id)
  check("seen is per viewer: Bob is still unseen for Carol",
    carolView.find((g) => g.user.id === bob.id)?.allSeen === false)

  // ═══════════════════════════════════════════════════════════════════════════
  head("3  24 h expiry, no sweep")

  const later = new Date(Date.now() + STORY_TTL_MS + 60_000)
  check("after 24 h Bob's story is gone from Carol's row", !(await authorsIn(carol.id, later)).includes(bob.id))
  check("and cannot be marked seen", !(await markStorySeen(prisma, carol.id, b1id, later)))
  check("the row still exists (report trail)", (await prisma.story.count({ where: { id: b1id } })) === 1)

  // ═══════════════════════════════════════════════════════════════════════════
  head("4  A listing story drops early")

  await prisma.item.update({ where: { id: bBike.id }, data: { status: "TRADED" } })
  check("listing TRADED: Bob's story leaves the row", !(await authorsIn(carol.id)).includes(bob.id))
  check("and seen is a 404", !(await markStorySeen(prisma, carol.id, b1id)))
  await prisma.item.update({ where: { id: bBike.id }, data: { status: "AVAILABLE", moderationHiddenAt: new Date() } })
  check("listing moderation-hidden: still gone", !(await authorsIn(carol.id)).includes(bob.id))
  await prisma.item.update({ where: { id: bBike.id }, data: { status: "IN_TRADE", moderationHiddenAt: null } })
  check("listing IN_TRADE: still gone", !(await authorsIn(carol.id)).includes(bob.id))
  await prisma.item.update({ where: { id: bBike.id }, data: { status: "AVAILABLE" } })
  check("back to AVAILABLE: it returns (inside 24 h)", (await authorsIn(carol.id)).includes(bob.id))

  // ═══════════════════════════════════════════════════════════════════════════
  head("5  Blocks both ways, suspensions")

  await prisma.block.create({ data: { blockerId: carol.id, blockedId: bob.id } })
  check("Carol blocked Bob: Bob's story is gone for Carol", !(await authorsIn(carol.id)).includes(bob.id))
  check("and Carol's story is gone for Bob", !(await authorsIn(bob.id)).includes(carol.id))
  check("Carol marking Bob's story seen is a 404", !(await markStorySeen(prisma, carol.id, b1id)))
  check("Alice (not party to the block) still sees both",
    (await authorsIn(alice.id)).includes(bob.id) && (await authorsIn(alice.id)).includes(carol.id))
  await prisma.block.deleteMany({ where: { blockerId: carol.id } })

  await prisma.user.update({ where: { id: bob.id }, data: { suspendedAt: new Date(), suspendedUntil: null } })
  check("suspended author: Bob's story is gone for Alice", !(await authorsIn(alice.id)).includes(bob.id))
  await prisma.user.update({ where: { id: bob.id }, data: { suspendedAt: new Date(Date.now() - 2 * H), suspendedUntil: new Date(Date.now() - H) } })
  check("a lapsed suspension brings it back", (await authorsIn(alice.id)).includes(bob.id))
  await prisma.user.update({ where: { id: bob.id }, data: { suspendedAt: null, suspendedUntil: null } })

  // ═══════════════════════════════════════════════════════════════════════════
  head("6  Delete")

  check("Alice cannot delete Bob's story", !(await deleteOwnStory(prisma, alice.id, b1id)))
  check("Bob deletes his own", await deleteOwnStory(prisma, bob.id, b1id))
  check("deleting again is idempotent", await deleteOwnStory(prisma, bob.id, b1id))
  check("deleted: gone from Alice's row", !(await authorsIn(alice.id)).includes(bob.id))
  check("soft: the row remains with deletedAt",
    (await prisma.story.findUnique({ where: { id: b1id } }))?.deletedAt != null)
  const again = await createListingStory(prisma, bob.id, { itemId: bBike.id })
  check("after deleting, the listing can be shared again", again.ok)

  // ═══════════════════════════════════════════════════════════════════════════
  head(`7  Daily cap (${STORY_DAILY_CAP} per rolling 24 h)`)

  const dave = await makeUser("dave")
  const daveItems = await Promise.all(
    Array.from({ length: STORY_DAILY_CAP + 2 }, (_, i) => makeItem(dave.id, `Dave ${i}`)),
  )
  const t0 = Date.now() - 23 * H
  let okCount = 0
  for (let i = 0; i < STORY_DAILY_CAP; i++) {
    const r = await createListingStory(prisma, dave.id, { itemId: daveItems[i].id }, new Date(t0 + i * 60_000))
    if (r.ok) okCount++
    // Delete half of them: deleted stories must still count.
    if (r.ok && i % 2 === 0) await deleteOwnStory(prisma, dave.id, r.storyId)
  }
  check(`${STORY_DAILY_CAP} stories accepted`, okCount === STORY_DAILY_CAP, `got ${okCount}`)
  const over = await createListingStory(prisma, dave.id, { itemId: daveItems[STORY_DAILY_CAP].id })
  check("the next one is DAILY_CAP, deleted ones included", !over.ok && over.reason === "DAILY_CAP")
  check("retryAt is when the oldest turns 24 h",
    !over.ok && over.reason === "DAILY_CAP" && over.retryAt.getTime() === t0 + STORY_TTL_MS)
  const afterWindow = await createListingStory(prisma, dave.id,
    { itemId: daveItems[STORY_DAILY_CAP].id }, new Date(t0 + STORY_TTL_MS + 1000))
  check("one slot frees as the oldest leaves the window", afterWindow.ok)

  // ═══════════════════════════════════════════════════════════════════════════
  head("8  The migration: CHECK, STORY report target, cascades")

  let checkFired = false
  try {
    await prisma.story.create({
      data: { userId: alice.id, type: "LISTING", expiresAt: new Date(Date.now() + H) },
    })
  } catch (e) {
    checkFired = /Story_listing_has_item|check constraint/i.test(String(e))
  }
  check("a LISTING story without an item is refused by the CHECK", checkFired)

  check("wire 'story' maps to STORY", toDbTarget("story") === "STORY")
  const report = await prisma.moderationCase.create({
    data: { type: "REPORT", filedById: alice.id, targetType: "STORY", targetId: s1id, category: "SPAM", openKey: "live" },
  })
  check("a Report with targetType STORY is writable", report.targetType === "STORY")

  const lampStory = await createListingStory(prisma, alice.id, { itemId: aLamp.id })
  const lampId = lampStory.ok ? lampStory.storyId : ""
  await markStorySeen(prisma, carol.id, lampId)
  await prisma.item.delete({ where: { id: aLamp.id } })
  check("hard-deleting a listing cascades its stories",
    (await prisma.story.count({ where: { id: lampId } })) === 0)
  check("and their views", (await prisma.storyView.count({ where: { storyId: lampId } })) === 0)

  await prisma.moderationCase.deleteMany({ where: { filedById: { in: [alice.id] } } })
  await cleanup()
  check("deleting the users cascades every fixture story",
    (await prisma.story.count({ where: { user: { email: { startsWith: P } } } })) === 0)

  console.log(`\n${pass} passed, ${fail} failed`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error(e)
  try { await cleanup() } catch {}
  await prisma.$disconnect()
  process.exit(1)
})
