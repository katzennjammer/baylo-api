// A demo POPULATION: 50 individual users and 10 verified organisations, each
// with real-looking listings, so the feed, browse, the matcher and the org
// storefronts have something to show that is not the four prisma/seed.ts
// accounts.
//
//   npx tsx --tsconfig tsconfig.json scripts/seed-demo-population.ts            # apply (idempotent)
//   npx tsx --tsconfig tsconfig.json scripts/seed-demo-population.ts --remove   # delete it again
//   (add --live for the live database -- see scripts/lib/live-guard.ts, and
//    take a backup first with scripts\backup-baylo-pg.ps1)
//
// ── HOW TO RECOGNISE A ROW FROM THIS SCRIPT ─────────────────────────────────
//
// There is no "is demo" flag on User or Item, so the marker is twofold:
//
//   EMAIL  every account is @baylo-demo.test. `.test` is reserved (RFC 2606),
//          so no mail can ever be delivered to one and no real person can own
//          one. Individuals are demo-user-01..50, org owners org-demo-01..10,
//          and each org's backing row is org-demo-NN+shop.
//   ID     every row this script creates has an explicit id starting
//          `demo-pop-`, the same convention as seed-demo-brackets.ts's
//          `demo-brk-`. --remove matches on BOTH, so a real account that
//          somebody registered at this domain by hand is never touched.
//   BIO    each account's bio ends "(Demo account.)" so a person looking at a
//          profile in the app can tell.
//
// ── WHY THE ORG LOGIN IS THE OWNER, NOT THE ORG ─────────────────────────────
//
// An organisation's backing User row never logs in: it has no password and
// POST /api/auth/token refuses an isOrgAccount row outright. Humans act as an
// org through OrganizationMember. So org-demo-NN@baylo-demo.test is the org's
// OWNER -- a person, with the shared password -- and posting "as the shop" is
// what the app does when that person switches to the org. Exactly the shape
// createOrganization() in @/lib/organizations produces.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
//
//   NO LEAVES.  Every account starts at 0 with no ledger rows, and
//               signupGrantClaimed is set true -- the same faucet guard
//               createOrganization() uses -- so no later verification can pay
//               sixty synthetic accounts a signup grant. SUM(User.leaves) ==
//               SUM(LeafTransaction.amount) is untouched. The org welcome
//               grant the admin route pays on approval is skipped for the same
//               reason: this is not a review, so it is not written as one (no
//               AdminAction row, reviewedById null).
//   NO HTTP.    Listings are written through Prisma, not POST /api/items, so
//               there is no FIRST_LISTING award (a mint), no quest settlement,
//               and -- the one that matters -- no category-match notification
//               to real users (see the 24 Sep 2026 harness incident).
//   NO RAW SQL. Only the Prisma client, which honours ?schema=.
//
// ── WHAT IT DOES REUSE ──────────────────────────────────────────────────────
//
// Values are not typed in as final numbers. Each listing carries the value an
// owner would ASK for (or none), and decideItemValue() -- the create route's
// own function -- decides the suggestion, the source and whether it is
// user-set. A perishable then goes through decidePerishableValue(), exactly as
// on the route. A standard listing whose ask would need an admin review takes
// the suggestion instead, because a demo listing sitting in PENDING_REVIEW is
// invisible.
//
// IMAGES are one photo PER LISTING, matched to its title, from
// scripts/lib/demo-listing-images.json (built by build-demo-listing-images.ts,
// which records each photo's licence and author). NOT CATEGORY_IMAGES: that is
// the art behind the Explore Categories tiles -- one mood shot per category,
// so every listing in a category showed the same photo, and it was usually
// not the object (a clothing-store interior on a rice cooker). CATEGORY_IMAGES
// is only the fallback for a title the JSON has no entry for.
//
// ── PERISHABLES EXPIRE, AND A RE-RUN RE-POSTS THEM ─────────────────────────
//
// A perishable's window is counted from createdAt, and the lazy sweep on
// /home and /browse moves it to EXPIRED once that passes -- within 24 hours of
// seeding. Re-running this script puts every EXPIRED demo perishable that
// nobody has offered on back to AVAILABLE with a fresh createdAt. Nothing else
// is rewritten on a re-run except the PHOTO: an existing account keeps its row
// (the password is reset to the shared one), and an existing listing nobody has
// offered on gets its image brought in line with the image map, nothing more.

