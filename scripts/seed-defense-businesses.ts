// Four pure business (MSME) accounts for the thesis defense (25 Nov 2026).
//
//   $env:DEFENSE_PASSWORD="baylo123"   # optional; otherwise a random one is made
//   npx tsx --tsconfig tsconfig.json --env-file=.env scripts/seed-defense-businesses.ts --live
//   ... --live --reset-password   set DEFENSE_PASSWORD on the existing owner logins
//   ... --live --remove           delete them after the defense
//   (take a backup first with scripts\backup-baylo-pg.ps1)
//
//   Bahay Living Home Store   RETAIL             VERIFIED, Premium, 10 listings, brackets 1-10
//   Sinulid Cebu Apparel      APPAREL            VERIFIED, Premium, 10 listings, brackets 1-10
//   Lami Kitchen Cebu         FOOD_AND_BEVERAGE  under review (PENDING), no listings
//   Buhi Farm Supply          AGRICULTURE        under review (PENDING), no listings
//
// ── "PURE BUSINESS": THE OWNER HAS NOTHING PERSONAL ─────────────────────────
//
// A shop has no login of its own. Each business is three rows, exactly the
// shape createOrganization() in @/lib/organizations produces:
//
//   OWNER          the person who logs in. Email verified, but no listings,
//                  no trades and no points (signupGrantClaimed with no ledger
//                  row, the demo population's faucet guard). Because the owner
//                  has no personal activity and exactly one shop, the app's
//                  useAdoptShopOnSignIn opens straight in shop mode.
//   BACKING USER   isOrgAccount, no password, an org+<id>@accounts.baylo.invalid
//                  address. Owns the listings, the balance and the Premium
//                  subscription (the shop's PREMIUM tag reads THIS row).
//   ORGANIZATION   name, description, category, DTI number, ownerId.
//
// A VERIFIED shop gets the 30-point MSME welcome grant on its backing row with
// the same ledger row the admin approval route writes (ORG_WELCOME_LEAVES,
// SIGNUP_GRANT, once per shop). No AdminAction row: no admin reviewed these,
// and an audit row claiming one did would be false.
//
// Markers: every id starts `defb-`, every owner email is @baylo-demo.test.
// No password in the repo (see PASSWORD). No schema change.

import bcrypt from "bcryptjs"
import { randomBytes } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import prisma from "../src/lib/prisma"
import { requireScratchSchema } from "./lib/live-guard"
import { PREMIUM_LIFETIME_UNTIL } from "../src/lib/premium"
import { ORG_WELCOME_LEAVES } from "../src/lib/task-constants"
import { bracketOf } from "../src/lib/brackets"
import LISTING_IMAGES from "./lib/demo-listing-images.json"

const DOMAIN = "baylo-demo.test"
const ID_PREFIX = "defb-"
// Random per creating run unless DEFENSE_PASSWORD is set; printed once and
// saved outside the repo. A re-run never changes an existing password unless
// --reset-password is passed (which requires DEFENSE_PASSWORD).
const PASSWORD = process.env.DEFENSE_PASSWORD || `Baylo-${randomBytes(4).toString("hex")}!`
const RESET_PASSWORD = process.argv.includes("--reset-password")
const BCRYPT_ROUNDS = 12
const CREDENTIALS_FILE = resolve(__dirname, "../../backups/defense-businesses.txt")

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000)
const daysAgo = (d: number) => hoursAgo(d * 24)

// [title (key of demo-listing-images.json), category, condition, value,
//  description, wanted, wanted categories]
type Listing = [string, string, string, number, string, string, string[]]

type Business = {
  slug: string
  email: string
  owner: string
  name: string
  category: string
  description: string
  city: string
  dti: string
  verified: boolean
  listings: Listing[]
}

