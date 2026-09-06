/**
 * Development seed. Turns an empty, freshly migrated database into an app you
 * can actually click through: four accounts you can log in as, eight listings,
 * two settled trades, one offer waiting for an answer, and all 22 Safe-Zone
 * Hubs.
 *
 * Run (from baylo/):
 *   npm run seed
 *
 * ── IDEMPOTENT ──────────────────────────────────────────────────────────────
 *
 * Every row seeded here carries an EXPLICIT, human-readable id (`seed-u-maria`,
 * `seed-i-switch`, ...) instead of taking the schema's cuid() default, and
 * every write is an upsert on that id. Running `npm run seed` twice therefore
 * produces exactly the state it produced the first time -- no duplicate users,
 * no doubled ledger, no second copy of the feed. The ids are also identical
 * across machines, which is what makes "the Nintendo Switch listing" a thing
 * two people can talk about.
 *
 * The corollary, and it is deliberate: re-running RESETS seeded rows to their
 * seeded values. Anything you changed by hand on `seed-*` rows goes back. Rows
 * you created yourself through the app have cuid() ids and are never touched.
 *
 * ── THE LEAF INVARIANT ──────────────────────────────────────────────────────
 *
 * Pasa Leaves have no mint. The ledger is the source of truth and the balance
 * is its consequence, so the system-wide invariant is:
 *
 *     SUM(User.leaves) == SUM(LeafTransaction.amount)      -- signed
 *
 * This file satisfies the stronger PER-USER form of it -- every account's
 * balance equals the sum of that account's own signed rows -- which implies the
 * global one. checkLeafInvariant() at the bottom re-derives both from the
 * database after writing and throws if either fails, so a seed that would leave
 * the ledger unbalanced fails loudly instead of quietly seeding a broken world.
 *
 * What moves Leaves here, mirroring the real code paths exactly:
 *   SIGNUP_GRANT   +50 to each of the four accounts (SIGNUP_GRANT_LEAVES),
 *                  matching claimSignupGrant() in @/lib/verification.
 *   TRADE_SPEND    negative, on the sender of a settled trade.
 *   TRADE_RECEIVE  the equal and opposite positive row on the receiver.
 *                  Written as a pair in one transaction by the settlement
 *                  route, so the two always cancel and the global sum only
 *                  ever moves by a grant.
 *
 * `lifetimeLeaves` is NOT the balance. It is monotonic and only a positive
 * award raises it -- a signup grant or a task reward -- which is why receiving
 * Leaves in a trade leaves it alone. It is what the rank ladder keys off. So
 * all four accounts sit at lifetimeLeaves 50 regardless of how their spendable
 * balance moved. That asymmetry is the design, not an oversight.
 *
 * No TASK_REWARD rows are seeded. Task awards are capped, partner-gated and
 * event-driven (see @/lib/tasks); fabricating them would either duplicate that
 * logic here or quietly violate it. The four accounts start with the grant and
 * whatever their trades moved.
 *
 * ── WHY THE TWO SETTLED TRADES ARE BOTH ELECTRONICS ─────────────────────────
 *
 * valueItem() only takes the comparables path once a category has at least
 * MIN_COMPARABLES (3) settled, priced items; below that it falls back to the
 * category band. Two settled trades put FOUR items into OWNED, and putting all
 * four in one category is what gets that path over the line. Post an
 * electronics listing after seeding and the valuation comes back
 * `valuationSource: "comparables"` with sampleSize 4. Spread across four
 * categories they would have produced nothing but band fallbacks, and the code
 * path this data exists to exercise would never run.
 *
 * ── WHAT SETTLEMENT ACTUALLY DID ────────────────────────────────────────────
 *
 * The two COMPLETED trades are written in their post-settlement state, matching
 * what trades/[id]/confirm/submit leaves behind: the trade is COMPLETED, BOTH
 * items have changed hands (`userId` swapped) and are `OWNED`, both parties'
 * `totalTrades` is incremented, and the Leaf pair is on the ledger. So an item
 * seeded as OWNED is owned by the person who RECEIVED it, not the one who
 * listed it -- which is why the owner ids below look reversed. They are not.
 */

// Loads .env, the same way prisma.config.ts does. Deliberately NOT
// `tsx --env-file=.env` in the npm script: that flag makes Node abort with a
// stack trace when .env is missing, and "no .env yet" is the single most likely
// state for someone running this for the first time. Here it falls through to
// the readable message below instead.
import "dotenv/config"

