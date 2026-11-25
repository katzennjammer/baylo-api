// Four lifelike trader accounts for the thesis defense (25 Nov 2026).
//
//   npx tsx --tsconfig tsconfig.json --env-file=.env scripts/seed-defense-accounts.ts --live            # apply (re-runnable)
//   npx tsx --tsconfig tsconfig.json --env-file=.env scripts/seed-defense-accounts.ts --live --remove   # delete them after the defense
//   (take a backup first with scripts\backup-baylo-pg.ps1)
//
//   Andrea Villanueva  email + ID verified, Premium (lifetime), 10 listings, one per bracket 1-10
//   Marco Dizon        email + ID verified, Premium (lifetime), 10 listings, one per bracket 1-10
//   Kim Abella         NOT verified, no listings, no points
//   Paul Rosales       NOT verified, no listings, no points
//
// ── MARKERS ─────────────────────────────────────────────────────────────────
//
// Every row this script creates has an id starting `def-` and every email is
// @baylo-demo.test (`.test` is reserved by RFC 2606: no mail is ever delivered,
// no real person can own one). --remove matches on BOTH. Unlike the demo
// population, bios do NOT say "demo": these are meant to be shown as ordinary
// users during the defense.
//
// ── PASSWORD ─────────────────────────────────────────────────────────────────
//
// See PASSWORD below: random per creating run, never stored in the repo.
//
// ── HOW EACH THING IS MADE REAL ─────────────────────────────────────────────
//
//   EMAIL VERIFIED   the account is created unverified and then passed through
//                    markVerified() -- the one function every real verification
//                    route calls -- so it gets the genuine 30 welcome points
//                    with their ledger rows (signup grant + VERIFY_ACCOUNT).
//   ID VERIFIED      idVerifiedGrandfatheredAt, the existing "past the ID gate"
//                    mechanism (@/lib/id-verification). No fake ID document.
//   PREMIUM          a lifetime Subscription row, the same write as
//                    scripts/set-tier.ts.
//   LISTINGS         written through Prisma, not POST /api/items, so there is
//                    no category-match notification to real users and no
//                    FIRST_LISTING award. Photos are the title-matched
//                    Cloudinary images in scripts/lib/demo-listing-images.json.
//                    Each listing gets two active SafeZone hubs, preferring the
//                    owner's city.
//
// No schema change: only existing tables and columns.

import bcrypt from "bcryptjs"
import { randomBytes } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import prisma from "../src/lib/prisma"
import { requireScratchSchema } from "./lib/live-guard"
import { markVerified } from "../src/lib/verification"
import { PREMIUM_LIFETIME_UNTIL } from "../src/lib/premium"
import { bracketOf } from "../src/lib/brackets"
import LISTING_IMAGES from "./lib/demo-listing-images.json"

const DOMAIN = "baylo-demo.test"
const ID_PREFIX = "def-"
// NO PASSWORD IN THE REPO. A random one is made on the run that CREATES the
// accounts, printed once and saved to backups/defense-accounts.txt on the PC
// that ran it (outside the repo). A re-run never changes an existing
// account's password. Pass DEFENSE_PASSWORD=... to choose it yourself.
const PASSWORD = process.env.DEFENSE_PASSWORD || `Baylo-${randomBytes(4).toString("hex")}!`
const BCRYPT_ROUNDS = 12
const CREDENTIALS_FILE = resolve(__dirname, "../../backups/defense-accounts.txt")

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000)
const daysAgo = (d: number) => hoursAgo(d * 24)

// [title (must be a key of demo-listing-images.json), category, condition,
//  value in Leaves, description, wanted, wanted categories]
type Listing = [string, string, string, number, string, string, string[]]

type Account = {
  slug: string
  name: string
  city: string
  dob: string
  bio: string
  verified: boolean
  listings: Listing[]
}

