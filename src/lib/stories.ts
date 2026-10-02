import { Prisma, type PrismaClient } from "@/generated/prisma/client"
import { userNotBlocked, visibleItemWhere } from "@/lib/blocking"
import { notSuspendedWhere } from "@/lib/moderation"
import { notAnOrgWhere } from "@/lib/organizations"
import {
  V1_ITEM_OWNER_SELECT,
  V1_ITEM_SAFEZONE_SELECT,
  V1_ITEM_SELECT,
  v1Item,
  type V1Item,
  type V1ItemRow,
} from "@/lib/v1/item"

/**
 * 24-hour listing stories (1 Oct 2026). The rules live here; the four routes
 * under /api/v1/stories are auth, validation and an envelope around them.
 *
 * ── ONE DEFINITION OF "LIVE" ────────────────────────────────────────────────
 *
 * liveStoryWhere() is spread into EVERY read: the row, mark-seen and nothing
 * else needs its own copy. A story is live for a viewer when
 *
 *   it is not deleted and `expiresAt` is in the future     (24 h, no sweep)
 *   its listing is AVAILABLE and not moderation-hidden     (drops early on a
 *                                                           trade, removal,
 *                                                           expiry or review)
 *   its author is not blocked either way, not suspended,
 *   not deleted and not a shop                             (personal only, v1)
 *
 * All of it is in the SQL, never filtered after the fetch. NOTHING SWEEPS the
 * table: an expired story simply stops matching, and its row stays behind as
 * the trail a STORY report points at.
 *
 * Prisma only, no raw SQL, so a scratch-schema harness stays on its schema.
 */

export const STORY_TTL_MS = 24 * 60 * 60 * 1000
/** Stories one person may START in any rolling 24 h, deleted ones included. */
export const STORY_DAILY_CAP = 10
export const STORY_CAPTION_MAX = 200

type StoryDb = Pick<PrismaClient, "story" | "storyView" | "item" | "user">

export function liveStoryWhere(viewerId: string, now: Date = new Date()): Prisma.StoryWhereInput {
  return {
    deletedAt: null,
    expiresAt: { gt: now },
    type: "LISTING",
    user: {
      is: {
        deletedAt: null,
        ...notAnOrgWhere(),
        ...userNotBlocked(viewerId),
        ...notSuspendedWhere(now),
      },
    },
    // visibleItemWhere() repeats the block and suspension test on the
    // listing's owner. The create path makes owner and author the same person,
    // so this is belt and braces, and it is also what carries the
    // moderation-hidden rule.
    item: { is: { status: "AVAILABLE", ...visibleItemWhere(viewerId) } },
  }
}

// ── create ──────────────────────────────────────────────────────────────────

export type CreateStoryResult =
  | { ok: true; storyId: string; expiresAt: Date }
  /** Not yours, not AVAILABLE, hidden, or does not exist. One answer for all. */
  | { ok: false; reason: "LISTING_NOT_SHAREABLE" }
  /** This listing already has a live story. */
  | { ok: false; reason: "ALREADY_SHARED"; storyId: string }
  | { ok: false; reason: "DAILY_CAP"; cap: number; retryAt: Date }
  /** The author is a shop's backing row. Unreachable from the phone; defensive. */
  | { ok: false; reason: "PERSONAL_ONLY" }

export async function createListingStory(
  db: StoryDb,
  authorId: string,
  input: { itemId: string; caption?: string | null },
  now: Date = new Date(),
): Promise<CreateStoryResult> {
  const author = await db.user.findUnique({
    where: { id: authorId },
    select: { isOrgAccount: true },
  })
  if (!author || author.isOrgAccount) return { ok: false, reason: "PERSONAL_ONLY" }

  // Your own, AVAILABLE, not hidden. A shop's listing is owned by the shop's
  // backing row, so it can never pass `userId: authorId` for a person.
  const item = await db.item.findFirst({
    where: { id: input.itemId, userId: authorId, status: "AVAILABLE", moderationHiddenAt: null },
    select: { id: true },
  })
  if (!item) return { ok: false, reason: "LISTING_NOT_SHAREABLE" }

  const existing = await db.story.findFirst({
    where: { itemId: item.id, userId: authorId, deletedAt: null, expiresAt: { gt: now } },
    select: { id: true },
  })
  if (existing) return { ok: false, reason: "ALREADY_SHARED", storyId: existing.id }

  // DELETED STORIES COUNT. Otherwise post-and-delete is an unlimited loop.
  const windowStart = new Date(now.getTime() - STORY_TTL_MS)
  const recent = await db.story.findMany({
    where: { userId: authorId, createdAt: { gt: windowStart } },
    select: { createdAt: true },
    orderBy: { createdAt: "asc" },
  })
  if (recent.length >= STORY_DAILY_CAP) {
    // The slot frees when the oldest story in the window turns 24 h old.
    const retryAt = new Date(recent[recent.length - STORY_DAILY_CAP].createdAt.getTime() + STORY_TTL_MS)
    return { ok: false, reason: "DAILY_CAP", cap: STORY_DAILY_CAP, retryAt }
  }

  const caption = input.caption?.trim() ? input.caption.trim().slice(0, STORY_CAPTION_MAX) : null
  const story = await db.story.create({
    data: {
      userId: authorId,
      type: "LISTING",
      itemId: item.id,
      caption,
      createdAt: now,
      expiresAt: new Date(now.getTime() + STORY_TTL_MS),
    },
    select: { id: true, expiresAt: true },
  })
  return { ok: true, storyId: story.id, expiresAt: story.expiresAt }
}

