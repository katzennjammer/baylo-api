/**
 * Put the seeded perishables back on sale with live countdowns, for a demo.
 *
 *   npx tsx --tsconfig tsconfig.json --env-file=.env scripts/refresh-demo-perishables.ts --dry-run
 *   npx tsx --tsconfig tsconfig.json --env-file=.env scripts/refresh-demo-perishables.ts --apply [--live]
 *   ... add --clear-expiry-notices to either to also delete the stale expiry notices
 *
 * Neither flag -> usage and exit. --dry-run reads only. --apply writes, and on
 * the live schema it ALSO needs --live (scripts/lib/live-guard.ts). Take a
 * backup first (scripts/backup-baylo-pg.ps1).
 *
 * ── THERE IS NO expiresAt COLUMN ────────────────────────────────────────────
 *
 * A perishable's deadline is `createdAt + tradeWithinHours`, derived on every
 * read (expiresAt() in @/lib/perishable, the sweep, v1/item, the phone). So
 * "a fresh expiresAt" means a new `createdAt`. `tradeWithinHours` stays what
 * the seed gave it (6 or 24) -- that is the listing's stated window, and the
 * wizard only offers those two. To land a row N hours from its end, createdAt
 * becomes `now - (tradeWithinHours - N)`.
 *
 * ── WHAT IT WRITES: TWO COLUMNS ON Item, AND OPTIONALLY OLD NOTICES ─────────
 *
 * `status` (EXPIRED -> AVAILABLE) and `createdAt`, plus Prisma's own
 * `updatedAt`. No Leaves, ledger, offers, trades or stories. The run proves
 * that: it counts those tables (and the ledger invariant) before and after and
 * exits 1 if any moved.
 *
 * Notifications are untouched unless --clear-expiry-notices is passed. Then,
 * in the same transaction, it deletes the LISTING_EXPIRED rows whose listing is
 * one of the rows refreshed here AND whose recipient is that listing's seed/demo
 * owner -- matched as (userId, entityId) pairs, no other type. Those notices say
 * "expired unsold" beside a live listing, and their Relist would post a
 * duplicate. The only count allowed to move is that one, by exactly that many.
 * When a restored row lapses again the app's own sweep sends a fresh notice.
 *
 * ── WHAT IT SKIPS ───────────────────────────────────────────────────────────
 *
 * Only perishables owned by @baylo.test / @baylo-demo.test accounts are even
 * selected. Of those it skips, and reports: a moderation-hidden row; any status
 * other than EXPIRED / AVAILABLE (IN_TRADE, TRADED, REMOVED, in review...);
 * a row with ANY offer on it or ANY trade request naming it, whatever the
 * status (an old completed trade is history a fresh countdown would contradict);
 * a row named in another offer's offeredItems; a row with a live story.
 *
 * Re-runnable: an AVAILABLE row is refreshed too, so running it again just
 * before a demo resets every clock.
 */
import prisma from "../src/lib/prisma"
import { requireScratchSchema, targetSchema } from "./lib/live-guard"
import { ledgerInvariant } from "./lib/ledger-invariant"

const SEED_DOMAINS = ["@baylo.test", "@baylo-demo.test"]
const H = 3_600_000

/**
 * The mix, as hours LEFT. Deterministic by id order, so the dry run shows
 * exactly the plan the apply writes (shifted only by the clock between them).
 *
 *   6h rows : first 4 end in 15-50 min; the rest spread over 2-5.75 h
 *   24h rows: first 4 end in 20-55 min; next 6 spread over 3-6 h;
 *             the rest spread over 10-23.5 h
 */
function plannedHoursLeft(window: number, k: number, n: number): number {
  const spread = (lo: number, hi: number, i: number, count: number) =>
    count <= 1 ? lo : lo + ((hi - lo) * i) / (count - 1)
  if (window === 6) {
    if (k < 4) return spread(15 / 60, 50 / 60, k, Math.min(4, n))
    return spread(2, 5.75, k - 4, n - 4)
  }
  if (k < 4) return spread(20 / 60, 55 / 60, k, Math.min(4, n))
  if (k < 10) return spread(3, 6, k - 4, Math.min(6, n - 4))
  return spread(10, Math.min(23.5, window - 0.5), k - 10, n - 10)
}