const ACCOUNTS: Account[] = [
  {
    slug: "andrea",
    name: "Andrea Villanueva",
    city: "Lapu-Lapu City",
    dob: "1998-04-12",
    bio: "Nurse in Lapu-Lapu. Decluttering the condo, happy to meet at a SafeZone hub after shift.",
    verified: true,
    listings: [
      ["Snake plant in ceramic pot", "PLANTS", "GOOD", 90, "About 2 ft tall, healthy and easy to care for. Repotted last month.", "Other houseplants", ["PLANTS"]],
      ["Harry Potter box set, paperback", "BOOKS", "GOOD", 220, "All seven books, read once. Spines slightly creased, no torn pages.", "Other novels or a board game", ["BOOKS", "TOYS"]],
      ["Nike Air Force 1, size 9", "CLOTHING", "GOOD", 480, "White, cleaned and deodorised. Soles still have plenty of life.", "Running shoes size 9", ["CLOTHING", "SPORTS"]],
      ["Yamaha acoustic guitar F310", "MUSIC", "GOOD", 850, "Good action, new strings, soft case included. No cracks.", "Ukulele or a keyboard", ["MUSIC"]],
      ["Casio G-Shock, black", "ACCESSORIES", "GOOD", 1500, "Authentic, works perfectly. Band slightly worn, glass has no scratches.", "Sunglasses or a wallet", ["ACCESSORIES"]],
      ["Kindle Paperwhite, 10th gen", "ELECTRONICS", "GOOD", 2400, "Waterproof, 8GB, with a cover. Battery lasts weeks.", "Books or headphones", ["BOOKS", "ELECTRONICS"]],
      ["Digital piano, 88 keys", "MUSIC", "GOOD", 3900, "Weighted keys, comes with the stand and a sustain pedal.", "Guitar or a laptop", ["MUSIC", "ELECTRONICS"]],
      ["Nintendo Switch Lite, turquoise", "GAMING", "GOOD", 7500, "With a Pokemon Sword cartridge and a hard case. No stick drift.", "Tablet or phone", ["GAMING", "ELECTRONICS"]],
      ["Road bike, carbon fork, 54cm", "BIKES", "LIKE_NEW", 11500, "Shimano Sora groupset, clipless pedals included. Ridden a few weekends.", "Laptop or a camera", ["ELECTRONICS", "BIKES"]],
      ["Canon EOS M50 with kit lens", "ELECTRONICS", "LIKE_NEW", 18000, "Shutter count under 5k. Two batteries, charger and a 64GB card.", "A drone or a laptop", ["ELECTRONICS", "GAMING"]],
    ],
  },
  {
    slug: "marco",
    name: "Marco Dizon",
    city: "Mandaue City",
    dob: "1995-09-03",
    bio: "IT guy from Mandaue. Trading gadgets and gym stuff I don't use anymore.",
    verified: true,
    listings: [
      ["Basketball, Molten GG7X", "SPORTS", "GOOD", 95, "Official size 7, still has good grip. Indoor use only.", "Sports gear", ["SPORTS"]],
      ["Yoga mat and blocks set", "SPORTS", "LIKE_NEW", 240, "6mm mat, two foam blocks and a strap. Used twice.", "Dumbbells or a jump rope", ["SPORTS"]],
      ["Logitech MX Master 3 mouse", "ELECTRONICS", "LIKE_NEW", 480, "Graphite, USB-C, with the receiver. Barely used.", "Mechanical keyboard", ["ELECTRONICS"]],
      ["Ray-Ban Wayfarer sunglasses", "ACCESSORIES", "LIKE_NEW", 880, "Authentic, with case and cloth. No scratches on the lenses.", "Watch or a bag", ["ACCESSORIES", "BAGS"]],
      ["Makita cordless drill", "TOOLS", "GOOD", 1450, "18V, two batteries, charger and a bit set.", "Circular saw or garden tools", ["TOOLS"]],
      ["Samsung 24-inch monitor", "ELECTRONICS", "GOOD", 2450, "1080p IPS, HDMI cable included, no dead pixels.", "Keyboard or a desk", ["ELECTRONICS", "FURNITURE"]],
      ["Bluetooth speaker, JBL Flip 5", "ELECTRONICS", "GOOD", 3500, "Loud and waterproof, charges over USB-C. Box included.", "Headphones", ["ELECTRONICS", "MUSIC"]],
      ["PS4 Slim 500GB + 2 controllers", "GAMING", "GOOD", 8500, "Works perfectly, comes with GTA V and FIFA 21 discs.", "Nintendo Switch or a monitor", ["GAMING", "ELECTRONICS"]],
      ["Mountain bike, 27.5, Shimano gears", "BIKES", "GOOD", 11000, "Aluminium frame, hydraulic brakes, new tyres.", "Road bike or a laptop", ["BIKES", "ELECTRONICS"]],
      ["Refurbished ThinkPad T480", "ELECTRONICS", "GOOD", 14500, "i5, 16GB RAM, 512GB SSD, new battery. Runs Windows 11 smoothly.", "Camera or a phone", ["ELECTRONICS"]],
    ],
  },
  {
    slug: "kim",
    name: "Kim Abella",
    city: "Cebu City",
    dob: "2001-01-21",
    bio: "Student in Cebu City. Just joined, looking for books and art supplies.",
    verified: false,
    listings: [],
  },
  {
    slug: "paul",
    name: "Paul Rosales",
    city: "Talisay City",
    dob: "1999-06-30",
    bio: "New here. Into bikes and music.",
    verified: false,
    listings: [],
  },
]

