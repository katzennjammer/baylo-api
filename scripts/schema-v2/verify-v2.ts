// Verify a schema-v2 rehearsal: the OLD copy (<schema>_src) against the NEW
// one (<schema>), on the same server.
//
//   npx tsx --env-file=.env scripts/schema-v2/verify-v2.ts [--schema schema_v2_wk1]
//
// READ-ONLY, enforced by Postgres and proven at start. Until 5 Oct 2026 this
// asked for read-only with the startup option `-c default_transaction_read_only=on`,
// which the Supavisor session pooler silently drops, so the session was NOT
// read-only. (It only ever ran SELECTs, so nothing was harmed, but the claim
// was false.) Now the session sets the default explicitly and asserts it, the
// whole run is ONE `REPEATABLE READ READ ONLY` transaction (which also gives
// one consistent snapshot of both schemas), and a write probe must be refused
// before any check runs. Every table is also named "<schema>"."<Table>", so
// nothing resolves through the search_path (see the 23 Sep 2026 incident:
// unqualified raw SQL is how live data was lost). It never names `public`;
// both schemas must be schema_v2_*.
//
// What it proves, in order:
//   1  row counts per table and per merge, old vs new, with the EXPECTED
//      LOSSES from docs/schema-v2.md section 2c named and counted
//   2  every carried-over table is identical, row for row and column for
//      column, on the columns both sides have (EXCEPT both ways)
//   3  every foreign key is validated and has no orphan; every soft reference
//      (ledger tradeId, notification entityId, audit targetId, appeal actionId)
//      resolves, and the ones that by design do not are counted and named
//   4  the Leaves ledger: the three checks of scripts/lib/ledger-invariant.ts
//      on the new copy, and equal to the old copy's figures
//   5  Item.bracket equals bracketOf(valueLeaves) on every row
//   6  10 items, 10 trades and 10 users compared field by field
import { Client, types } from "pg"
import { bracketOf } from "../../src/lib/brackets"

for (const oid of [1082, 1114, 1083, 1184]) types.setTypeParser(oid, (v) => v)
types.setTypeParser(20, (v) => v)
types.setTypeParser(1700, (v) => v)

const i = process.argv.indexOf("--schema")
const NEW = i === -1 ? "schema_v2_wk1" : process.argv[i + 1]
const OLD = `${NEW}_src`
if (!/^schema_v2_[a-z0-9_]+$/.test(NEW)) { console.error(`refusing schema "${NEW}"`); process.exit(2) }

const o = (t: string) => `"${OLD}"."${t}"`
const n = (t: string) => `"${NEW}"."${t}"`

let failures = 0
const pass = (msg: string) => console.log(`  ok    ${msg}`)
const fail = (msg: string) => { failures++; console.log(`  FAIL  ${msg}`) }
const note = (msg: string) => console.log(`  note  ${msg}`)
const check = (ok: boolean, msg: string) => (ok ? pass(msg) : fail(msg))

function dbUrl(): string {
  const u = process.env.DATABASE_URL
  if (!u?.startsWith("postgres")) { console.error("DATABASE_URL is not a Postgres URL"); process.exit(2) }
  return u.replace(/([?&])schema=[^&]*&?/, "$1").replace(/[?&]$/, "")
}

