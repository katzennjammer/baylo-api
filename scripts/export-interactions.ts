// Export who-engaged-with-what, anonymised, to train the recommender (29 Nov 2026).
//
//   npx tsx --tsconfig tsconfig.json --env-file=.env scripts/export-interactions.ts
//
// READ-ONLY. Writes two files next to the repo root:
//   ml-data/interactions.csv  user, item, kind (like/comment/offer/trade), when
//   ml-data/listings.csv      item, owner, category, bracket, created, status
//
// ANONYMISED: every user id becomes a random-salted hash that is different on
// every run (the salt is never written down), so the files cannot be joined
// back to accounts, and they carry no names, emails, messages, comment text or
// locations. Listing ids are kept (they are public in listing links) so the
// listing photos already exported in items.csv can be matched up.

import { randomBytes, createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import prisma from "../src/lib/prisma"
import { bracketOf } from "../src/lib/brackets"

const DIR = resolve(__dirname, "../ml-data")
const salt = randomBytes(16)
const anon = (id: string) => createHash("sha256").update(salt).update(id).digest("hex").slice(0, 16)
const csv = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const DEMO_PREFIXES = ["demo-", "def-", "defb-", "seed-"]

async function main() {
  const [likes, comments, offers, trades, items] = await Promise.all([
    prisma.like.findMany({ select: { userId: true, postId: true, createdAt: true } }),
    prisma.comment.findMany({ select: { userId: true, postId: true, createdAt: true } }),
    prisma.trade.findMany({ where: { offerStatus: { not: null } }, select: { senderId: true, requestedItemId: true, createdAt: true } }),
    prisma.trade.findMany({
      where: { status: "COMPLETED" },
      select: { senderId: true, receiverId: true, offeredItemId: true, requestedItemId: true, completedAt: true, tradeCreatedAt: true },
    }),
    prisma.item.findMany({ select: { id: true, userId: true, category: true, valueLeaves: true, createdAt: true, status: true, isPerishable: true } }),
  ])

  const rows: string[] = ["user,item,kind,at"]
  for (const l of likes) rows.push([anon(l.userId), l.postId, "like", l.createdAt.toISOString()].map(csv).join(","))
  for (const c of comments) rows.push([anon(c.userId), c.postId, "comment", c.createdAt.toISOString()].map(csv).join(","))
  for (const o of offers) rows.push([anon(o.senderId), o.requestedItemId, "offer", o.createdAt.toISOString()].map(csv).join(","))
  for (const t of trades) {
    const at = (t.completedAt ?? t.tradeCreatedAt ?? new Date()).toISOString()
    // Each side RECEIVED the other's item: that is what they wanted.
    rows.push([anon(t.senderId), t.requestedItemId, "trade", at].map(csv).join(","))
    if (t.offeredItemId) rows.push([anon(t.receiverId), t.offeredItemId, "trade", at].map(csv).join(","))
  }

  const listing: string[] = ["item,owner,category,bracket,created,status,is_perishable,is_demo"]
  for (const i of items) {
    listing.push([i.id, anon(i.userId), i.category, i.valueLeaves === null ? "" : bracketOf(i.valueLeaves), i.createdAt.toISOString(), i.status,
      i.isPerishable ? 1 : 0, DEMO_PREFIXES.some((p) => i.id.startsWith(p)) ? 1 : 0].map(csv).join(","))
  }

  mkdirSync(DIR, { recursive: true })
  writeFileSync(resolve(DIR, "interactions.csv"), rows.join("\n") + "\n")
  writeFileSync(resolve(DIR, "listings.csv"), listing.join("\n") + "\n")
  const users = new Set(rows.slice(1).map((r) => r.split(",")[0]))
  console.log(`\n${rows.length - 1} interactions by ${users.size} people on ${items.length} listings:`)
  console.log(`  likes ${likes.length}, comments ${comments.length}, offers ${offers.length}, completed trades ${trades.length}`)
  console.log(`-> ml-data/interactions.csv and ml-data/listings.csv. Upload both here.\n`)
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