const emailOf = (a: Account) => `${a.name.toLowerCase().replace(/[^a-z]+/g, ".")}@${DOMAIN}`
const userIdOf = (a: Account) => `${ID_PREFIX}u-${a.slug}`
const itemIdOf = (a: Account, i: number) => `${ID_PREFIX}i-${a.slug}-b${i + 1}`

const images = LISTING_IMAGES as Record<string, { url: string }>

function check() {
  for (const a of ACCOUNTS) {
    a.listings.forEach(([title, , , value], i) => {
      if (!images[title]?.url) throw new Error(`no photo for "${title}" in demo-listing-images.json`)
      if (bracketOf(value) !== i + 1) throw new Error(`"${title}" (${value}) is bracket ${bracketOf(value)}, expected ${i + 1}`)
    })
  }
}

async function assertNoForeignRows() {
  const rows = await prisma.user.findMany({
    where: { email: { in: ACCOUNTS.map(emailOf) } },
    select: { id: true, email: true },
  })
  const foreign = rows.filter((r) => !r.id.startsWith(ID_PREFIX))
  if (foreign.length) {
    throw new Error(`refusing: ${foreign.map((f) => `${f.email} = ${f.id}`).join(", ")} were not created by this script`)
  }
}

async function upsertUser(a: Account, passwordHash: string) {
  const shared = { name: a.name, location: a.city, bio: a.bio, dateOfBirth: new Date(a.dob) }
  const existed = !!(await prisma.user.findUnique({ where: { email: emailOf(a) }, select: { id: true } }))
  await prisma.user.upsert({
    where: { email: emailOf(a) },
    create: {
      id: userIdOf(a),
      email: emailOf(a),
      ...shared,
      password: passwordHash,
      // Unverified at first; markVerified() below flips it and pays the
      // welcome points exactly as a real verification would.
      isVerified: false,
      signupGrantClaimed: false,
      idVerifiedGrandfatheredAt: a.verified ? new Date() : null,
      createdAt: daysAgo(a.verified ? 30 : 3),
    },
    update: { ...shared, ...(a.verified ? { idVerifiedGrandfatheredAt: new Date() } : {}) },
  })
  return existed
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

async function upsertItem(a: Account, i: number, hubIds: string[]) {
  const [title, category, condition, value, description, wanted, wantedCats] = a.listings[i]
  const id = itemIdOf(a, i)
  const existing = await prisma.item.findUnique({ where: { id }, select: { id: true } })
  if (existing) return "kept" as const

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
      userId: userIdOf(a),
      // Spread over the last two weeks, newest first in the feed.
      createdAt: hoursAgo(6 + i * 31 + (a.slug === "marco" ? 13 : 0)),
      safeZones: { create: hubs.map((hubId) => ({ hubId })) },
    },
  })
  return "created" as const
}

