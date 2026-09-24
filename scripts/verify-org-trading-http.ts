/**
 * Offers across the person / organisation line, over real HTTP.
 *
 * Run (with `npm run dev` up):
 *   npx tsx --env-file=.env scripts/verify-org-trading-http.ts
 *
 * ── WHAT THIS PINS DOWN (25 Sep 2026) ───────────────────────────────────────
 *
 *   CONTROL   person -> person: offer, then accept. If this fails, the rest
 *             of the file says nothing about orgs.
 *   A         person -> an ORG's listing: the offer is sent.
 *   B         org staff, acting as the org (X-Baylo-Org), accept that offer.
 *   C         org staff, acting as the org, offer one of the ORG's items on a
 *             person's listing.
 *   QUESTS    the event hook in POST /api/offers settles the people's quests
 *             with no GET /api/v1/quests involved, and never touches the org's
 *             backing row.
 *
 * B and C assert what the schema says should happen ("STAFF trades", on
 * OrganizationMemberRole), NOT what the routes do today. Today only POST
 * /api/items reads X-Baylo-Org, so they FAIL: every offer and trade route
 * acts as the signed-in human. See the report of 25 Sep 2026. When org
 * trading is built, these are the checks that should turn green.
 *
 * Fixtures are tagged, created through Prisma and the org library, and
 * deleted in `finally`.
 */
import prisma from "../src/lib/prisma"
import { createOrganization } from "../src/lib/organizations"
import { signAccessToken } from "../src/lib/auth-tokens"
import { requireScratchSchema } from "./lib/live-guard"

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

async function call(
  path: string,
  opts: { token: string; orgId?: string | null; method?: string; body?: unknown },
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

const brief = (c: Called) => `status ${c.status} ${JSON.stringify(c.body).slice(0, 200)}`

async function poll<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms
  let v = await read()
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 250))
    v = await read()
  }
  return v
}