const BUSINESSES: Business[] = [
  {
    slug: "bahay",
    email: `bahay.living@${DOMAIN}`,
    owner: "Rowena Tabada",
    name: "Bahay Living Home Store",
    category: "RETAIL",
    description: "Family-run home and furniture store in Mandaue. Surplus stock, display units and gently used pieces.",
    city: "Mandaue City",
    dti: "DTI-07-3381904",
    verified: true,
    listings: [
      ["Food storage containers, set of 4", "OTHER", "NEW", 95, "Stackable lunch containers with lids, BPA-free. Surplus stock.", "Kitchen supplies for resale", ["OTHER"]],
      ["Plastic storage bins, set of 5", "OTHER", "NEW", 230, "Stackable, clear, with snap lids.", "Household items", ["OTHER"]],
      ["Electric fan, stand type", "OTHER", "NEW", 480, "16-inch, three speeds, oscillating. Display unit, boxed.", "Small appliances", ["OTHER", "ELECTRONICS"]],
      ["Rice dispenser, 12kg", "OTHER", "NEW", 850, "Sealed push-button dispenser, measures one cup per press.", "Canned goods or pantry stock", ["FOOD", "OTHER"]],
      ["Travel luggage, 24-inch", "BAGS", "NEW", 1450, "Hard shell, four spinner wheels, TSA lock. Last season's colour.", "Bags or electronics", ["BAGS", "ELECTRONICS"]],
      ["Bookshelf, 5 tiers", "FURNITURE", "NEW", 2300, "White, easy to assemble, wall anchor included.", "Desk lamps or decor", ["FURNITURE"]],
      ["Wooden study desk", "FURNITURE", "GOOD", 3800, "Solid wood, one drawer. Display piece with light marks on the top.", "Office chair or shelving", ["FURNITURE"]],
      ["Office chair, mesh back", "FURNITURE", "LIKE_NEW", 5500, "Adjustable height, lumbar support and armrests. Showroom unit.", "Monitor or desk", ["FURNITURE", "ELECTRONICS"]],
      ["Dining chairs, set of 4", "FURNITURE", "GOOD", 9500, "Solid narra, sturdy. Seats due for re-varnishing.", "Dining table or cabinet", ["FURNITURE"]],
      ["Chest freezer, 5 cu ft", "OTHER", "LIKE_NEW", 13500, "Runs cold and quiet, replaced with a bigger unit for the store.", "Display chiller or shelving", ["FURNITURE", "OTHER"]],
    ],
  },
  {
    slug: "sinulid",
    email: `sinulid.apparel@${DOMAIN}`,
    owner: "Jericho Labrador",
    name: "Sinulid Cebu Apparel",
    category: "APPAREL",
    description: "Small garment studio in Lapu-Lapu making made-to-order shirts and barong, plus curated preloved pieces.",
    city: "Lapu-Lapu City",
    dti: "DTI-07-4410276",
    verified: true,
    listings: [
      ["Tote bags, set of 3", "BAGS", "NEW", 90, "Canvas totes from our sample run, plain, ready for printing.", "Fabric or thread", ["OTHER"]],
      ["Plain cotton shirts, 10 pcs", "CLOTHING", "NEW", 240, "Assorted sizes, 100% cotton, ready for printing.", "Fabric", ["OTHER"]],
      ["Denim jacket, Levi's, size M", "CLOTHING", "GOOD", 480, "Classic trucker cut, lightly faded, no tears.", "Sneakers or bags", ["CLOTHING", "BAGS"]],
      ["Raincoat and rain boots set", "CLOTHING", "NEW", 750, "Adult medium raincoat with matching boots, size 8.", "Umbrellas or bags", ["CLOTHING"]],
      ["Embroidered polo barong, M", "CLOTHING", "NEW", 1450, "Hand-embroidered, sample piece from our 2026 line.", "Sewing machine parts", ["TOOLS"]],
      ["Leather messenger bag", "BAGS", "GOOD", 2400, "Genuine leather, brown, fits a 13-inch laptop.", "Leather tools or hides", ["BAGS", "TOOLS"]],
      ["Silver necklace, 925", "ACCESSORIES", "NEW", 3600, "Sterling silver chain with pendant, with gift box.", "Watches or accessories", ["ACCESSORIES"]],
      ["Perfume, 100ml, 80% full", "BEAUTY", "GOOD", 4800, "Designer eau de parfum, authentic, kept in the box.", "Makeup or skincare", ["BEAUTY"]],
      ["Industrial sewing machine", "TOOLS", "GOOD", 11000, "Juki straight stitch, serviced this year. Replaced with a newer unit.", "Overlock machine", ["TOOLS"]],
      ["Branded handbag, preloved", "BAGS", "GOOD", 16000, "Authentic, with dust bag. Light wear on the corners.", "Display fixtures or a laptop", ["FURNITURE", "ELECTRONICS"]],
    ],
  },
  {
    slug: "lami",
    email: `lami.kitchen@${DOMAIN}`,
    owner: "Celeste Borromeo",
    name: "Lami Kitchen Cebu",
    category: "FOOD_AND_BEVERAGE",
    description: "Home-based kitchen in Cebu City selling native kakanin and party trays.",
    city: "Cebu City",
    dti: "DTI-07-5127733",
    verified: false,
    listings: [],
  },
  {
    slug: "buhi",
    email: `buhi.farm@${DOMAIN}`,
    owner: "Ernesto Climaco",
    name: "Buhi Farm Supply",
    category: "AGRICULTURE",
    description: "Farm supply store in Talisay: seeds, seedlings and garden tools for backyard growers.",
    city: "Talisay City",
    dti: "DTI-07-6093318",
    verified: false,
    listings: [],
  },
]