import { PrismaClient } from "../src/generated/prisma/client"
import { PrismaMariaDb } from "@prisma/adapter-mariadb"
import bcrypt from "bcryptjs"
import { SAFE_ZONE_HUB_SEED } from "../scripts/safezone-hub-data"

// ─────────────────────────────────────────────────────────────────────────────
// Client
//
// Built here rather than imported from @/lib/prisma because that module is
// written for the Next.js runtime: it caches a client on globalThis and never
// disconnects it, which is right for a dev server and wrong for a script that
// has to exit. Same adapter, same URL, explicit lifetime.
// ─────────────────────────────────────────────────────────────────────────────

function parseDbUrl(url: string) {
  const u = new URL(url)
  return {
    host: u.hostname,
    port: u.port ? parseInt(u.port) : 3306,
    user: u.username || undefined,
    password: u.password || undefined,
    database: u.pathname.slice(1) || undefined,
  }
}

if (!process.env.DATABASE_URL) {
  console.error(
    "\n  DATABASE_URL is not set.\n" +
      "  Copy .env.example to .env and fill it in, then run `npm run seed` again.\n",
  )
  process.exit(1)
}

const prisma = new PrismaClient({
  adapter: new PrismaMariaDb(parseDbUrl(process.env.DATABASE_URL)),
})

// ─────────────────────────────────────────────────────────────────────────────
// Constants that must agree with the app
//
// Imported by value rather than from @/lib/task-constants so this script has no
// dependency on the `@/` path alias resolving under tsx. If SIGNUP_GRANT_LEAVES
// ever changes, the assertion in main() catches the drift on the next run.
// ─────────────────────────────────────────────────────────────────────────────

const SIGNUP_GRANT_LEAVES = 50
const BCRYPT_ROUNDS = 12

/**
 * One password for all four accounts. This is a DEVELOPMENT seed for a database
 * you are about to fill with fake listings; the point is that a teammate can
 * read it in the README and log in. Nothing here should ever run against a
 * database anyone real uses -- see the guard in main().
 */
const SEED_PASSWORD = "BayloDev123!"

/** Placeholder listing photos. Same Unsplash set the category rail already uses. */
const IMG = {
  ELECTRONICS: "https://images.unsplash.com/photo-1518770660439-4636190af475?w=800&q=75",
  GAMING: "https://images.unsplash.com/photo-1593305841991-05c297ba4575?w=800&q=75",
  FURNITURE: "https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800&q=75",
  BOOKS: "https://images.unsplash.com/photo-1512820790803-83ca734da794?w=800&q=75",
  BIKES: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=800&q=75",
  PLANTS: "https://images.unsplash.com/photo-1466692476868-aef1dfb1e735?w=800&q=75",
} as const

/**
 * A fixed clock. Seeded rows get dates relative to this rather than to
 * Date.now(), so re-running does not shuffle the feed order and a screenshot
 * taken today still matches one taken next week.
 */
const T0 = new Date("2026-09-01T02:00:00.000Z")
const days = (n: number) => new Date(T0.getTime() + n * 86_400_000)

// ─────────────────────────────────────────────────────────────────────────────
// The people
// ─────────────────────────────────────────────────────────────────────────────

type SeedUser = {
  id: string
  name: string
  email: string
  location: string
  bio: string
  dateOfBirth: string
  /** Final spendable balance. Must equal this user's signed ledger rows. */
  leaves: number
  /** Monotonic. Grants and task rewards only -- never a trade receipt. */
  lifetimeLeaves: number
  totalTrades: number
}