import bcrypt from "bcryptjs"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import prisma from "../src/lib/prisma"
import { requireScratchSchema } from "./lib/live-guard"
import { CATEGORY_IMAGES } from "../src/lib/category-images"
import { decideItemValue } from "../src/lib/valuation-server"
import { decidePerishableValue } from "../src/lib/perishable"
import { bracketOf } from "../src/lib/brackets"
import { ORGS, PERISHABLE, PERISHABLE_EXTRA, STANDARD, type OrgSeed, type Row } from "./lib/demo-population-catalogue"
import LISTING_IMAGES from "./lib/demo-listing-images.json"

const DOMAIN = "baylo-demo.test"
const ID_PREFIX = "demo-pop-"
const PASSWORD = "DemoPass2026!"
const BCRYPT_ROUNDS = 12 // prisma/seed.ts's figure
const CREDENTIALS_FILE = resolve(__dirname, "../../backups/demo-accounts-credentials.txt")

const pad = (n: number) => String(n).padStart(2, "0")
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000)
const daysAgo = (d: number) => hoursAgo(d * 24)

const CITIES = [
  "Cebu City", "Mandaue City", "Lapu-Lapu City", "Talisay City",
  "Consolacion", "Minglanilla", "Liloan",
]

const FIRST = [
  "Maria", "Juan", "Angelica", "Mark", "Kristine", "John Paul", "Rhea", "Carlo", "Jasmine", "Miguel",
  "Patricia", "Joshua", "Clarisse", "Rafael", "Bea", "Christian", "Hazel", "Vincent", "Trisha", "Nico",
  "Andrea", "Gabriel", "Nicole", "Paolo", "Samantha", "Adrian", "Camille", "Jerome", "Mae", "Lorenzo",
  "Ella", "Dominic", "Faith", "Ramon", "Janine", "Kyle", "Lovely", "Aldrin", "Princess", "Bryan",
  "Shaira", "Ivan", "Denise", "Marvin", "Kaye", "Rico", "Jessa", "Noel", "Mika", "Arnel",
]
const LAST = [
  "Santos", "Reyes", "Cruz", "Bautista", "Gonzales", "Garcia", "Mendoza", "Torres", "Tomas", "Aquino",
  "Navarro", "Ramos", "Villanueva", "Castillo", "Flores", "Rivera", "Lim", "Tan", "Go", "Uy",
  "Alcantara", "Cabrera", "Salazar", "Dizon", "Pacquiao", "Labrador", "Cuenca", "Ybanez", "Sanchez", "Osmena",
  "Gullas", "Abella", "Rama", "Borromeo", "Climaco", "Lopez", "Diaz", "Moreno", "Castro", "Perez",
  "Jumao-as", "Cortes", "Pepito", "Ompad", "Canete", "Mahusay", "Tabada", "Sarmiento", "Estrella", "Sy",
]

// ── Plan ─────────────────────────────────────────────────────────────────────

type PlannedItem = {
  id: string
  row: Row
  perishable: null | { quantity: number | null; unit: "KG" | "PCS" | "LITERS" | null; hours: 6 | 24 }
  createdAt: Date
}
type PlannedAccount = {
  kind: "individual" | "org"
  id: string
  email: string
  name: string
  city: string
  dob: string
  bio: string
  org?: { id: string; backingId: string; backingEmail: string; seed: OrgSeed; dti: string }
  items: PlannedItem[]
}