const ownerIdOf = (b: Business) => `${ID_PREFIX}owner-${b.slug}`
const backingIdOf = (b: Business) => `${ID_PREFIX}shop-${b.slug}`
const orgIdOf = (b: Business) => `${ID_PREFIX}org-${b.slug}`
const itemIdOf = (b: Business, i: number) => `${ID_PREFIX}i-${b.slug}-b${i + 1}`

const images = LISTING_IMAGES as Record<string, { url: string }>

function check() {
  for (const b of BUSINESSES) {
    b.listings.forEach(([title, , , value], i) => {
      if (!images[title]?.url) throw new Error(`no photo for "${title}" in demo-listing-images.json`)
      if (bracketOf(value) !== i + 1) throw new Error(`"${title}" (${value}) is bracket ${bracketOf(value)}, expected ${i + 1}`)
    })
  }
}

async function assertNoForeignRows() {
  const rows = await prisma.user.findMany({
    where: { email: { in: BUSINESSES.map((b) => b.email) } },
    select: { id: true, email: true },
  })
  const foreign = rows.filter((r) => !r.id.startsWith(ID_PREFIX))
  if (foreign.length) {
    throw new Error(`refusing: ${foreign.map((f) => `${f.email} = ${f.id}`).join(", ")} were not created by this script`)
  }
}

/** The owner login. Returns true if it already existed. */
async function upsertOwner(b: Business, passwordHash: string) {
  const existed = !!(await prisma.user.findUnique({ where: { email: b.email }, select: { id: true } }))
  await prisma.user.upsert({
    where: { email: b.email },
    create: {
      id: ownerIdOf(b),
      email: b.email,
      name: b.owner,
      password: passwordHash,
      location: b.city,
      // Verified so the login is complete; no grant and no ledger row, so the
      // personal side carries no points.
      isVerified: true,
      signupGrantClaimed: true,
      createdAt: daysAgo(b.verified ? 35 : 4),
    },
    update: { name: b.owner, location: b.city, ...(RESET_PASSWORD ? { password: passwordHash } : {}) },
  })
  return existed
}