async function main() {
  const pg = new Client({ connectionString: dbUrl() })
  await pg.connect()
  await pg.query(`SET SESSION default_transaction_read_only = on`)
  await pg.query(`BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`)
  {
    const ro = (await pg.query(`SELECT current_setting('transaction_read_only') AS t, current_setting('default_transaction_read_only') AS d`)).rows[0]
    if (ro.t !== "on" || ro.d !== "on") { console.error(`  REFUSING: the session is not read-only (transaction ${ro.t}, default ${ro.d})`); process.exit(1) }
    await pg.query(`SAVEPOINT ro_probe`)
    let refused = false
    try { await pg.query(`CREATE TEMP TABLE _verify_v2_ro_probe (x int)`) } catch (e) { refused = /read-only transaction/.test((e as Error).message) }
    await pg.query(`ROLLBACK TO SAVEPOINT ro_probe`)
    if (!refused) { console.error("  REFUSING: a write probe was NOT refused; this session is not read-only"); process.exit(1) }
    console.log(`  read-only: proven (a write probe was refused by Postgres)`)
  }
  const one = async (sql: string, params: unknown[] = []) => Number(Object.values((await pg.query(sql, params)).rows[0])[0])
  const rows = async (sql: string, params: unknown[] = []) => (await pg.query(sql, params)).rows

  for (const s of [OLD, NEW]) {
    if (!(await pg.query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [s])).rowCount) {
      console.error(`schema "${s}" does not exist -- run build-scratch.ts first`); process.exit(1)
    }
  }
  const newTables = (await rows(`SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename <> '_prisma_migrations' ORDER BY 1`, [NEW])).map((r) => r.tablename as string)
  const oldTables = (await rows(`SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename <> '_prisma_migrations' ORDER BY 1`, [OLD])).map((r) => r.tablename as string)
  const hasTable = (t: string) => newTables.includes(t)
  console.log(`\nschema v2 verification: "${OLD}" (${oldTables.length} tables) -> "${NEW}" (${newTables.length} tables)\n`)
  const ledgerShipped = !hasTable("TaskCompletion")
  const tradeShipped = hasTable("Trade")
  // 25 with everything; one more for each high-risk part held back (--skip).
  const expectTables = 25 + (ledgerShipped ? 0 : 1) + (tradeShipped ? 0 : 1)
  check(newTables.length === expectTables, `${expectTables} tables in the new schema${expectTables > 25 ? " (a high-risk part held back)" : ""} (${newTables.join(", ")})`)

  // ── 1. Counts ────────────────────────────────────────────────────────────
  console.log("\n1. Row counts, old -> new")
  const cnt = async (s: (t: string) => string, t: string, where = "") => one(`SELECT count(*) FROM ${s(t)} ${where}`)

  const same: [string, string][] = [
    ["User", "User"], ["Follow", "Follow"], ["Item", "Item"], ["Message", "Message"], ["Review", "Review"],
    ["Block", "Block"], ["IdVerification", "IdVerification"], ["AdminAction", "AdminAction"],
    ["SafeZoneHub", "SafeZoneHub"], ["ItemSafeZone", "ItemSafeZone"], ["Achievement", "Achievement"],
    ["Organization", "Organization"], ["Story", "Story"], ["StoryView", "StoryView"],
    ["SwapConfirmationCode", "SwapCode"], ["PostLike", "Like"], ["PostComment", "Comment"],
  ]
  for (const [a, b] of same) {
    const x = await cnt(o, a), y = await cnt(n, b)
    check(x === y, `${a}${a === b ? "" : ` -> ${b}`}: ${x} -> ${y}`)
  }

  {
    const rt = await cnt(o, "RefreshToken"), ev = await cnt(o, "EmailVerificationToken"), pr = await cnt(o, "PasswordResetToken")
    const prOk = await one(`SELECT count(*) FROM ${o("PasswordResetToken")} p WHERE EXISTS (SELECT 1 FROM ${o("User")} u WHERE u.email = p.email)`)
    const at = await cnt(n, "AuthToken")
    check(at === rt + ev + prOk, `AuthToken = RefreshToken ${rt} + EmailVerificationToken ${ev} + PasswordResetToken ${prOk}/${pr} = ${at}`)
    if (pr - prOk) note(`EXPECTED LOSS: ${pr - prOk} PasswordResetToken rows whose email matches no user`)
    for (const [t, ty] of [["RefreshToken", "REFRESH"], ["EmailVerificationToken", "EMAIL_VERIFICATION"]]) {
      const bad = await one(`SELECT count(*) FROM ${o(t)} x WHERE NOT EXISTS (SELECT 1 FROM ${n("AuthToken")} a WHERE a.id = x.id AND a.type = '${ty}' AND a."tokenHash" = x."tokenHash" AND a."userId" = x."userId" AND a."expiresAt" = x."expiresAt" AND a."createdAt" = x."createdAt")`)
      check(bad === 0, `every ${t} row is in AuthToken as ${ty} with the same hash, owner and times (${bad} differ)`)
    }
    const badRt = await one(`SELECT count(*) FROM ${o("RefreshToken")} x JOIN ${n("AuthToken")} a ON a.id = x.id WHERE a."familyId" IS DISTINCT FROM x."familyId" OR a."usedAt" IS DISTINCT FROM x."usedAt" OR a."revokedAt" IS DISTINCT FROM x."revokedAt"`)
    check(badRt === 0, `refresh family/used/revoked carried exactly (${badRt} differ)`)
    const badPr = await one(`SELECT count(*) FROM ${o("PasswordResetToken")} p JOIN ${o("User")} u ON u.email = p.email JOIN ${n("AuthToken")} a ON a.id = p.id WHERE a."tokenHash" <> encode(sha256(convert_to(p.token, 'UTF8')), 'hex') OR a."userId" <> u.id`)
    check(badPr === 0, `reset tokens stored as SHA-256 hex of the old clear token, owner resolved from email (${badPr} differ)`)
  }

  {
    const photos = await one(`SELECT coalesce(sum(json_array_length(images::json)), 0) FROM ${o("Item")}`)
    const ii = await cnt(n, "ItemImage"), hashed = await cnt(n, "ItemImage", `WHERE hash IS NOT NULL`)
    const iih = await cnt(o, "ItemImageHash")
    check(ii === photos, `ItemImage = photos in Item.images: ${photos} -> ${ii}`)
    check(hashed === iih, `ItemImage hashes = ItemImageHash: ${iih} -> ${hashed}`)
    const misplaced = await one(`SELECT count(*) FROM ${o("ItemImageHash")} h LEFT JOIN ${n("ItemImage")} x ON x."itemId" = h."itemId" AND x.position = h.position WHERE x.hash IS DISTINCT FROM h.hash`)
    check(misplaced === 0, `every old hash is on the same (item, position) (${misplaced} differ)`)
    const urlMismatch = await one(`SELECT count(*) FROM ${o("Item")} i CROSS JOIN LATERAL json_array_elements_text(i.images::json) WITH ORDINALITY e(url, ord) LEFT JOIN ${n("ItemImage")} x ON x."itemId" = i.id AND x.position = e.ord - 1 WHERE x.url IS DISTINCT FROM e.url`)
    check(urlMismatch === 0, `every URL is at its old index (${urlMismatch} differ)`)
    const lostHashCol = await cnt(o, "Item", `WHERE "imageHash" IS NOT NULL`)
    note(`EXPECTED LOSS (column): Item.imageHash on ${lostHashCol} rows -- each equal to its position-0 ItemImage.hash (asserted by the migration)`)
  }

  {
    const want = await one(`SELECT count(*) FROM (SELECT DISTINCT id, unnest("lookingForCategories") FROM ${o("Item")}) x`)
    const raw = await one(`SELECT coalesce(sum(cardinality("lookingForCategories")), 0) FROM ${o("Item")}`)
    const got = await cnt(n, "ItemWantedCategory")
    check(got === want, `ItemWantedCategory = distinct (item, category) in lookingForCategories: ${want} -> ${got}${raw !== want ? ` (${raw - want} repeats folded)` : ""}`)
    const diff = await one(`SELECT count(*) FROM ((SELECT DISTINCT id, unnest("lookingForCategories")::text FROM ${o("Item")}) EXCEPT (SELECT "itemId", category::text FROM ${n("ItemWantedCategory")})) x`)
    check(diff === 0, `every wanted category landed on its item (${diff} missing)`)
  }

  {
    const boosted = await cnt(o, "Item", `WHERE "isFeatured" OR "featuredUntil" IS NOT NULL OR "featuredAt" IS NOT NULL`)
    note(`EXPECTED LOSS (columns): Item.isFeatured/featuredUntil/featuredAt on ${boosted} rows (boosting removed; FEATURE_BOOST ledger rows kept)`)
  }

  {
    const before = await cnt(o, "Notification"), after = await cnt(n, "Notification")
    const invites = await one(`SELECT count(*) FROM ${o("Notification")} x WHERE x."entityType" = 'org_invite' AND NOT EXISTS (SELECT 1 FROM ${o("OrganizationMember")} m WHERE m.id = x."entityId" AND m.role = 'OWNER' AND m.status = 'ACTIVE')`)
    check(after === before - invites, `Notification: ${before} -> ${after} (expected loss: ${invites} ORG_INVITE rows about removed staff invitations)`)
  }

  {
    const mem = await cnt(o, "OrganizationMember")
    const owners = await cnt(o, "OrganizationMember", `WHERE role = 'OWNER' AND status = 'ACTIVE'`)
    const orgs = await cnt(n, "Organization")
    const bad = await one(`SELECT count(*) FROM ${n("Organization")} g JOIN ${o("OrganizationMember")} m ON m."organizationId" = g.id AND m.role = 'OWNER' AND m.status = 'ACTIVE' WHERE g."ownerId" <> m."userId" OR g."ownerJoinedAt" <> coalesce(m."joinedAt", m."invitedAt")`)
    check(owners === orgs && bad === 0, `Organization.ownerId/ownerJoinedAt = the ACTIVE OWNER member for all ${orgs} orgs (${bad} differ)`)
    note(`EXPECTED LOSS: ${mem - owners} non-owner OrganizationMember rows:`)
    for (const r of await rows(`SELECT g.name org, u.name, u.email, m.role, m.status FROM ${o("OrganizationMember")} m JOIN ${o("Organization")} g ON g.id = m."organizationId" JOIN ${o("User")} u ON u.id = m."userId" WHERE NOT (m.role = 'OWNER' AND m.status = 'ACTIVE') ORDER BY g.name, u.name`))
      console.log(`          ${r.org}: ${r.name} <${r.email}> ${r.role}/${r.status}`)
  }

  {
    const rep = await cnt(o, "Report"), app = await cnt(o, "ListingAppeal"), mc = await cnt(n, "ModerationCase")
    check(mc === rep + app, `ModerationCase = Report ${rep} + ListingAppeal ${app} = ${mc}`)
    const bad = await one(`SELECT count(*) FROM ${o("ListingAppeal")} a LEFT JOIN ${n("ModerationCase")} c ON c.id = a.id WHERE c.id IS NULL OR c.type <> 'LISTING_APPEAL' OR c."filedById" <> a."ownerId" OR c."itemId" <> a."itemId" OR c."appealKind"::text <> a.kind::text OR c.status::text <> a.status::text OR c.message <> a.message OR c."actionId" <> a."actionId" OR c."decidedById" IS DISTINCT FROM a."decidedById" OR c."decidedAt" IS DISTINCT FROM a."decidedAt" OR c."decisionNote" IS DISTINCT FROM a."decisionReason" OR c."createdAt" <> a."createdAt"`)
    check(bad === 0, `every ListingAppeal field carried (${bad} differ)`)
    const badR = await one(`SELECT count(*) FROM ${o("Report")} r LEFT JOIN ${n("ModerationCase")} c ON c.id = r.id WHERE c.id IS NULL OR c."filedById" <> r."reporterId" OR c."targetId" <> r."targetId" OR c.status::text <> r.status::text OR c."openKey" IS DISTINCT FROM r."openKey"`)
    check(badR === 0, `every Report field carried (${badR} differ)`)
  }

  {
    const qa = await cnt(o, "QuestAssignment"), ua = await cnt(o, "UserAchievement"), up = await cnt(n, "UserProgress")
    check(up === qa + ua, `UserProgress = QuestAssignment ${qa} + UserAchievement ${ua} = ${up}`)
    const badQ = await one(`SELECT count(*) FROM ${o("QuestAssignment")} q LEFT JOIN ${n("UserProgress")} p ON p.id = q.id WHERE p.id IS NULL OR p.type <> 'QUEST' OR p."userId" <> q."userId" OR p."periodStart" <> q."periodStart" OR p.tier::text <> q.tier::text OR p.quest::text <> q.quest::text OR p."rewardLeaves" <> q."rewardLeaves" OR p."completedAt" IS DISTINCT FROM q."completedAt" OR p."createdAt" <> q."createdAt"`)
    check(badQ === 0, `every QuestAssignment field carried (${badQ} differ)`)
    const badA = await one(`SELECT count(*) FROM ${o("UserAchievement")} a LEFT JOIN ${n("UserProgress")} p ON p.id = a.id WHERE p.id IS NULL OR p.type <> 'ACHIEVEMENT' OR p."userId" <> a."userId" OR p."achievementId" <> a."achievementId" OR p."unlockedAt" <> a."unlockedAt" OR p."displayOrder" IS DISTINCT FROM a."displayOrder" OR p."homeDisplayOrder" IS DISTINCT FROM a."homeDisplayOrder"`)
    check(badA === 0, `every UserAchievement field carried, display slots included (${badA} differ)`)
  }

  {
    note(`EXPECTED LOSS: DeferredContract ${await cnt(o, "DeferredContract")} row(s), CommentLike ${await cnt(o, "CommentLike")}, ConversationHide ${await cnt(o, "ConversationHide")}`)
  }

  // Ledger
  {
    const lo = await cnt(o, "LeafTransaction"), ln = await cnt(n, "LeafTransaction")
    if (ledgerShipped) {
      const tc = await cnt(o, "TaskCompletion"), denied = await cnt(o, "TaskCompletion", `WHERE leaves = 0`)
      check(ln === lo + denied, `LeafTransaction: ${lo} -> ${ln} (+${denied} zero-Leaf rows for denied task completions)`)
      const tasks = await cnt(n, "LeafTransaction", `WHERE task IS NOT NULL`)
      check(tasks === tc, `ledger rows carrying a task = TaskCompletion rows: ${tc} -> ${tasks}`)
      const missing = await one(`SELECT count(*) FROM ${o("TaskCompletion")} t WHERE NOT EXISTS (SELECT 1 FROM ${n("LeafTransaction")} l WHERE l."userId" = t."userId" AND l.task::text = t.task::text AND l."taskRefId" = t."refId" AND l.amount = t.leaves)`)
      check(missing === 0, `every (user, task, refId, leaves) completion is on the ledger (${missing} missing)`)
      const moved = await one(`SELECT count(*) FROM ${o("LeafTransaction")} a JOIN ${n("LeafTransaction")} b ON b.id = a.id WHERE a."userId" <> b."userId" OR a.type::text <> b.type::text OR a.amount <> b.amount OR a.description <> b.description OR a."createdAt" <> b."createdAt" OR a."eventAt" <> b."eventAt" OR a."contractId" IS DISTINCT FROM b."contractId"`)
      check(moved === 0, `no pre-existing ledger row changed user, type, amount, description or time (${moved} changed)`)
      const tcPair = await rows(`SELECT t.task::text task, count(*) n, max(abs(extract(epoch FROM (l."createdAt" - t."createdAt"))))::numeric(8,3) maxgap FROM ${o("TaskCompletion")} t JOIN ${n("LeafTransaction")} l ON l."userId" = t."userId" AND l.task::text = t.task::text AND l."taskRefId" = t."refId" WHERE t.leaves > 0 GROUP BY 1 ORDER BY 1`)
      note(`paid completions matched to their ledger row: ${tcPair.map((r) => `${r.task} ${r.n} (max gap ${r.maxgap}s)`).join(", ")}`)
    } else {
      check(ln === lo, `LeafTransaction: ${lo} -> ${ln} (ledger part skipped)`)
    }
  }

  // Trade
  if (tradeShipped) {
    const tr = await cnt(o, "TradeRequest"), of = await cnt(o, "Offer"), t = await cnt(n, "Trade")
    const merged = await cnt(n, "Trade", `WHERE "legacyOfferId" IS NOT NULL AND "legacyOfferId" <> id`)
    const offerOnly = await cnt(n, "Trade", `WHERE "legacyOfferId" = id`)
    const tradeOnly = await cnt(n, "Trade", `WHERE "legacyOfferId" IS NULL`)
    check(t === tr + of - merged, `Trade = TradeRequest ${tr} + Offer ${of} - paired ${merged} = ${t}`)
    note(`Trade rows: ${merged} offer+trade, ${offerOnly} offer only, ${tradeOnly} trade only (no offer)`)
    const trMissing = await one(`SELECT count(*) FROM ${o("TradeRequest")} x WHERE NOT EXISTS (SELECT 1 FROM ${n("Trade")} y WHERE y.id = x.id)`)
    const ofMissing = await one(`SELECT count(*) FROM ${o("Offer")} x WHERE NOT EXISTS (SELECT 1 FROM ${n("Trade")} y WHERE y."legacyOfferId" = x.id)`)
    check(trMissing === 0 && ofMissing === 0, `every TradeRequest id and every Offer id is in Trade (${trMissing} / ${ofMissing} missing)`)
    const trBad = await one(`SELECT count(*) FROM ${o("TradeRequest")} x JOIN ${n("Trade")} y ON y.id = x.id WHERE y.status::text <> x.status::text OR y."senderId" <> x."senderId" OR y."receiverId" <> x."receiverId" OR y."offeredItemId" <> x."offeredItemId" OR y."requestedItemId" <> x."requestedItemId" OR y."tradeCreatedAt" <> x."createdAt" OR (y."completedAt" IS DISTINCT FROM x."completedAt" AND NOT (x."completedAt" IS NULL AND x.status = 'COMPLETED')) OR y."offeredLeaves" IS DISTINCT FROM x."offeredLeaves" OR y."bridgeFeeLeaves" IS DISTINCT FROM x."bridgeFeeLeaves" OR y."bridgeFeePaidBySender" IS DISTINCT FROM x."bridgeFeePaidBySender" OR y."safeZoneHubId" IS DISTINCT FROM x."safeZoneHubId" OR y."meetupHubId" IS DISTINCT FROM x."meetupHubId" OR y."meetupAt" IS DISTINCT FROM x."meetupAt" OR y."meetupNote" IS DISTINCT FROM x."meetupNote" OR y."meetupProposedBySender" IS DISTINCT FROM x."meetupProposedBySender" OR y."meetupAgreedAt" IS DISTINCT FROM x."meetupAgreedAt" OR y.message IS DISTINCT FROM x.message`)
    check(trBad === 0, `every TradeRequest field carried onto its Trade (${trBad} differ; completedAt backfill checked below)`)

    // 20261004000001: completedAt backfilled on legacy COMPLETED trades, and only there.
    const legacyDone = await one(`SELECT count(*) FROM ${o("TradeRequest")} WHERE status = 'COMPLETED' AND "completedAt" IS NULL`)
    const filled = await one(`SELECT count(*) FROM ${o("TradeRequest")} x JOIN ${n("Trade")} y ON y.id = x.id WHERE x.status = 'COMPLETED' AND x."completedAt" IS NULL AND y."completedAt" IS NOT NULL AND y."completedAt" >= y."tradeCreatedAt"`)
    const stillNull = await cnt(n, "Trade", `WHERE status = 'COMPLETED' AND "completedAt" IS NULL`)
    check(filled === legacyDone && stillNull === 0, `completedAt backfilled on all ${legacyDone} legacy COMPLETED trades (${filled} filled, at or after tradeCreatedAt; ${stillNull} COMPLETED left NULL)`)

    // 20261004000002: the hide flags are gone, and none was set, so nothing came undone.
    const hiddenOld = await one(`SELECT count(*) FROM ${o("TradeRequest")} WHERE "hiddenBySender" OR "hiddenByReceiver"`)
    const hiddenCols = await one(`SELECT count(*) FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'Trade' AND column_name IN ('hiddenBySender', 'hiddenByReceiver')`, [NEW])
    check(hiddenOld === 0 && hiddenCols === 0, `Trade.hiddenBySender/hiddenByReceiver dropped (${hiddenCols} left) and no old trade was hidden (${hiddenOld}), so no hide came undone`)
    const ofBad = await one(`SELECT count(*) FROM ${o("Offer")} x JOIN ${n("Trade")} y ON y."legacyOfferId" = x.id WHERE y."offerStatus"::text <> x.status::text OR y."senderId" <> x."senderId" OR y."receiverId" <> x."receiverId" OR y."requestedItemId" <> x."postId" OR y."createdAt" <> x."createdAt" OR y."offeredBracket" IS DISTINCT FROM x."offeredBracket" OR y."targetBracket" IS DISTINCT FROM x."targetBracket" OR y."consentAt" IS DISTINCT FROM x."consentAt" OR y."policyVersion" IS DISTINCT FROM x."policyVersion" OR y."bridgeFeeLeaves" IS DISTINCT FROM x."bridgeFeeLeaves" OR (json_array_length(x."offeredItems"::json) = 1 AND y."offeredItemId" IS DISTINCT FROM x."offeredItems"::json -> 0 ->> 'id')`)
    check(ofBad === 0, `every Offer field carried onto its Trade (${ofBad} differ)`)
    const ofOnlyBad = await one(`SELECT count(*) FROM ${o("Offer")} x JOIN ${n("Trade")} y ON y.id = x.id WHERE y.message IS DISTINCT FROM x.message OR y."offeredLeaves" IS DISTINCT FROM x."offeredLeaves" OR y."updatedAt" <> x."updatedAt" OR y.status IS NOT NULL`)
    check(ofOnlyBad === 0, `offer-only deals keep message, offeredLeaves, updatedAt; no trade phase (${ofOnlyBad} differ)`)
    const lossLeaves = await rows(`SELECT y.id, x."offeredLeaves" offer_said, y."offeredLeaves" trade_said FROM ${o("Offer")} x JOIN ${n("Trade")} y ON y."legacyOfferId" = x.id AND y.id <> x.id WHERE x."offeredLeaves" IS DISTINCT FROM y."offeredLeaves" ORDER BY y.id`)
    if (lossLeaves.length) note(`EXPECTED LOSS: ${lossLeaves.length} paired offers whose own offeredLeaves differed from the trade's (the trade's settled figure is kept): ${lossLeaves.map((r) => `${r.id} offer=${r.offer_said} trade=${r.trade_said}`).join("; ")}`)
    const titleLoss = await one(`SELECT count(*) FROM ${o("Offer")} x, json_array_elements(x."offeredItems"::json) e JOIN ${o("Item")} it ON it.id = e->>'id' WHERE e->>'title' IS DISTINCT FROM it.title`)
    check(titleLoss === 0, `Offer.offeredItems title snapshots all equal the item's title, so dropping the JSON loses nothing (${titleLoss} differ)`)
  }

  // ── 2. Carried-over tables, row for row ─────────────────────────────────
  console.log("\n2. Carried-over tables, every row and every shared column (EXCEPT both ways)")
  const colsOf = async (s: string, t: string) => (await rows(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [s, t])).map((r) => r.column_name as string)
  const carried: [string, string, string?][] = [
    ...same,
    ["Notification", "Notification", `WHERE NOT ("entityType" = 'org_invite')`],
    ["LeafTransaction", "LeafTransaction"],
  ]
  for (const [a, b, where] of carried) {
    if (b === "LeafTransaction" && tradeShipped) {
      // offerId was rewritten to tradeId: compare everything else, and the remap separately.
    }
    const oc = await colsOf(OLD, a), nc = await colsOf(NEW, b)
    let shared = oc.filter((c) => nc.includes(c))
    if (b === "LeafTransaction") shared = shared.filter((c) => c !== "tradeId")
    const list = shared.map((c) => `"${c}"::text`).join(", ")
    const w = where ?? ""
    const ab = await one(`SELECT count(*) FROM (SELECT ${list} FROM ${o(a)} ${w} EXCEPT ALL SELECT ${list} FROM ${n(b)} ${w}) x`)
    const ba = await one(`SELECT count(*) FROM (SELECT ${list} FROM ${n(b)} ${w} EXCEPT ALL SELECT ${list} FROM ${o(a)} ${w}) x`)
    const dropped = oc.filter((c) => !nc.includes(c)), added = nc.filter((c) => !oc.includes(c))
    const extraNew = b === "LeafTransaction" && ledgerShipped ? await cnt(o, "TaskCompletion", `WHERE leaves = 0`) : 0
    check(ab === 0 && ba === extraNew, `${b}: ${shared.length} shared columns identical (old-not-new ${ab}, new-not-old ${ba}${extraNew ? `, expected ${extraNew} new zero-Leaf rows` : ""})` +
      `${dropped.length ? `; dropped: ${dropped.join(", ")}` : ""}${added.length ? `; added: ${added.join(", ")}` : ""}`)
  }
  if (tradeShipped) {
    const remap = await one(`SELECT count(*) FROM ${o("LeafTransaction")} a JOIN ${n("LeafTransaction")} b ON b.id = a.id WHERE (a."offerId" IS NOT NULL AND b."tradeId" IS DISTINCT FROM (SELECT t.id FROM ${n("Trade")} t WHERE t."legacyOfferId" = a."offerId")) OR (a."offerId" IS NULL AND b."tradeId" IS DISTINCT FROM a."tradeId"${ledgerShipped ? " AND b.task IS NULL" : ""})`)
    const remapped = await cnt(o, "LeafTransaction", `WHERE "offerId" IS NOT NULL`)
    check(remap === 0, `LeafTransaction.tradeId: ${remapped} offerId references rewritten to their Trade, every other tradeId unchanged (${remap} differ)`)
  }

  // ── 3. Foreign keys and soft references ─────────────────────────────────
  console.log("\n3. Foreign keys and references")
  const fks = await rows(`
    SELECT c.conname, c.convalidated, cl.relname AS tbl, fl.relname AS ftbl,
           array_agg(a.attname::text ORDER BY k.ord) AS cols, array_agg(fa.attname::text ORDER BY k.ord) AS fcols
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace ns ON ns.oid = cl.relnamespace
      JOIN pg_class fl ON fl.oid = c.confrelid
      CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(col, fcol, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.col
      JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = k.fcol
     WHERE c.contype = 'f' AND ns.nspname = $1
     GROUP BY c.conname, c.convalidated, cl.relname, fl.relname ORDER BY 1`, [NEW])
  let orphanTotal = 0
  for (const fk of fks) {
    const cols = fk.cols as string[], fcols = fk.fcols as string[]
    const orphans = await one(`SELECT count(*) FROM ${n(fk.tbl)} x WHERE ${cols.map((c) => `x."${c}" IS NOT NULL`).join(" AND ")} AND NOT EXISTS (SELECT 1 FROM ${n(fk.ftbl)} y WHERE ${cols.map((c, k) => `y."${fcols[k]}" = x."${c}"`).join(" AND ")})`)
    orphanTotal += orphans
    if (!fk.convalidated || orphans) fail(`${fk.conname}: validated=${fk.convalidated}, orphans=${orphans}`)
  }
  check(orphanTotal === 0 && fks.every((f) => f.convalidated), `${fks.length} foreign keys, all validated, 0 orphans`)
  const fkTargets = new Set(fks.map((f) => f.ftbl))
  note(`FK targets: ${[...fkTargets].sort().join(", ")}`)

  const tradeTbl = tradeShipped ? n("Trade") : n("TradeRequest")
  const softs: [string, string][] = [
    [`LeafTransaction.tradeId -> Trade`, `SELECT count(*) FROM ${n("LeafTransaction")} l WHERE l."tradeId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${tradeTbl} t WHERE t.id = l."tradeId")`],
    [`Notification(trade|meetup).entityId -> Trade`, `SELECT count(*) FROM ${n("Notification")} x WHERE x."entityType" IN ('trade','meetup') AND x."entityId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${tradeTbl} t WHERE t.id = x."entityId")`],
    [`Notification(org_invite) rows left`, `SELECT count(*) FROM ${n("Notification")} x WHERE x."entityType" = 'org_invite'`],
    [`AdminAction(TRADE).targetId -> Trade`, `SELECT count(*) FROM ${n("AdminAction")} a WHERE a."targetType" = 'TRADE' AND NOT EXISTS (SELECT 1 FROM ${tradeTbl} t WHERE t.id = a."targetId")`],
    [`AdminAction(LISTING_APPEAL).targetId -> ModerationCase`, `SELECT count(*) FROM ${n("AdminAction")} a WHERE a."targetType" = 'LISTING_APPEAL' AND NOT EXISTS (SELECT 1 FROM ${n("ModerationCase")} c WHERE c.id = a."targetId")`],
    [`ModerationCase.actionId -> AdminAction`, `SELECT count(*) FROM ${n("ModerationCase")} c WHERE c."actionId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${n("AdminAction")} a WHERE a.id = c."actionId")`],
    [`LeafTransaction.task rows -> their tradeId when repeatable`, `SELECT count(*) FROM ${n("LeafTransaction")} l WHERE l.task IS NOT NULL AND l."taskRefId" <> '' AND l."tradeId" IS NOT NULL AND l."tradeId" <> l."taskRefId"`],
  ]
  for (const [label, sql] of softs) {
    if (!ledgerShipped && label.includes(".task")) continue
    const c = await one(sql)
    check(c === 0, `${label}: ${c} unresolved`)
  }
  {
    const pre = await one(`SELECT count(*) FROM ${o("AdminAction")} a WHERE a."targetType" = 'TRADE' AND NOT EXISTS (SELECT 1 FROM ${o("TradeRequest")} t WHERE t.id = a."targetId")`)
    if (pre) note(`(${pre} TRADE audit targets were already unresolved on the old copy)`)
  }
  {
    const contract = await rows(`SELECT id, type::text, amount, "contractId" FROM ${n("LeafTransaction")} WHERE "contractId" IS NOT NULL ORDER BY type`)
    note(`BY DESIGN unresolved: LeafTransaction.contractId on ${contract.length} rows (${contract.map((r) => `${r.type} ${r.amount}`).join(", ")}) -> DeferredContract ${contract[0]?.contractId ?? "-"}, dropped; the row is in the backup`)
  }

  // ── 4. The ledger ───────────────────────────────────────────────────────
  console.log("\n4. The Leaves ledger")
  const figures = async (s: (t: string) => string, v2: boolean) => {
    const userLeaves = await one(`SELECT coalesce(sum(leaves), 0) FROM ${s("User")}`)
    const ledger = await one(`SELECT coalesce(sum(amount), 0) FROM ${s("LeafTransaction")}`)
    const escrow = -(await one(`SELECT coalesce(sum(amount), 0) FROM ${s("LeafTransaction")} WHERE type IN ('BRIDGE_FEE_HOLD','BRIDGE_FEE_RELEASE','BRIDGE_FEE_PAID')`))
    const issuance = await one(`SELECT coalesce(sum(amount), 0) FROM ${s("LeafTransaction")} WHERE type IN ('SIGNUP_GRANT','TASK_REWARD','TRADE_REWARD','TRADE_REWARD_REVERSAL','QUEST_REWARD','TIER_DAILY_GRANT','FEATURE_BOOST')`)
    const held = v2
      ? await one(`SELECT coalesce((SELECT sum("bridgeFeeLeaves") FROM ${s("Trade")} WHERE status IS NULL AND "offerStatus" = 'PENDING' AND "bridgeFeeLeaves" IS NOT NULL AND "offeredBracket" < "targetBracket"), 0) + coalesce((SELECT sum("bridgeFeeLeaves") FROM ${s("Trade")} WHERE status IN ('PENDING','ACCEPTED','CONFIRMING')), 0)`)
      : await one(`SELECT coalesce((SELECT sum("bridgeFeeLeaves") FROM ${s("Offer")} WHERE status = 'PENDING' AND "bridgeFeeLeaves" IS NOT NULL AND "offeredBracket" < "targetBracket"), 0) + coalesce((SELECT sum("bridgeFeeLeaves") FROM ${s("TradeRequest")} WHERE status IN ('PENDING','ACCEPTED','CONFIRMING')), 0)`)
    return { userLeaves, ledger, escrow, issuance, held }
  }
  const fo = await figures(o, false), fn = await figures(n, tradeShipped)
  for (const [label, f] of [["old", fo], ["new", fn]] as const) {
    console.log(`  ${label}: SUM(User.leaves)=${f.userLeaves}  SUM(amount)=${f.ledger}  escrow=${f.escrow}  issuance=${f.issuance}  held=${f.held}`)
  }
  check(fn.userLeaves === fn.ledger, `SUM(User.leaves) ${fn.userLeaves} == SUM(LeafTransaction.amount) ${fn.ledger}`)
  check(fn.userLeaves + fn.escrow === fn.issuance, `SUM(User.leaves) + escrow ${fn.userLeaves + fn.escrow} == issuance ${fn.issuance}`)
  check(fn.escrow === fn.held, `escrow(ledger) ${fn.escrow} == held(rows) ${fn.held}`)
  check(JSON.stringify(fo) === JSON.stringify(fn), `all five figures identical to the old copy`)
  const perUser = await one(`SELECT count(*) FROM ${n("User")} u WHERE u.leaves <> (SELECT coalesce(sum(amount), 0) FROM ${n("LeafTransaction")} l WHERE l."userId" = u.id)`)
  const perUserOld = await one(`SELECT count(*) FROM ${o("User")} u WHERE u.leaves <> (SELECT coalesce(sum(amount), 0) FROM ${o("LeafTransaction")} l WHERE l."userId" = u.id)`)
  check(perUser === perUserOld, `per-user balance vs ledger: ${perUser} users differ on the new copy, ${perUserOld} on the old (unchanged)`)

  // ── 5. Bracket ─────────────────────────────────────────────────────────
  console.log("\n5. Item.bracket")
  const items = await rows(`SELECT id, "valueLeaves", bracket FROM ${n("Item")}`)
  const wrong = items.filter((r) => (r.valueLeaves === null ? r.bracket !== null : r.bracket !== bracketOf(r.valueLeaves)))
  check(wrong.length === 0, `bracket == bracketOf(valueLeaves) on all ${items.length} items (${items.filter((r) => r.valueLeaves === null).length} with no value -> NULL); ${wrong.length} wrong`)
  const gen = await one(`SELECT count(*) FROM pg_attribute WHERE attrelid = '${NEW}."Item"'::regclass AND attname = 'bracket' AND attgenerated = 's'`)
  check(gen === 1, `Item.bracket is a STORED GENERATED column`)

  // ── 6. Samples ─────────────────────────────────────────────────────────
  console.log("\n6. Samples, field by field")
  const json = async (sql: string, params: unknown[]) => (await rows(sql, params))[0]?.j ?? null
  const cmp = (label: string, a: Record<string, unknown>, b: Record<string, unknown>, map: Record<string, string> = {}, skipCols: string[] = []) => {
    const diffs: string[] = []
    for (const [k, v] of Object.entries(b)) {
      if (skipCols.includes(k)) continue
      const src = map[k] ?? k
      if (!(src in a)) continue
      if (JSON.stringify(a[src]) !== JSON.stringify(v)) diffs.push(`${k}: ${JSON.stringify(a[src])} -> ${JSON.stringify(v)}`)
    }
    if (diffs.length) fail(`${label}: ${diffs.join("; ")}`)
    return diffs.length === 0
  }

  // Items: an even spread, with photos and wanted categories where they exist.
  const itemIds = (await rows(`SELECT id FROM ${o("Item")} ORDER BY (json_array_length(images::json) > 1) DESC, (cardinality("lookingForCategories") > 0) DESC, md5(id) LIMIT 10`)).map((r) => r.id)
  let okItems = 0
  for (const id of itemIds) {
    const a = await json(`SELECT row_to_json(x) j FROM ${o("Item")} x WHERE id = $1`, [id])
    const b = await json(`SELECT row_to_json(x) j FROM ${n("Item")} x WHERE id = $1`, [id])
    let ok = cmp(`Item ${id}`, a, b, {}, ["bracket"])
    const imgsNew = (await rows(`SELECT url, hash FROM ${n("ItemImage")} WHERE "itemId" = $1 ORDER BY position`, [id]))
    const hashesOld = new Map((await rows(`SELECT position, hash FROM ${o("ItemImageHash")} WHERE "itemId" = $1`, [id])).map((r) => [r.position, r.hash]))
    const imgsOld = (JSON.parse(a.images) as string[]).map((url, p) => ({ url, hash: hashesOld.get(p) ?? null }))
    if (JSON.stringify(imgsOld) !== JSON.stringify(imgsNew)) { ok = false; fail(`Item ${id} photos: ${JSON.stringify(imgsOld)} -> ${JSON.stringify(imgsNew)}`) }
    const wantNew = (await rows(`SELECT category::text c FROM ${n("ItemWantedCategory")} WHERE "itemId" = $1 ORDER BY 1`, [id])).map((r) => r.c)
    const wantOld = [...new Set(a.lookingForCategories as string[])].sort()
    if (JSON.stringify(wantOld) !== JSON.stringify(wantNew)) { ok = false; fail(`Item ${id} wanted: ${wantOld} -> ${wantNew}`) }
    if ((a.valueLeaves === null ? null : bracketOf(a.valueLeaves)) !== b.bracket) { ok = false; fail(`Item ${id} bracket ${b.bracket} for value ${a.valueLeaves}`) }
    if (ok) okItems++
  }
  check(okItems === itemIds.length, `${okItems}/${itemIds.length} items identical (every column, photos + hashes in order, wanted categories, bracket)`)

  // Trades: merged, offer-only and trade-only, so every mapping path is sampled.
  if (tradeShipped) {
    const pick = async (where: string, k: number) => (await rows(`SELECT id, "legacyOfferId" FROM ${n("Trade")} WHERE ${where} ORDER BY md5(id) LIMIT ${k}`))
    const sample = [
      ...(await pick(`"legacyOfferId" IS NOT NULL AND "legacyOfferId" <> id`, 4)),
      ...(await pick(`"legacyOfferId" = id`, 3)),
      ...(await pick(`"legacyOfferId" IS NULL`, 3)),
    ]
    let okTrades = 0
    for (const s of sample) {
      const b = await json(`SELECT row_to_json(x) j FROM ${n("Trade")} x WHERE id = $1`, [s.id])
      const tr = await json(`SELECT row_to_json(x) j FROM ${o("TradeRequest")} x WHERE id = $1`, [s.id])
      const of = s.legacyOfferId ? await json(`SELECT row_to_json(x) j FROM ${o("Offer")} x WHERE id = $1`, [s.legacyOfferId]) : null
      let ok = true
      // A legacy COMPLETED trade's completedAt was backfilled (checked in section 1).
      const backfilled = tr && tr.status === "COMPLETED" && tr.completedAt === null ? ["completedAt"] : []
      if (tr) ok = cmp(`Trade ${s.id} vs TradeRequest`, { ...tr, tradeCreatedAt: tr.createdAt }, b, {}, ["createdAt", "updatedAt", "offerStatus", "legacyOfferId", "offeredBracket", "targetBracket", "consentAt", "policyVersion", ...backfilled]) && ok
      if (of) {
        const offerItem = (JSON.parse(of.offeredItems) as { id: string }[])[0]?.id ?? null
        ok = cmp(`Trade ${s.id} vs Offer ${s.legacyOfferId}`, { ...of, offerStatus: of.status, requestedItemId: of.postId }, b, {},
          ["id", "status", "legacyOfferId", "updatedAt", "tradeCreatedAt", "completedAt", "safeZoneHubId", "meetupHubId", "meetupAt", "meetupNote", "meetupProposedBySender", "meetupAgreedAt", "bridgeFeePaidBySender",
           ...(tr ? ["offeredLeaves", "message", "offeredItemId"] : [])]) && ok
        if (offerItem && b.offeredItemId !== offerItem) { ok = false; fail(`Trade ${s.id} offered item ${b.offeredItemId}, offer named ${offerItem}`) }
        if (!tr && b.status !== null) { ok = false; fail(`Trade ${s.id} has a trade phase but no TradeRequest`) }
      }
      if (!tr && !of) { ok = false; fail(`Trade ${s.id} came from nowhere`) }
      if (ok) okTrades++
      console.log(`        ${s.id}  ${tr && of ? "offer+trade" : of ? "offer only " : "trade only "}  offer=${b.offerStatus ?? "-"} trade=${b.status ?? "-"}  ${ok ? "identical" : "DIFFERS"}`)
    }
    check(okTrades === sample.length, `${okTrades}/${sample.length} trades identical to their TradeRequest and/or Offer, field by field`)
  }

  // Users: every column, and every relation count that moved tables.
  const userIds = (await rows(`SELECT id FROM ${o("User")} u ORDER BY (SELECT count(*) FROM ${o("LeafTransaction")} l WHERE l."userId" = u.id) DESC, md5(id) LIMIT 10`)).map((r) => r.id)
  let okUsers = 0
  for (const id of userIds) {
    const a = await json(`SELECT row_to_json(x) j FROM ${o("User")} x WHERE id = $1`, [id])
    const b = await json(`SELECT row_to_json(x) j FROM ${n("User")} x WHERE id = $1`, [id])
    let ok = cmp(`User ${id}`, a, b)
    const rel = async (sqlOld: string, sqlNew: string, label: string) => {
      const x = await one(sqlOld, [id]), y = await one(sqlNew, [id])
      if (x !== y) { ok = false; fail(`User ${id} ${label}: ${x} -> ${y}`) }
    }
    await rel(`SELECT (SELECT count(*) FROM ${o("RefreshToken")} WHERE "userId" = $1) + (SELECT count(*) FROM ${o("EmailVerificationToken")} WHERE "userId" = $1) + (SELECT count(*) FROM ${o("PasswordResetToken")} p JOIN ${o("User")} u ON u.email = p.email WHERE u.id = $1)`, `SELECT count(*) FROM ${n("AuthToken")} WHERE "userId" = $1`, "tokens")
    await rel(`SELECT (SELECT count(*) FROM ${o("QuestAssignment")} WHERE "userId" = $1) + (SELECT count(*) FROM ${o("UserAchievement")} WHERE "userId" = $1)`, `SELECT count(*) FROM ${n("UserProgress")} WHERE "userId" = $1`, "progress")
    await rel(`SELECT coalesce(sum(amount), 0) FROM ${o("LeafTransaction")} WHERE "userId" = $1`, `SELECT coalesce(sum(amount), 0) FROM ${n("LeafTransaction")} WHERE "userId" = $1`, "ledger sum")
    if (ledgerShipped) await rel(`SELECT count(*) FROM ${o("TaskCompletion")} WHERE "userId" = $1`, `SELECT count(*) FROM ${n("LeafTransaction")} WHERE "userId" = $1 AND task IS NOT NULL`, "task completions")
    if (tradeShipped) await rel(`SELECT (SELECT count(*) FROM ${o("Offer")} WHERE "senderId" = $1) + (SELECT count(*) FROM ${o("TradeRequest")} t WHERE "senderId" = $1 AND NOT EXISTS (SELECT 1 FROM ${n("Trade")} y WHERE y.id = t.id AND y."legacyOfferId" IS NOT NULL))`, `SELECT count(*) FROM ${n("Trade")} WHERE "senderId" = $1`, "deals sent")
    await rel(`SELECT count(*) FROM ${o("PostLike")} WHERE "userId" = $1`, `SELECT count(*) FROM ${n("Like")} WHERE "userId" = $1`, "likes")
    await rel(`SELECT (SELECT count(*) FROM ${o("Report")} WHERE "reporterId" = $1) + (SELECT count(*) FROM ${o("ListingAppeal")} WHERE "ownerId" = $1)`, `SELECT count(*) FROM ${n("ModerationCase")} WHERE "filedById" = $1`, "cases filed")
    if (ok) okUsers++
  }
  check(okUsers === userIds.length, `${okUsers}/${userIds.length} users identical (every column; tokens, progress, ledger sum, task completions, deals, likes, cases)`)

  await pg.query("ROLLBACK") // read-only: nothing to keep
  await pg.end()
  console.log(failures ? `\n  VERIFICATION FAILED: ${failures} check(s)\n` : `\n  SCHEMA V2 VERIFIED on "${NEW}"\n`)
  process.exitCode = failures ? 1 : 0
}

main().catch((e) => { console.error(e); process.exit(1) })