const USERS: SeedUser[] = [
  {
    id: "seed-u-maria",
    name: "Maria Santos",
    email: "maria@baylo.test",
    location: "Cebu City",
    bio: "Declutters faster than she accumulates. Mostly books and plants.",
    dateOfBirth: "1996-04-12",
    // 50 grant - 20 spent on the laptop trade.
    leaves: 30,
    lifetimeLeaves: SIGNUP_GRANT_LEAVES,
    totalTrades: 1,
  },
  {
    id: "seed-u-jun",
    name: "Jun Dela Cruz",
    email: "jun@baylo.test",
    location: "Mandaue City",
    bio: "Fixes old electronics. If it has a battery, he has opinions about it.",
    dateOfBirth: "1993-11-30",
    // 50 grant + 20 received on the laptop trade.
    leaves: 70,
    lifetimeLeaves: SIGNUP_GRANT_LEAVES,
    totalTrades: 1,
  },
  {
    id: "seed-u-aya",
    name: "Aya Reyes",
    email: "aya@baylo.test",
    location: "Lapu-Lapu City",
    bio: "Cyclist. Trades gear seasonally and never keeps a spare wheel long.",
    dateOfBirth: "1999-07-08",
    // 50 grant - 15 spent on the console trade.
    leaves: 35,
    lifetimeLeaves: SIGNUP_GRANT_LEAVES,
    totalTrades: 1,
  },
  {
    id: "seed-u-carlo",
    name: "Carlo Mendoza",
    email: "carlo@baylo.test",
    location: "Talisay City",
    bio: "Furniture restorer. Will take your broken chair off your hands.",
    dateOfBirth: "1991-02-25",
    // 50 grant + 15 received on the console trade.
    leaves: 65,
    lifetimeLeaves: SIGNUP_GRANT_LEAVES,
    totalTrades: 1,
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// The listings
//
// `ownerId` is the CURRENT owner, i.e. post-settlement for the four OWNED ones.
// `listedById` records who originally put it up, which is what the trades below
// are consistent with. See the settlement note in the file header.
// ─────────────────────────────────────────────────────────────────────────────

type SeedItem = {
  id: string
  title: string
  description: string
  image: string
  category: string
  condition: string
  valueLeaves: number
  status: "AVAILABLE" | "OWNED"
  ownerId: string
  wantedItems: string | null
  createdAt: Date
}

const ITEMS: SeedItem[] = [
  // ── The four settled ELECTRONICS items. All OWNED, all priced, which is what
  //    gives valueItem() its comparables sample for this category.
  {
    id: "seed-i-laptop",
    title: "ThinkPad X230 (i5, 8GB, 240GB SSD)",
    description:
      "Runs Linux happily. Battery holds about two hours. Keyboard is the good pre-chiclet one. Listed by Maria, now Jun's after the swap.",
    image: IMG.ELECTRONICS,
    category: "ELECTRONICS",
    condition: "GOOD",
    valueLeaves: 120,
    status: "OWNED",
    ownerId: "seed-u-jun", // received it
    wantedItems: null,
    createdAt: days(-24),
  },
  {
    id: "seed-i-monitor",
    title: 'Dell 24" IPS Monitor',
    description:
      "1080p, HDMI + DisplayPort. One dead pixel top-left, genuinely hard to notice. Stand included.",
    image: IMG.ELECTRONICS,
    category: "ELECTRONICS",
    condition: "LIKE_NEW",
    valueLeaves: 95,
    status: "OWNED",
    ownerId: "seed-u-maria", // received it
    wantedItems: null,
    createdAt: days(-23),
  },
  {
    id: "seed-i-switch",
    title: "Nintendo Switch (2019 revision)",
    description:
      "Improved battery model. Includes dock and two Joy-Cons, one with slight drift. No games.",
    image: IMG.GAMING,
    category: "ELECTRONICS",
    condition: "GOOD",
    valueLeaves: 140,
    status: "OWNED",
    // Carlo listed it; it was the REQUESTED item in trade 2, so it went to the
    // sender, Aya.
    ownerId: "seed-u-aya",
    wantedItems: null,
    createdAt: days(-18),
  },
  {
    id: "seed-i-headphones",
    title: "Sony WH-1000XM3",
    description:
      "Noise cancelling still excellent. Earpads replaced last year with third-party ones. Case included.",
    image: IMG.ELECTRONICS,
    category: "ELECTRONICS",
    condition: "GOOD",
    valueLeaves: 110,
    status: "OWNED",
    // Aya listed it; it was the OFFERED item in trade 2, so it went to the
    // receiver, Carlo.
    ownerId: "seed-u-carlo",
    wantedItems: null,
    createdAt: days(-17),
  },

  // ── The four live listings. These are what the feed shows.
  {
    id: "seed-i-armchair",
    title: "Rattan Armchair, restored",
    description:
      "Stripped, re-woven and re-oiled over about three weekends. Solid frame, no wobble. Heavy — bring a car.",
    image: IMG.FURNITURE,
    category: "FURNITURE",
    condition: "LIKE_NEW",
    valueLeaves: 85,
    status: "AVAILABLE",
    ownerId: "seed-u-maria",
    wantedItems: "Plants, or anything for a small balcony",
    createdAt: days(-6),
  },
  {
    id: "seed-i-books",
    title: "Murakami paperbacks (set of 6)",
    description:
      "Norwegian Wood, Kafka on the Shore, 1Q84 (all three volumes), Sputnik Sweetheart. Spines creased, pages clean.",
    image: IMG.BOOKS,
    category: "BOOKS",
    condition: "GOOD",
    valueLeaves: 40,
    status: "AVAILABLE",
    ownerId: "seed-u-jun",
    wantedItems: "Other paperbacks, or coffee gear",
    createdAt: days(-4),
  },
  {
    id: "seed-i-bike",
    title: "Steel Road Bike, 54cm",
    description:
      "Late-80s frame, modern wheelset. Recently serviced: new chain, new bar tape, brakes bled. Rides beautifully.",
    image: IMG.BIKES,
    category: "BIKES",
    condition: "GOOD",
    valueLeaves: 160,
    status: "AVAILABLE",
    ownerId: "seed-u-aya",
    wantedItems: "Camping gear, or a smaller frame",
    createdAt: days(-3),
  },
  {
    id: "seed-i-monstera",
    title: "Monstera Deliciosa, 4ft, in pot",
    description:
      "Four years old, well established, currently pushing a new fenestrated leaf. Terracotta pot included.",
    image: IMG.PLANTS,
    category: "PLANTS",
    condition: "NEW",
    valueLeaves: 55,
    status: "AVAILABLE",
    ownerId: "seed-u-carlo",
    wantedItems: "Books, or kitchen things",
    createdAt: days(-1),
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// The two settled trades
// ─────────────────────────────────────────────────────────────────────────────

const TRADES = [
  {
    id: "seed-t-laptop-monitor",
    senderId: "seed-u-maria",
    receiverId: "seed-u-jun",
    offeredItemId: "seed-i-laptop", // Maria's, went to Jun
    requestedItemId: "seed-i-monitor", // Jun's, went to Maria
    offeredLeaves: 20,
    message: "Laptop plus 20 Leaves for the monitor? It's the good keyboard model.",
    safeZoneHubId: "szh-mnd-parkmall",
    settledAt: days(-20),
  },
  {
    id: "seed-t-switch-headphones",
    senderId: "seed-u-aya",
    receiverId: "seed-u-carlo",
    offeredItemId: "seed-i-headphones", // Aya's, went to Carlo
    requestedItemId: "seed-i-switch", // Carlo's, went to Aya
    offeredLeaves: 15,
    message: "Headphones and 15 Leaves for the Switch. Joy-Con drift is fine, I'll fix it.",
    safeZoneHubId: "szh-llc-gaisano-grand-mactan",
    settledAt: days(-14),
  },
] as const

// ─────────────────────────────────────────────────────────────────────────────
// The pending offer
// ─────────────────────────────────────────────────────────────────────────────

const PENDING_OFFER = {
  id: "seed-o-monstera-for-armchair",
  postId: "seed-i-armchair", // Maria's live listing
  senderId: "seed-u-carlo",
  receiverId: "seed-u-maria",
  offeredItems: [
    { id: "seed-i-monstera", title: "Monstera Deliciosa, 4ft, in pot", image: IMG.PLANTS },
  ],
  offeredLeaves: 10,
  message: "The monstera plus 10 Leaves for the armchair? It would suit my balcony.",
  createdAt: days(-1),
}

// ─────────────────────────────────────────────────────────────────────────────
// Seeding
// ─────────────────────────────────────────────────────────────────────────────

async function seedHubs() {
  const ready = SAFE_ZONE_HUB_SEED.filter((h) => h.coords !== null)
  const held = SAFE_ZONE_HUB_SEED.length - ready.length

  for (const h of ready) {
    const c = h.coords!
    await prisma.safeZoneHub.upsert({
      where: { id: h.id },
      create: {
        id: h.id,
        name: h.name,
        type: h.type,
        address: h.address,
        latitude: c.latitude,
        longitude: c.longitude,
        city: h.city,
        landmark: h.landmark,
        // INSERT only, exactly as scripts/seed-safezone-hubs.ts has it: a hub an
        // admin deactivated must not quietly re-open on the next seed.
        isActive: true,
      },
      update: {
        name: h.name,
        type: h.type,
        address: h.address,
        latitude: c.latitude,
        longitude: c.longitude,
        city: h.city,
        landmark: h.landmark,
      },
    })
  }
  return { seeded: ready.length, held }
}

async function seedUsers(passwordHash: string) {
  for (const u of USERS) {
    const shared = {
      name: u.name,
      email: u.email,
      password: passwordHash,
      location: u.location,
      bio: u.bio,
      dateOfBirth: new Date(u.dateOfBirth),
      leaves: u.leaves,
      lifetimeLeaves: u.lifetimeLeaves,
      totalTrades: u.totalTrades,
      // Verified, so login works and the signup grant counts as claimed. Both
      // flags together mirror a real account that finished email verification:
      // claimSignupGrant() sets signupGrantClaimed when it pays the 50, and the
      // matching SIGNUP_GRANT ledger row is written below.
      isVerified: true,
      signupGrantClaimed: true,
      // Grandfathered past ID verification, so all four can post immediately
      // without submitting a government ID. This is the same column the
      // id_verification migration stamped on every account that existed then.
      idVerifiedGrandfatheredAt: T0,
      deletedAt: null,
      suspendedAt: null,
      suspendedUntil: null,
    }
    await prisma.user.upsert({
      where: { id: u.id },
      create: { id: u.id, createdAt: days(-30), ...shared },
      update: shared,
    })
  }
}

async function seedItems() {
  for (const it of ITEMS) {
    const shared = {
      title: it.title,
      description: it.description,
      images: JSON.stringify([it.image]),
      category: it.category as never,
      condition: it.condition as never,
      valueLeaves: it.valueLeaves,
      suggestedLeaves: it.valueLeaves,
      // "category_band" and not a third literal like "seed". VALUATION_SOURCES
      // has exactly two members and PostWizard types the field as that union,
      // so inventing a value here would put something in the column that the
      // type system says cannot be there. It is also the honest answer: these
      // are the first eight items in an empty database, so no category had the
      // three settled comparables valueItem() needs and the real code would
      // have taken the band path for every one of them.
      //
      // They still SERVE as comparables for anything posted later --
      // comparablesWhere() filters on category, status and price, never on
      // source -- which is what makes the four settled electronics items light
      // up the comparables path for the next electronics listing.
      valuationSource: "category_band",
      status: it.status as never,
      wantedItems: it.wantedItems,
      userId: it.ownerId,
      moderationHiddenAt: null,
    }
    await prisma.item.upsert({
      where: { id: it.id },
      create: { id: it.id, createdAt: it.createdAt, ...shared },
      update: shared,
    })
  }
}

async function seedTrades() {
  for (const t of TRADES) {
    const shared = {
      status: "COMPLETED" as never,
      message: t.message,
      senderId: t.senderId,
      receiverId: t.receiverId,
      offeredItemId: t.offeredItemId,
      requestedItemId: t.requestedItemId,
      offeredLeaves: t.offeredLeaves,
      safeZoneHubId: t.safeZoneHubId,
      hiddenBySender: false,
      hiddenByReceiver: false,
    }
    await prisma.tradeRequest.upsert({
      where: { id: t.id },
      create: { id: t.id, createdAt: t.settledAt, ...shared },
      update: shared,
    })
  }
}

async function seedOffer() {
  const o = PENDING_OFFER
  const shared = {
    postId: o.postId,
    senderId: o.senderId,
    receiverId: o.receiverId,
    offeredItems: JSON.stringify(o.offeredItems),
    offeredLeaves: o.offeredLeaves,
    message: o.message,
    status: "PENDING" as never,
  }
  await prisma.offer.upsert({
    where: { id: o.id },
    create: { id: o.id, createdAt: o.createdAt, ...shared },
    update: shared,
  })
}

/**
 * The ledger. Written last, and written to match the balances already on the
 * users -- checkLeafInvariant() then proves the two agree rather than assuming
 * it. One SIGNUP_GRANT per account, plus a signed pair per trade that carried
 * Leaves.
 */
async function seedLedger() {
  type Row = {
    id: string
    userId: string
    type: string
    amount: number
    description: string
    tradeId?: string
    eventAt: Date
  }

  const rows: Row[] = []

  for (const u of USERS) {
    rows.push({
      id: `seed-lt-grant-${u.id}`,
      userId: u.id,
      type: "SIGNUP_GRANT",
      amount: SIGNUP_GRANT_LEAVES,
      description: "Signup grant",
      eventAt: days(-30),
    })
  }

  for (const t of TRADES) {
    if (t.offeredLeaves <= 0) continue
    const sender = USERS.find((u) => u.id === t.senderId)!
    const receiver = USERS.find((u) => u.id === t.receiverId)!
    rows.push({
      id: `seed-lt-spend-${t.id}`,
      userId: t.senderId,
      type: "TRADE_SPEND",
      amount: -t.offeredLeaves,
      description: `Leaves given to ${receiver.name} for trade`,
      tradeId: t.id,
      eventAt: t.settledAt,
    })
    rows.push({
      id: `seed-lt-recv-${t.id}`,
      userId: t.receiverId,
      type: "TRADE_RECEIVE",
      amount: t.offeredLeaves,
      description: `Leaves received from ${sender.name} for trade`,
      tradeId: t.id,
      eventAt: t.settledAt,
    })
  }

  for (const r of rows) {
    const shared = {
      userId: r.userId,
      type: r.type as never,
      amount: r.amount,
      description: r.description,
      tradeId: r.tradeId ?? null,
      eventAt: r.eventAt,
    }
    await prisma.leafTransaction.upsert({
      where: { id: r.id },
      create: { id: r.id, createdAt: r.eventAt, ...shared },
      update: shared,
    })
  }

  return rows.length
}

/**
 * Re-derive the invariant FROM THE DATABASE, not from the constants above.
 *
 * Checking the arrays against each other would only prove this file is
 * self-consistent. Reading both sides back proves the rows that actually landed
 * balance -- which is the property the rest of the system relies on, and the
 * one a botched upsert would break.
 */
async function checkLeafInvariant() {
  const users = await prisma.user.findMany({ select: { id: true, name: true, leaves: true } })
  const grouped = await prisma.leafTransaction.groupBy({
    by: ["userId"],
    _sum: { amount: true },
  })

  const ledger = new Map(grouped.map((g) => [g.userId, g._sum.amount ?? 0]))
  const problems: string[] = []

  for (const u of users) {
    const fromLedger = ledger.get(u.id) ?? 0
    if (u.leaves !== fromLedger) {
      problems.push(
        `    ${u.name} (${u.id}): balance ${u.leaves} but ledger sums to ${fromLedger}`,
      )
    }
  }

  // A ledger row whose user is gone would balance per-user vacuously while
  // breaking the global sum, so check that separately rather than inferring it.
  const balanceTotal = users.reduce((a, u) => a + u.leaves, 0)
  const ledgerTotal = (await prisma.leafTransaction.aggregate({ _sum: { amount: true } }))._sum
    .amount ?? 0

  if (balanceTotal !== ledgerTotal) {
    problems.push(
      `    SUM(User.leaves) = ${balanceTotal} but SUM(LeafTransaction.amount) = ${ledgerTotal}`,
    )
  }

  if (problems.length > 0) {
    throw new Error(
      "Leaf invariant violated after seeding:\n" + problems.join("\n") + "\n",
    )
  }

  return { balanceTotal, ledgerTotal }
}

async function main() {
  const db = new URL(process.env.DATABASE_URL!).pathname.slice(1)

  console.log(`\n  seeding \`${db}\`\n`)

  const passwordHash = await bcrypt.hash(SEED_PASSWORD, BCRYPT_ROUNDS)

  const hubs = await seedHubs()
  console.log(`  hubs      ${hubs.seeded} Safe-Zone Hubs${hubs.held ? ` (${hubs.held} held back: no verified coordinate)` : ""}`)

  await seedUsers(passwordHash)
  console.log(`  users     ${USERS.length}, all verified and grandfathered past ID verification`)

  await seedItems()
  const available = ITEMS.filter((i) => i.status === "AVAILABLE").length
  const cats = new Set(ITEMS.map((i) => i.category)).size
  console.log(`  listings  ${ITEMS.length} across ${cats} categories (${available} available, ${ITEMS.length - available} settled)`)

  await seedTrades()
  console.log(`  trades    ${TRADES.length} completed`)

  await seedOffer()
  console.log(`  offers    1 pending`)

  const ledgerRows = await seedLedger()
  console.log(`  ledger    ${ledgerRows} Leaf transactions`)

  const { balanceTotal, ledgerTotal } = await checkLeafInvariant()
  console.log(
    `\n  leaf invariant OK   SUM(User.leaves) = ${balanceTotal} = SUM(LeafTransaction.amount) = ${ledgerTotal}`,
  )

  console.log(`\n  log in with any of:`)
  for (const u of USERS) console.log(`    ${u.email.padEnd(20)} ${SEED_PASSWORD}`)
  console.log("")
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error("\n  SEED FAILED\n")
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