const fmtLeft = (ms: number) => {
  if (ms <= 0) return "ended"
  const m = Math.round(ms / 60_000)
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`
}
const iso = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ") + "Z"

/**
 * Scoped to these items and their owners, so a real user's activity during the
 * run cannot read as a side effect. The ledger invariant is global.
 */
/** The stale expiry notices for these listings, sent to their owners only. */
const expiryNoticeWhere = (rows: { id: string; userId: string }[]) => ({
  type: "LISTING_EXPIRED" as const,
  OR: rows.map((r) => ({ userId: r.userId, entityId: r.id })),
})

async function sideTables(itemIds: string[], ownerIds: string[]) {
  const [offers, trades, stories, notifications, ledger] = await Promise.all([
    // Offers and trades are one Trade row per deal since schema v2: an offer is
    // a row with an offer phase, a trade one with a trade phase.
    prisma.trade.count({ where: { offerStatus: { not: null }, OR: [{ requestedItemId: { in: itemIds } }, { senderId: { in: ownerIds } }, { receiverId: { in: ownerIds } }] } }),
    prisma.trade.count({ where: { status: { not: null }, OR: [{ offeredItemId: { in: itemIds } }, { requestedItemId: { in: itemIds } }] } }),
    prisma.story.count({ where: { itemId: { in: itemIds } } }),
    prisma.notification.count({ where: { userId: { in: ownerIds } } }),
    ledgerInvariant(prisma),
  ])
  return { offers, trades, stories, notifications, ledgerOk: ledger.ok, ledger: ledger.lines.join(" / ") }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run")
  const apply = process.argv.includes("--apply")
  const clearNotices = process.argv.includes("--clear-expiry-notices")
  if (dryRun === apply) {
    console.error("  usage: refresh-demo-perishables.ts --dry-run | --apply [--live]  [--clear-expiry-notices]")
    process.exit(1)
  }
  if (apply) requireScratchSchema("scripts/refresh-demo-perishables.ts --apply")
  console.log(`  mode: ${dryRun ? "DRY RUN (no writes)" : "APPLY"}   schema: ${targetSchema()}   clear expiry notices: ${clearNotices}\n`)

  const now = new Date()
  const items = await prisma.item.findMany({
    where: { isPerishable: true, user: { OR: SEED_DOMAINS.map((d) => ({ email: { endsWith: d } })) } },
    orderBy: { id: "asc" },
    select: {
      id: true, title: true, status: true, createdAt: true, tradeWithinHours: true, moderationHiddenAt: true,
      userId: true,
      user: { select: { email: true } },
      // Every deal row naming this listing, either side (schema v2).
      tradesRequested: { select: { offerStatus: true, status: true } },
      tradesOffered: { select: { offerStatus: true, status: true } },
      stories: { where: { deletedAt: null, expiresAt: { gt: now } }, select: { id: true } },
    },
  })

  // The offered item is a real relation since schema v2 (it was a JSON list).
  const offersOn = (it: (typeof items)[number]) => it.tradesRequested.filter((t) => t.offerStatus !== null).length
  const inTrade = (it: (typeof items)[number]) =>
    [...it.tradesRequested, ...it.tradesOffered].some((t) => t.status !== null)
  const namedInOffer = (it: (typeof items)[number]) => it.tradesOffered.some((t) => t.offerStatus !== null)

  const skipped: { id: string; title: string; why: string }[] = []
  const eligible: typeof items = []
  for (const it of items) {
    const why =
      it.moderationHiddenAt ? "moderation-hidden"
      : it.status !== "EXPIRED" && it.status !== "AVAILABLE" ? `status ${it.status}`
      : it.tradeWithinHours == null ? "no tradeWithinHours"
      : offersOn(it) > 0 ? `${offersOn(it)} offer(s) on it`
      : inTrade(it) ? "named in a trade request"
      : namedInOffer(it) ? "named in another offer"
      : it.stories.length > 0 ? "has a live story"
      : null
    if (why) skipped.push({ id: it.id, title: it.title, why })
    else eligible.push(it)
  }

  // Plan per window group, in id order.
  const plan = new Map<string, Date>()
  for (const w of [...new Set(eligible.map((e) => e.tradeWithinHours!))]) {
    const group = eligible.filter((e) => e.tradeWithinHours === w)
    group.forEach((e, k) => {
      const left = plannedHoursLeft(w, k, group.length)
      plan.set(e.id, new Date(now.getTime() - (w - left) * H))
    })
  }

  console.log(`  selected ${items.length} seed/demo perishable(s); ${eligible.length} to refresh, ${skipped.length} skipped\n`)
  const row = (c: string[]) => console.log("  " + c.map((x, i) => x.padEnd([18, 30, 30, 4, 22, 9, 22, 22, 8][i])).join(" "))
  row(["id", "title", "owner", "win", "status before→after", "left was", "expiresAt before", "expiresAt after", "left now"])
  for (const e of eligible) {
    const w = e.tradeWithinHours!
    const oldEnd = new Date(e.createdAt.getTime() + w * H)
    const newEnd = new Date(plan.get(e.id)!.getTime() + w * H)
    row([
      e.id, e.title.slice(0, 29), e.user.email.slice(0, 29), `${w}h`,
      `${e.status}→AVAILABLE`, fmtLeft(oldEnd.getTime() - now.getTime()),
      iso(oldEnd), iso(newEnd), fmtLeft(newEnd.getTime() - now.getTime()),
    ])
  }
  const bands = { "<1h": 0, "1-6h": 0, "6-24h": 0 }
  for (const e of eligible) {
    const left = (plan.get(e.id)!.getTime() + e.tradeWithinHours! * H - now.getTime()) / H
    bands[left < 1 ? "<1h" : left <= 6 ? "1-6h" : "6-24h"]++
  }
  console.log(`\n  mix: ${JSON.stringify(bands)}`)
  if (skipped.length) {
    console.log("\n  skipped:")
    for (const s of skipped) console.log(`    ${s.id}  ${JSON.stringify(s.title)}  -- ${s.why}`)
  }

  const scope: [string[], string[]] = [eligible.map((e) => e.id), [...new Set(eligible.map((e) => e.userId))]]
  const noticeCount = clearNotices && eligible.length
    ? await prisma.notification.count({ where: expiryNoticeWhere(eligible) })
    : 0
  if (clearNotices) console.log(`\n  LISTING_EXPIRED notices to delete: ${noticeCount}`)

  const before = await sideTables(...scope)
  console.log(`\n  side tables: ${JSON.stringify(before)}`)
  if (!before.ledgerOk) throw new Error("refusing: the ledger is already out of balance")

  if (dryRun) {
    console.log("\n  DRY RUN -- nothing written. Re-run with --apply (and --live on public) to write.")
    return
  }

  // Each write is conditional on the row still being what was planned against,
  // so a row that changed since the read (an offer, a sweep, a hide) is left alone.
  const { changed, deleted } = await prisma.$transaction(async (tx) => {
    let changed = 0
    for (const e of eligible) {
      const r = await tx.item.updateMany({
        where: {
          id: e.id, status: e.status, isPerishable: true, moderationHiddenAt: null,
          tradesOffered: { none: {} }, tradesRequested: { none: {} },
        },
        data: { status: "AVAILABLE", createdAt: plan.get(e.id)! },
      })
      changed += r.count
    }
    // All or nothing: a partial refresh would leave notices deleted for rows
    // that are still EXPIRED. Roll the lot back instead.
    if (changed !== eligible.length) throw new Error(`refusing: ${changed} of ${eligible.length} rows matched; rolled back`)
    const deleted = clearNotices
      ? (await tx.notification.deleteMany({ where: expiryNoticeWhere(eligible) })).count
      : 0
    if (deleted !== noticeCount) throw new Error(`refusing: would delete ${deleted} notices, planned ${noticeCount}; rolled back`)
    return { changed, deleted }
  }, { timeout: 60_000 })
  console.log(`\n  APPLIED: ${changed} of ${eligible.length} row(s) updated, ${deleted} LISTING_EXPIRED notice(s) deleted`)

  const after = await sideTables(...scope)
  console.log(`  side tables after: ${JSON.stringify(after)}`)
  const drift: string[] = (["offers", "trades", "stories", "ledger"] as const).filter((k) => before[k] !== after[k])
  if (after.notifications !== before.notifications - deleted) drift.push("notifications")
  if (drift.length || !after.ledgerOk) {
    console.error(`  SIDE EFFECT DETECTED in: ${drift.join(", ") || "ledger invariant"}`)
    process.exit(1)
  }
  console.log(`  no side effects: offers, trades, stories and the ledger unchanged; notifications moved by exactly -${deleted}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