async function main() {
  requireScratchSchema("scripts/verify-org-trading-http.ts")
  try {
    await fetch(`${BASE}/api/v1/hubs`, { method: "GET" })
  } catch {
    console.error(`No server at ${BASE}. Start it with \`npm run dev\` first.`)
    process.exit(2)
  }

  const tag = `verify-org-trading-${Date.now()}`
  const created = { users: [] as string[], orgs: [] as string[] }

  const person = (name: string) =>
    prisma.user.create({
      data: {
        name: `${tag}-${name}`,
        email: `${tag}-${name}@test.invalid`,
        isVerified: true,
        idVerifiedGrandfatheredAt: new Date(),
      },
      select: { id: true },
    })

  // Same value on every item, so every pair is same-bracket: no bridging fee,
  // no consent, nothing about Leaves in the way of the question being asked.
  const item = (ownerId: string, title: string) =>
    prisma.item.create({
      data: {
        title: `${tag} ${title}`, description: "x", images: "[]",
        category: "OTHER", condition: "GOOD", valueLeaves: 20, userId: ownerId,
      },
      select: { id: true },
    })

  try {
    const alice = await person("alice")
    const bob = await person("bob")
    const owner = await person("owner")
    const staff = await person("staff")
    created.users.push(alice.id, bob.id, owner.id, staff.id)

    const org = await createOrganization({
      founderUserId: owner.id,
      name: `${tag} Store`,
      businessCategory: "SARI_SARI",
    })
    created.orgs.push(org.organizationId)
    created.users.push(org.orgUserId)
    await prisma.organization.update({
      where: { id: org.organizationId },
      data: { verificationStatus: "VERIFIED" },
    })
    await prisma.organizationMember.create({
      data: { organizationId: org.organizationId, userId: staff.id, role: "STAFF", status: "ACTIVE" },
    })

    const aliceToken = await signAccessToken(alice.id)
    const bobToken = await signAccessToken(bob.id)
    const staffToken = await signAccessToken(staff.id)

    const aliceItem = await item(alice.id, "alice mug")
    const aliceItem2 = await item(alice.id, "alice lamp")
    const bobItem = await item(bob.id, "bob book")
    const bobItem2 = await item(bob.id, "bob kettle")
    const orgItem = await item(org.orgUserId, "org rice")
    const orgItem2 = await item(org.orgUserId, "org sugar")

    // ── control ─────────────────────────────────────────────────────────────
    console.log("\ncontrol: person -> person")
    const ctl = await call("/api/offers", {
      token: aliceToken, method: "POST",
      body: { postId: bobItem.id, offeredItemId: aliceItem.id },
    })
    check("alice can offer on bob's listing", ctl.status === 201, brief(ctl))
    if (ctl.status === 201) {
      const acc = await call(`/api/offers/${ctl.body.offerId}`, {
        token: bobToken, method: "PATCH", body: { action: "accept" },
      })
      check("bob can accept it", acc.status === 200, brief(acc))
    }

    // ── A ───────────────────────────────────────────────────────────────────
    console.log("\nA: person -> an org's listing")
    const toOrg = await call("/api/offers", {
      token: bobToken, method: "POST",
      body: { postId: orgItem.id, offeredItemId: bobItem2.id },
    })
    check("bob can offer on the org's listing", toOrg.status === 201, brief(toOrg))
    const toOrgRow = toOrg.status === 201
      ? await prisma.offer.findUnique({ where: { id: String(toOrg.body.offerId) }, select: { receiverId: true } })
      : null
    check("the offer's receiver is the org's backing row", toOrgRow?.receiverId === org.orgUserId,
      `receiver ${toOrgRow?.receiverId}`)

    // ── B ───────────────────────────────────────────────────────────────────
    console.log("\nB: org staff accept, acting as the org")
    if (toOrg.status === 201) {
      const accAsOrg = await call(`/api/offers/${toOrg.body.offerId}`, {
        token: staffToken, orgId: org.organizationId, method: "PATCH", body: { action: "accept" },
      })
      check("staff with X-Baylo-Org can accept an offer on the org's listing",
        accAsOrg.status === 200, brief(accAsOrg))
    }

    // ── C ───────────────────────────────────────────────────────────────────
    console.log("\nC: org staff offer the org's item on a person's listing")
    const fromOrg = await call("/api/offers", {
      token: staffToken, orgId: org.organizationId, method: "POST",
      body: { postId: aliceItem2.id, offeredItemId: orgItem2.id },
    })
    check("staff with X-Baylo-Org can offer an org item", fromOrg.status === 201, brief(fromOrg))
    if (fromOrg.status === 201) {
      const row = await prisma.offer.findUnique({
        where: { id: String(fromOrg.body.offerId) }, select: { senderId: true },
      })
      check("and the offer is sent BY the org, not the staff member", row?.senderId === org.orgUserId,
        `sender ${row?.senderId}`)
    }

    // ── quests, through the event hook alone ────────────────────────────────
    console.log("\nquests: settled by POST /api/offers, no GET /api/v1/quests")
    const aliceDay = await poll(
      () => prisma.questAssignment.findMany({ where: { userId: alice.id } }),
      (rows) => rows.length === 5,
    )
    check("alice (sender) has today's 5 assignments from the event alone", aliceDay.length === 5,
      `${aliceDay.length} rows`)
    const aliceSend = aliceDay.find((a) => a.quest === "SEND_OFFER")
    if (aliceSend) {
      const settled = await poll(
        () => prisma.questAssignment.findUnique({ where: { id: aliceSend.id } }),
        (a) => a?.completedAt != null,
      )
      check("alice's SEND_OFFER is paid without her opening Quests", settled?.completedAt != null)
    } else {
      console.log("  ..    alice did not draw SEND_OFFER today; the assignment check above still stands")
    }
    const bobDay = await poll(
      () => prisma.questAssignment.findMany({ where: { userId: bob.id } }),
      (rows) => rows.length === 5,
    )
    check("bob (receiver, then sender) has today's 5 assignments", bobDay.length === 5, `${bobDay.length} rows`)
    await new Promise((r) => setTimeout(r, 1500))
    const orgRows = await prisma.questAssignment.count({ where: { userId: org.orgUserId } })
    check("the org's backing row got NO quest assignments", orgRows === 0, `${orgRows} rows`)
  } finally {
    const ids = created.users
    await prisma.tradeRequest.deleteMany({ where: { OR: [{ senderId: { in: ids } }, { receiverId: { in: ids } }] } })
    await prisma.offer.deleteMany({ where: { OR: [{ senderId: { in: ids } }, { receiverId: { in: ids } }] } })
    await prisma.message.deleteMany({ where: { OR: [{ senderId: { in: ids } }, { receiverId: { in: ids } }] } })
    // Match notifications land on OTHER people's accounts -- anyone whose
    // listing wants what this posted -- so deleting by our own user ids misses
    // exactly the ones that matter. Delete by the listing they point at, BEFORE
    // the listings go (24 Sep 2026: nine orphans on a real account).
    const postedIds = (
      await prisma.item.findMany({ where: { userId: { in: ids } }, select: { id: true } })
    ).map((i) => i.id)
    await prisma.notification.deleteMany({
      where: { OR: [{ userId: { in: ids } }, { actorId: { in: ids } }, { entityType: "item", entityId: { in: postedIds } }] },
    })
    await prisma.item.deleteMany({ where: { userId: { in: ids } } })
    await prisma.organization.deleteMany({ where: { id: { in: created.orgs } } })
    await prisma.user.deleteMany({ where: { id: { in: ids } } })
    await prisma.$disconnect()
  }

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