async function upsertShop(b: Business) {
  // The backing row, field for field as createOrganization() makes it.
  await prisma.user.upsert({
    where: { id: backingIdOf(b) },
    create: {
      id: backingIdOf(b),
      email: `org+${backingIdOf(b)}@accounts.baylo.invalid`,
      name: b.name,
      password: null,
      isVerified: false,
      signupGrantClaimed: true,
      isOrgAccount: true,
      location: b.city,
      bio: b.description,
      createdAt: daysAgo(b.verified ? 35 : 4),
    },
    update: { name: b.name, location: b.city, bio: b.description },
  })
  const existing = await prisma.organization.findUnique({ where: { orgUserId: backingIdOf(b) }, select: { id: true } })
  if (!existing) {
    await prisma.organization.create({
      data: {
        id: orgIdOf(b),
        orgUserId: backingIdOf(b),
        name: b.name,
        description: b.description,
        businessCategory: b.category as never,
        dtiRegistrationNumber: b.dti,
        verificationStatus: b.verified ? "VERIFIED" : "PENDING",
        reviewedAt: b.verified ? daysAgo(30) : null,
        ownerId: ownerIdOf(b),
        ownerJoinedAt: daysAgo(b.verified ? 35 : 4),
        createdAt: daysAgo(b.verified ? 35 : 4),
      },
    })
  }
}

/** The MSME welcome grant, once per shop, exactly as the admin approval writes it. */
async function payWelcomeGrant(b: Business): Promise<number> {
  if (ORG_WELCOME_LEAVES <= 0) return 0
  return prisma.$transaction(async (tx) => {
    const paid = await tx.leafTransaction.findFirst({ where: { userId: backingIdOf(b), type: "SIGNUP_GRANT" }, select: { id: true } })
    if (paid) return 0
    await tx.user.update({
      where: { id: backingIdOf(b) },
      data: { leaves: { increment: ORG_WELCOME_LEAVES }, lifetimeLeaves: { increment: ORG_WELCOME_LEAVES } },
    })
    await tx.leafTransaction.create({
      data: {
        userId: backingIdOf(b),
        type: "SIGNUP_GRANT",
        amount: ORG_WELCOME_LEAVES,
        description: "Verified MSME welcome grant",
        eventAt: daysAgo(30),
      },
    })
    return ORG_WELCOME_LEAVES
  })
}

async function ensurePremium(userId: string) {
  const now = new Date()
  const live = await prisma.subscription.findFirst({ where: { userId, tier: "PREMIUM", endsAt: { gt: now } } })
  if (!live) await prisma.subscription.create({ data: { userId, tier: "PREMIUM", startsAt: now, endsAt: PREMIUM_LIFETIME_UNTIL } })
}

async function hubsFor(city: string): Promise<string[]> {
  const local = await prisma.safeZoneHub.findMany({ where: { isActive: true, city }, select: { id: true }, orderBy: { id: "asc" } })
  if (local.length >= 2) return local.map((h) => h.id)
  const any = await prisma.safeZoneHub.findMany({ where: { isActive: true }, select: { id: true }, orderBy: { id: "asc" } })
  return [...local, ...any.filter((h) => !local.some((l) => l.id === h.id))].map((h) => h.id)
}

async function upsertItem(b: Business, i: number, hubIds: string[]) {
  const [title, category, condition, value, description, wanted, wantedCats] = b.listings[i]
  const id = itemIdOf(b, i)
  if (await prisma.item.findUnique({ where: { id }, select: { id: true } })) return "kept" as const
  const hubs = hubIds.length ? [...new Set([hubIds[(2 * i) % hubIds.length], hubIds[(2 * i + 1) % hubIds.length]])] : []
  await prisma.item.create({
    data: {
      id,
      title,
      description,
      images: { create: [{ position: 0, url: images[title].url }] },
      category: category as never,
      condition: condition as never,
      valueLeaves: value,
      suggestedLeaves: value,
      valuationSource: "category_band",
      status: "AVAILABLE",
      wantedItems: wanted,
      wantedCategories: { create: wantedCats.map((c) => ({ category: c as never })) },
      userId: backingIdOf(b), // the SHOP owns it, never the owner personally
      createdAt: hoursAgo(9 + i * 29 + (b.slug === "sinulid" ? 17 : 0)),
      safeZones: { create: hubs.map((hubId) => ({ hubId })) },
    },
  })
  return "created" as const
}