function plan(): PlannedAccount[] {
  const out: PlannedAccount[] = []
  let std = 0
  for (let i = 1; i <= 50; i++) {
    const n = pad(i)
    const id = `${ID_PREFIX}u${n}`
    const items: PlannedItem[] = []
    // Odd-numbered users post two standard items, even-numbered one: 75 total.
    const count = i % 2 === 1 ? 2 : 1
    for (let k = 0; k < count; k++) {
      items.push({ id: `${id}-s${k + 1}`, row: STANDARD[std++], perishable: null, createdAt: daysAgo(1 + ((i * 7 + k * 3) % 21)) })
    }
    const [quantity, unit, hours] = PERISHABLE_EXTRA[i - 1]
    // Posted within the last few hours, and always well inside its window.
    items.push({ id: `${id}-p1`, row: PERISHABLE[i - 1], perishable: { quantity, unit, hours }, createdAt: hoursAgo((i % 4) * 0.5) })
    const first = FIRST[i - 1]
    const last = LAST[(i * 17) % LAST.length]
    const city = CITIES[i % CITIES.length]
    out.push({
      kind: "individual", id, email: `demo-user-${n}@${DOMAIN}`,
      name: `${first} ${last}`, city,
      dob: `${1980 + (i % 22)}-${pad(1 + (i % 12))}-${pad(1 + ((i * 3) % 28))}`,
      bio: `Trading what I no longer use around ${city}. (Demo account.)`,
      items,
    })
  }
  ORGS.forEach((o, j) => {
    const n = pad(j + 1)
    const id = `${ID_PREFIX}o${n}-owner`
    const backingId = `${ID_PREFIX}o${n}`
    out.push({
      kind: "org", id, email: `org-demo-${n}@${DOMAIN}`,
      name: o.owner, city: CITIES[j % CITIES.length],
      dob: `${1975 + j}-${pad(1 + j)}-15`,
      bio: `Owner of ${o.name}. (Demo account.)`,
      org: {
        id: `${ID_PREFIX}org${n}`, backingId, backingEmail: `org-demo-${n}+shop@${DOMAIN}`, seed: o,
        // Obviously not a DTI-issued number, on purpose: a realistic 7-digit
        // figure could be somebody's real business name registration.
        dti: `DEMO-BN-2026${n}`,
      },
      items: o.items.map((row, k) => ({ id: `${backingId}-s${k + 1}`, row, perishable: null, createdAt: daysAgo(2 + ((j * 5 + k * 4) % 20)) })),
    })
  })
  return out
}

/** The listing's own photo; the category tile only if the title has none. */
function imageFor(title: string, category: string): string {
  // Only a Cloudinary copy is ever shown -- never the Flickr/Commons original.
  const hit = (LISTING_IMAGES as unknown as Record<string, { url?: string }>)[title]
  return hit?.url?.includes("res.cloudinary.com") ? hit.url : CATEGORY_IMAGES[category] ?? CATEGORY_IMAGES.OTHER
}

// ── Apply ────────────────────────────────────────────────────────────────────

/** The one refusal: an address at our domain that this script did not create. */
async function assertNoForeignRows(accounts: PlannedAccount[]) {
  const emails = accounts.flatMap((a) => (a.org ? [a.email, a.org.backingEmail] : [a.email]))
  const rows = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true, email: true } })
  const foreign = rows.filter((r) => !r.id.startsWith(ID_PREFIX))
  if (foreign.length > 0) {
    throw new Error(
      `refusing: ${foreign.length} account(s) at @${DOMAIN} were not created by this script ` +
        `(${foreign.map((f) => `${f.email} = ${f.id}`).join(", ")}). Resolve by hand first.`,
    )
  }
  return new Set(rows.map((r) => r.email))
}

async function upsertPerson(a: PlannedAccount, passwordHash: string, grandfathered: boolean) {
  const shared = {
    name: a.name,
    password: passwordHash,
    location: a.city,
    bio: a.bio,
    dateOfBirth: new Date(a.dob),
  }
  await prisma.user.upsert({
    where: { email: a.email },
    create: {
      id: a.id,
      email: a.email,
      ...shared,
      // Verified, so login works. signupGrantClaimed with NO ledger row is the
      // faucet guard -- see the header: these accounts are never paid.
      isVerified: true,
      signupGrantClaimed: true,
      // Past the ID gate without a review, which is literally what happened.
      // Only individuals need it (they post personally); org owners post AS
      // the org, whose own VERIFIED status is the check.
      idVerifiedGrandfatheredAt: grandfathered ? new Date() : null,
      createdAt: daysAgo(25 + (Number(a.id.replace(/\D/g, "")) % 30)),
    },
    update: shared,
  })
}