// ── the row ─────────────────────────────────────────────────────────────────

export interface StoryWire {
  id: string
  type: "LISTING"
  caption: string | null
  createdAt: Date
  expiresAt: Date
  seen: boolean
  /** The shared listing, in the same shape the feed sends. */
  item: V1Item
}

export interface StoryAuthorWire {
  user: { id: string; name: string; avatar: string | null }
  isOwn: boolean
  /** Every story seen (always true for your own). Drives the grey ring. */
  allSeen: boolean
  /** Oldest first: the order the viewer plays them in. */
  stories: StoryWire[]
}

/** Enough rows for any realistic day; the cap keeps one author at 10. */
const ROW_TAKE = 500

/**
 * The stories row: grouped by author, YOU first, then authors with anything
 * unseen, then the fully seen -- newest activity first within each group.
 */
export async function listStoryRow(
  db: StoryDb,
  viewerId: string,
  now: Date = new Date(),
): Promise<StoryAuthorWire[]> {
  const rows = await db.story.findMany({
    where: liveStoryWhere(viewerId, now),
    select: {
      id: true,
      caption: true,
      createdAt: true,
      expiresAt: true,
      user: { select: { id: true, name: true, avatar: true } },
      item: {
        select: { ...V1_ITEM_SELECT, user: { select: V1_ITEM_OWNER_SELECT }, ...V1_ITEM_SAFEZONE_SELECT },
      },
      views: { where: { viewerId }, select: { id: true }, take: 1 },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: ROW_TAKE,
  })

  const byAuthor = new Map<string, StoryAuthorWire & { latest: number }>()
  for (const r of rows) {
    // liveStoryWhere() requires the item, so this is never null; the guard
    // is for the type, which cannot see the WHERE clause.
    if (!r.item) continue
    const isOwn = r.user.id === viewerId
    const seen = isOwn || r.views.length > 0
    let group = byAuthor.get(r.user.id)
    if (!group) {
      group = { user: r.user, isOwn, allSeen: true, stories: [], latest: 0 }
      byAuthor.set(r.user.id, group)
    }
    group.stories.push({
      id: r.id,
      type: "LISTING",
      caption: r.caption,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      seen,
      item: v1Item(r.item as unknown as V1ItemRow, viewerId),
    })
    group.allSeen = group.allSeen && seen
    group.latest = Math.max(group.latest, r.createdAt.getTime())
  }

  const rank = (g: StoryAuthorWire) => (g.isOwn ? 0 : g.allSeen ? 2 : 1)
  return [...byAuthor.values()]
    .sort((a, b) => rank(a) - rank(b) || b.latest - a.latest)
    .map(({ latest: _latest, ...g }) => g)
}

// ── seen / delete ───────────────────────────────────────────────────────────

/**
 * Records that the viewer saw a story. False when the story is not live for
 * them -- expired, deleted, its listing gone, or a block either way -- which
 * the route answers with the same 404 as a nonexistent id.
 */
export async function markStorySeen(
  db: StoryDb,
  viewerId: string,
  storyId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const story = await db.story.findFirst({
    where: { id: storyId, ...liveStoryWhere(viewerId, now) },
    select: { id: true },
  })
  if (!story) return false
  // upsert: a replay, a retry and a second device are one row.
  await db.storyView.upsert({
    where: { storyId_viewerId: { storyId: story.id, viewerId } },
    create: { storyId: story.id, viewerId, seenAt: now },
    update: {},
  })
  return true
}

/**
 * The author takes a story down. Idempotent: deleting an already-deleted story
 * of yours succeeds. False only when it is not yours or does not exist.
 *
 * A soft delete, so a report filed against it still shows the moderator what
 * was posted. The row stops matching liveStoryWhere() at once.
 */
export async function deleteOwnStory(
  db: StoryDb,
  authorId: string,
  storyId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const story = await db.story.findFirst({
    where: { id: storyId, userId: authorId },
    select: { id: true, deletedAt: true },
  })
  if (!story) return false
  if (!story.deletedAt) {
    await db.story.update({ where: { id: story.id }, data: { deletedAt: now } })
  }
  return true
}