async function apply() {
  check()
  await assertNoForeignRows()
  const passwordHash = await bcrypt.hash(PASSWORD, BCRYPT_ROUNDS)
  const tally = { created: 0, kept: 0 }
  let newAccounts = 0

  for (const a of ACCOUNTS) {
    if (!(await upsertUser(a, passwordHash))) newAccounts++
    if (a.verified) {
      const r = await markVerified(userIdOf(a))
      await ensurePremium(userIdOf(a))
      const hubIds = await hubsFor(a.city)
      for (let i = 0; i < a.listings.length; i++) tally[await upsertItem(a, i, hubIds)]++
      console.log(`  ${emailOf(a).padEnd(38)} verified (+${r.grantAwarded + r.taskAwarded} points this run), Premium, ${a.listings.length} listings, ${hubIds.length} hub(s) to pick from`)
    } else {
      console.log(`  ${emailOf(a).padEnd(38)} not verified`)
    }
  }
  console.log(`  listings: ${tally.created} created, ${tally.kept} already present`)
  if (newAccounts === ACCOUNTS.length) writeCredentials()
  else if (newAccounts > 0) {
    console.log(`\n  ${newAccounts} account(s) were new and got the password ${PASSWORD}; the others kept theirs.`)
  } else {
    console.log("\n  all accounts already existed: passwords unchanged (see backups/defense-accounts.txt from the first run)")
  }
}

function writeCredentials() {
  const lines = [
    `Baylo defense accounts -- written ${new Date().toISOString()} by scripts/seed-defense-accounts.ts`,
    `Password for every account: ${PASSWORD}`,
    ``,
    ...ACCOUNTS.map(
      (a) =>
        `${emailOf(a).padEnd(38)} ${a.name.padEnd(20)} ${a.verified ? "email + ID verified, Premium, listings in brackets 1-10" : "NOT verified"}`,
    ),
  ]
  const text = lines.join("\n") + "\n"
  mkdirSync(dirname(CREDENTIALS_FILE), { recursive: true })
  writeFileSync(CREDENTIALS_FILE, text)
  console.log("\n" + text)
  console.log(`  saved to ${CREDENTIALS_FILE}`)
}

async function remove() {
  const users = await prisma.user.findMany({
    where: { id: { startsWith: ID_PREFIX }, email: { endsWith: `@${DOMAIN}` } },
    select: {
      id: true,
      email: true,
      _count: { select: { sentTrades: true, receivedTrades: true, sentMessages: true, receivedMessages: true } },
    },
  })
  if (!users.length) return console.log("  nothing to remove")
  for (const u of users) {
    const activity = Object.values(u._count).reduce((s, n) => s + n, 0)
    // A trade or chat with a real user is state on THEIR side too; a cascade
    // would take it. Leave those for a person to decide. Ledger rows (the
    // welcome points) go with the account, which keeps the balance sums equal.
    if (activity > 0) {
      console.log(`  KEPT ${u.email} (${activity} trade/message rows)`)
      continue
    }
    await prisma.user.delete({ where: { id: u.id } })
    console.log(`  deleted ${u.email}, with its listings`)
  }
}

async function main() {
  requireScratchSchema("scripts/seed-defense-accounts.ts")
  const removing = process.argv.includes("--remove")
  console.log(removing ? "\nRemoving the defense accounts" : "\nSeeding the defense accounts")
  if (removing) await remove()
  else await apply()
  const live = await prisma.item.count({ where: { id: { startsWith: ID_PREFIX }, status: "AVAILABLE" } })
  console.log(`\n  ${live} defense listing(s) AVAILABLE\n`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
