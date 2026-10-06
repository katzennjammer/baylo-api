/**
 * READ-ONLY. For one listing, who the CATEGORY_MATCH notifier would tell, by
 * which rule, who it actually told, and why everyone else was left out.
 *
 * Writes nothing, so no live-guard -- the documented exemption in
 * scripts/lib/live-guard.ts. It answers "should X have been notified about Y?"
 * without posting a test listing on live.
 *
 *   npx tsx --tsconfig tsconfig.json --env-file=.env scripts/check-category-match.ts <itemId>
 *
 * "Would notify NOW" is computed against today's data by the same functions the
 * create route calls (findPerishableMatches / findCategoryMatches), so it cannot
 * drift from them -- but listings and blocks may have changed since the post.
 * "Notified" is the CATEGORY_MATCH rows pointing at this listing; the unread
 * dedupe moves a row to a NEWER listing with the same sentence, so an old
 * listing can show fewer rows than were written for it.
 */
import prisma from "../src/lib/prisma"
import { activeSuspension, suspensionState } from "@/lib/moderation"
import { WANTED_CATEGORIES, wantedList } from "@/lib/wanted-categories"
import {
  MATCH_NOTIFY_CAP,
  PERISHABLE_MATCH_NOTIFY_CAP,
  findCategoryMatches,
  findPerishableMatches,
  matchMessage,
  perishableMatchMessage,
} from "../src/lib/category-match"

type Row = {
  ownerId: string
  email: string
  rule: string
  outcome: string
  message?: string
}