async function apply() {
  // Before anything is written, so a forgotten DEFENSE_PASSWORD never resets
  // the logins to a random password.
  if (RESET_PASSWORD && !process.env.DEFENSE_PASSWORD) throw new Error("--reset-password needs DEFENSE_PASSWORD set")
  check()
  await assertNoForeignRows()
  const passwordHash = await bcrypt.hash(PASSWORD, BCRYPT_ROUNDS)
  const tally = { created: 0, kept: 0 }
  let newOwners = 0

  for (const b of BUSINESSES) {
    if (!(await upsertOwner(b, passwordHash))) newOwners++
    await upsertShop(b)
    if (b.verified) {
      const grant = await payWelcomeGrant(b)
      await ensurePremium(backingIdOf(b))
      const hubIds = await hubsFor(b.city)
      for (let i = 0; i < b.listings.length; i++) tally[await upsertItem(b, i, hubIds)]++
      console.log(`  ${b.name.padEnd(26)} VERIFIED (+${grant} points this run), Premium, ${b.listings.length} listings, ${hubIds.length} hub(s) to pick from`)
    } else {
      console.log(`  ${b.name.padEnd(26)} under review`)
    }
  }
  console.log(`  listings: ${tally.created} created, ${tally.kept} already present`)
  if (newOwners === BUSINESSES.length || RESET_PASSWORD) writeCredentials()
  else if (newOwners > 0) console.log(`\n  ${newOwners} owner login(s) were new and got the password ${PASSWORD}; the others kept theirs.`)
  else console.log("\n  all logins already existed: passwords unchanged (see backups/defense-businesses.txt from the first run)")
}

function writeCredentials() {
  const lines = [
    `Baylo defense businesses -- written ${new Date().toISOString()} by scripts/seed-defense-businesses.ts`,
    `Password for every login: ${PASSWORD}`,
    `Log in with the owner email; the app opens straight in the shop.`,
    ``,
    ...BUSINESSES.map(
      (b) => `${b.email.padEnd(34)} ${b.name.padEnd(26)} ${b.category.padEnd(18)} ${b.verified ? "VERIFIED, Premium, listings in brackets 1-10" : "under review, no listings"}`,
    ),
  ]
  const text = lines.join("\n") + "\n"
  mkdirSync(dirname(CREDENTIALS_FILE), { recursive: true })
  writeFileSync(CREDENTIALS_FILE, text)
  console.log("\n" + text)
  console.log(`  saved to ${CREDENTIALS_FILE}`)
}

async function remove() {
  for (const b of BUSINESSES) {
    const ids = [backingIdOf(b), ownerIdOf(b)]
    const rows = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        email: true,
        _count: { select: { sentTrades: true, receivedTrades: true, sentMessages: true, receivedMessages: true } },
      },
    })
    if (!rows.length) continue
    const activity = rows.reduce((s, r) => s + Object.values(r._count).reduce((x, n) => x + n, 0), 0)
    // A trade or chat with a real user is state on THEIR side too. Keep the
    // whole business for a person to decide.
    if (activity > 0) {
      console.log(`  KEPT ${b.name} (${activity} trade/message rows)`)
      continue
    }
    // Backing row first: the Organization cascades with it, which releases the
    // owner (Organization.ownerId is onDelete: Restrict). Listings and the
    // ledger go with their rows.
    await prisma.user.deleteMany({ where: { id: backingIdOf(b), email: { endsWith: "@accounts.baylo.invalid" } } })
    await prisma.user.deleteMany({ where: { id: ownerIdOf(b), email: { endsWith: `@${DOMAIN}` } } })
    console.log(`  deleted ${b.name} and its owner login`)
  }
}

async function main() {
  requireScratchSchema("scripts/seed-defense-businesses.ts")
  const removing = process.argv.includes("--remove")
  console.log(removing ? "\nRemoving the defense businesses" : "\nSeeding the defense businesses")
  if (removing) await remove()
  else await apply()
  const live = await prisma.item.count({ where: { id: { startsWith: ID_PREFIX }, status: "AVAILABLE" } })
  console.log(`\n  ${live} defense business listing(s) AVAILABLE\n`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