async function upsertOrg(a: PlannedAccount) {
  const o = a.org!
  // Mirrors createOrganization() in @/lib/organizations field for field,
  // except the email, which carries the demo domain instead of a random uuid.
  await prisma.user.upsert({
    where: { email: o.backingEmail },
    create: {
      id: o.backingId,
      email: o.backingEmail,
      name: o.seed.name,
      password: null,
      isVerified: false,
      signupGrantClaimed: true,
      isOrgAccount: true,
      location: a.city,
      createdAt: daysAgo(25),
    },
    update: { name: o.seed.name },
  })
  const existing = await prisma.organization.findUnique({ where: { orgUserId: o.backingId }, select: { id: true } })
  if (!existing) {
    await prisma.organization.create({
      data: {
        id: o.id,
        orgUserId: o.backingId,
        name: o.seed.name,
        description: o.seed.description,
        businessCategory: o.seed.category as never,
        dtiRegistrationNumber: o.dti,
        // Straight to VERIFIED: no document was uploaded, so there is nothing
        // in Cloudinary to destroy and nothing for businessDocUrl to hold.
        // reviewedById stays null -- no admin reviewed this, and an AdminAction
        // row claiming one did would be a false audit record.
        verificationStatus: "VERIFIED",
        reviewedAt: new Date(),
        members: { create: { userId: a.id, role: "OWNER", status: "ACTIVE", joinedAt: new Date() } },
      },
    })
  }
}

async function upsertItem(ownerId: string, p: PlannedItem, hubIds: string[], hubCursor: { i: number }) {
  const [title, category, condition, asked, description, wanted, lookingFor] = p.row
  const existing = await prisma.item.findUnique({
    where: { id: p.id },
    select: { status: true, isPerishable: true, images: true, _count: { select: { offers: true, offeredIn: true, requestedIn: true } } },
  })

  if (existing) {
    const touched = existing._count.offers + existing._count.offeredIn + existing._count.requestedIn
    if (touched > 0) return "kept" as const
    // The photo is the one column a re-run corrects on an untouched listing,
    // so a fix to the image map reaches rows --remove had to keep (an account
    // with ledger rows is never deleted -- see remove()).
    const images = JSON.stringify([imageFor(title, category)])
    const rephoto = existing.images !== images
    if (existing.isPerishable && existing.status === "EXPIRED") {
      await prisma.item.update({ where: { id: p.id }, data: { status: "AVAILABLE", createdAt: new Date(), images } })
      return "refreshed" as const
    }
    if (rephoto) {
      await prisma.item.update({ where: { id: p.id }, data: { images } })
      return "rephotographed" as const
    }
    return "kept" as const
  }

  // The create route's own valuation, then its perishable rule.
  const valued = await decideItemValue(category, condition, asked)
  let data = valued.data
  if (p.perishable) data = decidePerishableValue(valued).data
  else if (valued.needsReview) {
    const fallback = await decideItemValue(category, condition, null)
    data = fallback.data
  }

  // One public meetup hub per listing when there are any; zero is normal.
  const hub = hubIds.length > 0 ? hubIds[hubCursor.i++ % hubIds.length] : null

  await prisma.item.create({
    data: {
      id: p.id,
      title,
      description,
      images: JSON.stringify([imageFor(title, category)]),
      category: category as never,
      condition: condition as never,
      ...data,
      status: "AVAILABLE",
      wantedItems: wanted,
      lookingForCategories: lookingFor as never,
      userId: ownerId,
      createdAt: p.createdAt,
      ...(p.perishable
        ? { isPerishable: true, quantity: p.perishable.quantity, quantityUnit: p.perishable.unit, tradeWithinHours: p.perishable.hours }
        : {}),
      ...(hub ? { safeZones: { create: [{ hubId: hub }] } } : {}),
    },
  })
  return "created" as const
}

async function apply() {
  const accounts = plan()
  const before = await assertNoForeignRows(accounts)
  console.log(`  ${before.size} demo account row(s) already present; hashing the shared password...`)
  const passwordHash = await bcrypt.hash(PASSWORD, BCRYPT_ROUNDS)

  const hubIds = (await prisma.safeZoneHub.findMany({ where: { isActive: true }, select: { id: true }, orderBy: { id: "asc" } })).map((h) => h.id)
  const hubCursor = { i: 0 }
  const tally = { created: 0, kept: 0, refreshed: 0, rephotographed: 0 }
  const brackets = new Map<number, number>()

  for (const a of accounts) {
    await upsertPerson(a, passwordHash, a.kind === "individual")
    if (a.org) await upsertOrg(a)
    const ownerId = a.org ? a.org.backingId : a.id
    for (const p of a.items) tally[await upsertItem(ownerId, p, hubIds, hubCursor)]++
    process.stdout.write(`\r  ${a.email.padEnd(34)}`)
  }
  console.log("\r" + " ".repeat(40))

  for (const it of await prisma.item.findMany({ where: { id: { startsWith: ID_PREFIX } }, select: { valueLeaves: true } })) {
    const b = bracketOf(it.valueLeaves ?? 0)
    brackets.set(b, (brackets.get(b) ?? 0) + 1)
  }
  console.log(`  listings: ${tally.created} created, ${tally.kept} already present, ${tally.rephotographed} re-photographed, ${tally.refreshed} expired perishable(s) re-posted`)
  console.log(`  hubs attached from ${hubIds.length} active hub(s)`)
  console.log(`  by bracket: ${[...brackets.entries()].sort((x, y) => x[0] - y[0]).map(([b, n]) => `B${b}=${n}`).join("  ")}`)

  await writeCredentials(accounts)
}