async function main() {
  const itemId = process.argv[2]
  if (!itemId) throw new Error("usage: check-category-match.ts <itemId>")

  const item = await prisma.item.findUnique({
    where: { id: itemId },
    select: {
      id: true, title: true, userId: true, category: true, wantedCategories: WANTED_CATEGORIES,
      isPerishable: true, tradeWithinHours: true, status: true, createdAt: true,
      user: { select: { email: true } },
    },
  })
  if (!item) throw new Error(`no listing ${itemId}`)
  const perishable = item.isPerishable
  const wants = wantedList(item.wantedCategories) as string[]
  const input = { itemId: item.id, authorUserId: item.userId, category: item.category as string, lookingForCategories: wants }

  console.log(`${item.id} "${item.title}" by ${item.user.email}`)
  console.log(`  ${perishable ? `PERISHABLE (${item.tradeWithinHours} h window)` : "standard"} [${item.status}] posted ${item.createdAt.toISOString()}`)
  console.log(`  category=${item.category} lookingFor=[${wants.join(",")}]`)
  console.log(
    perishable
      ? `  rule: (has) their listing's category in [${wants.join(",")}]  OR  (wants) their listing asks for ${item.category}; shops excluded; cap ${PERISHABLE_MATCH_NOTIFY_CAP}`
      : `  rule: (wants) their listing asks for ${item.category}; cap ${MATCH_NOTIFY_CAP}`,
  )

  // ── Who the notifier picks today, from the real functions ──────────────────
  const picked = new Map<string, { rule: string; message: string }>()
  if (perishable) {
    for (const m of await findPerishableMatches(prisma, input)) {
      picked.set(m.ownerId, { rule: m.reason, message: perishableMatchMessage(input.category, item.tradeWithinHours, m) })
    }
  } else {
    for (const m of await findCategoryMatches(prisma, input)) {
      picked.set(m.ownerId, { rule: m.mutual ? "wants (mutual)" : "wants", message: matchMessage(input.category, m.category, m.mutual) })
    }
  }

  // ── Every owner a rule COULD reach, with no recipient filters, to explain skips
  const candidates = await prisma.item.findMany({
    where: {
      id: { not: item.id },
      OR: [
        { wantedCategories: { some: { category: item.category } } },
        ...(perishable && wants.length > 0 ? [{ category: { in: wantedList(item.wantedCategories) } }] : []),
      ],
    },
    select: {
      userId: true, category: true, wantedCategories: WANTED_CATEGORIES, status: true, moderationHiddenAt: true,
      user: { select: { email: true, deletedAt: true, isOrgAccount: true, suspensions: activeSuspension() } },
    },
  })
  const blocks = await prisma.block.findMany({
    where: { OR: [{ blockerId: item.userId }, { blockedId: item.userId }] },
    select: { blockerId: true, blockedId: true },
  })
  const blocked = new Set(blocks.flatMap((b) => [b.blockerId, b.blockedId]).filter((u) => u !== item.userId))
  const sent = new Map(
    (await prisma.notification.findMany({
      where: { type: "CATEGORY_MATCH", entityId: item.id },
      select: { userId: true, createdAt: true, read: true },
    })).map((n) => [n.userId, n]),
  )

  const owners = new Map<string, typeof candidates>()
  for (const c of candidates) owners.set(c.userId, [...(owners.get(c.userId) ?? []), c])

  const now = new Date()
  const rows: Row[] = []
  for (const [ownerId, items] of owners) {
    const u = items[0].user
    const rules = new Set<string>()
    for (const c of items) {
      if (wantedList(c.wantedCategories).includes(item.category)) rules.add("wants")
      if (perishable && wants.includes(c.category as string)) rules.add("has")
    }
    const rule = rules.size === 2 ? "mutual" : [...rules][0]
    const live = items.filter((c) => c.status === "AVAILABLE" && c.moderationHiddenAt == null)
    const suspended = suspensionState(u).suspended

    let outcome: string
    const p = picked.get(ownerId)
    if (p) outcome = "WOULD NOTIFY"
    else if (ownerId === item.userId) outcome = "skip: the poster"
    else if (u.deletedAt) outcome = "skip: account deleted"
    else if (perishable && u.isOrgAccount) outcome = "skip: shop (its bell hides CATEGORY_MATCH)"
    else if (blocked.has(ownerId)) outcome = "skip: blocked (either way)"
    else if (suspended) outcome = "skip: suspended"
    else if (live.length === 0) outcome = `skip: no AVAILABLE, visible matching listing (${[...new Set(items.map((c) => c.status))].join(",")})`
    else outcome = "skip: cut by the cap"
    rows.push({ ownerId, email: u.email, rule: p?.rule ?? rule, outcome, message: p?.message })
  }

  // The notifier's own order: mutual, then has, then wants.
  const ruleRank = (r: Row) => ["mutual", "has", "wants"].findIndex((k) => r.rule.startsWith(k))
  const rank = (r: Row) => (r.outcome === "WOULD NOTIFY" ? 0 : 1)
  rows.sort((a, b) => rank(a) - rank(b) || ruleRank(a) - ruleRank(b) || a.email.localeCompare(b.email))

  const demo = (r: Row) => r.ownerId.startsWith("demo-")
  console.log(`\nowners any rule could reach: ${rows.length}   would notify now: ${picked.size}   rows pointing at this listing: ${sent.size}\n`)
  console.log("notified  outcome                                   rule     account")
  for (const r of rows) {
    const s = sent.get(r.ownerId)
    console.log(
      `${(s ? (s.read ? "yes/read" : "yes") : "-").padEnd(9)} ${r.outcome.padEnd(41)} ${r.rule.padEnd(8)} ${r.email}${demo(r) ? "  (demo)" : ""}`,
    )
  }
  const strays = [...sent.keys()].filter((u) => !owners.has(u))
  if (strays.length) console.log(`\nnotified but no longer reachable by any rule: ${strays.join(", ")}`)

  const samples = new Map<string, string>()
  for (const r of rows) if (r.message && !samples.has(r.rule)) samples.set(r.rule, r.message)
  if (samples.size) {
    console.log("\nmessage per rule:")
    for (const [rule, msg] of samples) console.log(`  ${rule.padEnd(8)} ${msg}`)
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
