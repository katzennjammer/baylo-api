// Schema freeze until the defense (owner's standing rule, 11 Oct 2026):
// 28 tables + 1 view (ItemWantedCategorySummary), no new tables, views or
// columns. See AGENTS.md. Static: reads files only, no database, no server.
//
//   npx tsx scripts/verify-schema-freeze.ts
//
// What it pins:
//   1  prisma/schema.prisma declares exactly 28 models and no `view` block
//      (the one view is SQL-only, created by the migration named below)
//   2  each model's field count is what it was on 11 Oct 2026. A field line is
//      a column OR a relation field, so this also fails on a new relation;
//      that is deliberate, a new relation is a schema change to be asked about
//   3  the newest migration folder is still LAST_MIGRATION below, and the folder count is unchanged (so neither a
//      later folder nor a back-dated one slips in)
//
// If this fails because the owner APPROVED a change, update the pins in the
// same commit as the change and say so in the commit message.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(__dirname, "..")
const MODEL_COUNT = 28
// Re-pinned 22 Oct 2026 for 20261020000000_user_push_token (User.pushToken),
// approved by the team and applied to live on 20 Oct 2026.
// 20261104000000_chat_reply_mute_clear: the owner approved new COLUMNS (not
// tables) on 4 Nov 2026 for swipe to reply, mute and delete chat --
// Message.replyToId (+ its relation fields) and User.mutedChatUserIds /
// User.clearedChats. Still 28 tables + 1 view.
const LAST_MIGRATION = "20261104000000_chat_reply_mute_clear"
const MIGRATION_FOLDERS = 39
const FIELDS: Record<string, number> = {
  User: 54, Subscription: 7, Suspension: 8, Follow: 8, AuthToken: 10, Item: 36,
  ItemImage: 5, ItemWantedCategory: 4, Category: 5, Trade: 35, Message: 14,
  Notification: 12, Review: 10, SwapCode: 11, Like: 6, Comment: 10,
  LeafTransaction: 12, ModerationCase: 22, Block: 6, IdVerification: 18,
  AdminAction: 12, SafeZoneHub: 13, ItemSafeZone: 5, Achievement: 14,
  UserProgress: 15, Organization: 23, Story: 11, StoryView: 6,
}

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail: unknown = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}   ${typeof detail === "string" ? detail : JSON.stringify(detail)}`) }
}

const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8").replace(/\r/g, "")

const models: Record<string, number> = {}
for (const m of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
  models[m[1]] = m[2]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//") && !l.startsWith("@@") && /^\w+\s+\S/.test(l)).length
}
const names = Object.keys(models)
check(`schema.prisma has exactly ${MODEL_COUNT} models`, names.length === MODEL_COUNT, `${names.length}`)
check("no Prisma `view` block (the one view is SQL-only)", !/^view\s+\w+/m.test(schema))

const added = names.filter((n) => !(n in FIELDS))
const removed = Object.keys(FIELDS).filter((n) => !(n in models))
check("no model added or renamed", added.length === 0, added)
check("no model removed or renamed", removed.length === 0, removed)
const changed = names
  .filter((n) => n in FIELDS && models[n] !== FIELDS[n])
  .map((n) => `${n}: ${FIELDS[n]} -> ${models[n]}`)
check("every model keeps its field count (no new columns)", changed.length === 0, changed)

const dir = join(ROOT, "prisma/migrations")
const folders = readdirSync(dir).filter((f) => statSync(join(dir, f)).isDirectory()).sort()
const later = folders.filter((f) => f > LAST_MIGRATION)
check(`no migration folder after ${LAST_MIGRATION}`, later.length === 0, later)
check(`the newest migration is still ${LAST_MIGRATION}`, folders[folders.length - 1] === LAST_MIGRATION, folders[folders.length - 1])
check(`migration folder count is still ${MIGRATION_FOLDERS}`, folders.length === MIGRATION_FOLDERS, `${folders.length}`)

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