async function writeCredentials(accounts: PlannedAccount[]) {
  const lines = [
    `Baylo demo population -- written ${new Date().toISOString()} by scripts/seed-demo-population.ts`,
    `Shared password for EVERY account below: ${PASSWORD}`,
    `Org accounts log in as the OWNER (a person) and switch to the shop in the app;`,
    `the shop's own backing row (org-demo-NN+shop@) cannot log in, by design.`,
    ``,
    `${"EMAIL".padEnd(34)} ${"TYPE".padEnd(11)} NAME / ORGANISATION`,
  ]
  for (const a of accounts) {
    lines.push(`${a.email.padEnd(34)} ${a.kind.padEnd(11)} ${a.org ? `${a.org.seed.name}  (owner: ${a.name}, ${a.org.seed.category})` : a.name}`)
  }
  lines.push("", `${accounts.length} accounts (${accounts.filter((a) => a.kind === "individual").length} individual, ${accounts.filter((a) => a.org).length} org).`)
  const text = lines.join("\n") + "\n"
  mkdirSync(dirname(CREDENTIALS_FILE), { recursive: true })
  writeFileSync(CREDENTIALS_FILE, text)
  console.log("\n" + text)
  console.log(`  saved to ${CREDENTIALS_FILE}`)
}

// ── Remove ───────────────────────────────────────────────────────────────────

async function remove() {
  // BOTH markers, never one: the id is ours and the address is ours.
  const users = await prisma.user.findMany({
    where: { id: { startsWith: ID_PREFIX }, email: { endsWith: `@${DOMAIN}` } },
    select: {
      id: true, email: true, isOrgAccount: true,
      _count: {
        select: {
          sentOffers: true, receivedOffers: true, sentRequests: true, receivedRequests: true,
          sentMessages: true, receivedMessages: true, leafTransactions: true, contractsAsDebtor: true, contractsAsCreditor: true,
        },
      },
    },
  })
  if (users.length === 0) {
    console.log("  nothing to remove")
    return
  }
  // Backing rows first; the org and its memberships cascade with them.
  users.sort((x, y) => Number(y.isOrgAccount) - Number(x.isOrgAccount))
  let deleted = 0
  const kept: string[] = []
  for (const u of users) {
    const activity = Object.values(u._count).reduce((s, n) => s + n, 0)
    // Somebody traded, messaged or was paid while demoing: that is real state
    // on the other side too, and a cascade would take it with this row. Leave
    // it for a person to decide.
    if (activity > 0) {
      kept.push(`${u.email} (${activity} offer/trade/message/ledger rows)`)
      continue
    }
    await prisma.user.delete({ where: { id: u.id } })
    deleted++
  }
  console.log(`  ${deleted} account(s) deleted, with their listings`)
  if (kept.length) console.log(`  KEPT ${kept.length}, because they have activity:\n    ${kept.join("\n    ")}`)
}

async function main() {
  requireScratchSchema("scripts/seed-demo-population.ts")
  const removing = process.argv.includes("--remove")
  console.log(removing ? "\nRemoving the demo population" : "\nSeeding the demo population")
  if (removing) await remove()
  else await apply()

  const [users, orgs, live] = await Promise.all([
    prisma.user.count({ where: { id: { startsWith: ID_PREFIX }, email: { endsWith: `@${DOMAIN}` } } }),
    prisma.organization.count({ where: { id: { startsWith: ID_PREFIX } } }),
    prisma.item.count({ where: { id: { startsWith: ID_PREFIX }, status: "AVAILABLE" } }),
  ])
  console.log(`\n  now: ${users} demo user rows, ${orgs} demo organisations, ${live} demo listings AVAILABLE\n`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
