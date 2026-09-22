import type { PrismaClient } from "@/generated/prisma/client"
import prisma from "@/lib/prisma"
import pusher from "@/lib/pusher"
import { categoryLabel } from "@/lib/v1/taxonomy"
import { userNotBlocked } from "@/lib/blocking"
import { notSuspendedWhere } from "@/lib/moderation"

/**
 * Category overlap: the one definition of it, and the event-triggered path
 * that turns it into a notification.
 *
 * ── WHAT WAS HERE BEFORE ────────────────────────────────────────────────────
 *
 * Nothing — which is the point. "Both trading Electronics" was computed in two
 * places, GET /api/matches and GET /api/v1/home, from copy-pasted code that had
 * already drifted: one says "Has Books & Media you might like" and the other
 * "Has Books & Media you might like" off a differently-derived `top`, and the
 * fallback sentence for a user with no items differs between them outright.
 * Both now call `sharedCategories()` and `matchReason()` below, so the third
 * caller — the new event-triggered path — is not a third copy.
 *
 * ── PULL VS PUSH ────────────────────────────────────────────────────────────
 *
 * Those two callers are PULL: you open the app and it asks "who overlaps with
 * me". `notifyCategoryMatches()` is PUSH: a listing is created and the people
 * who said they wanted that category are told. Same comparison, opposite
 * direction, and deliberately the same module so they cannot come to disagree
 * about what an overlap is.
 *
 * ── ONE-DIRECTIONAL, AND WHY — READ THIS BEFORE "FIXING" IT ─────────────────
 *
 * The strict rule is MUTUAL: notify the owner of item B about new item A only
 * when A.category ∈ B.lookingForCategories AND B.category ∈
 * A.lookingForCategories. It is the better rule and it is not the launch rule,
 * for one blunt reason: `lookingForCategories` shipped empty. Every row that
 * predates the column reads `[]`, and a mutual test requires BOTH sides to have
 * filled it in — so for as long as it takes the field to spread through the
 * listing base, a mutual matcher notifies almost nobody about almost nothing,
 * and a feature that does nothing for its first months is one nobody fills the
 * field in for. The rule is self-defeating at exactly the moment it has to work.
 *
 * So the launch rule is one-directional AND ANCHORED ON THE RECIPIENT:
 *
 *      A.category ∈ B.owner's lookingForCategories
 *
 * which is to say — you are told because YOU said you wanted this category.
 * That direction is chosen and not arbitrary. The other one-directional
 * reading (B.category ∈ A.lookingForCategories: "tell people who own what the
 * new poster wants") notifies people who never asked for anything, off a
 * stranger's preference, which is a spam engine with a matching feature
 * attached.
 *
 * THE TRADE-OFF, PLAINLY: a one-directional match can be uninteresting to the
 * person notified — they wanted Electronics, this IS Electronics, but the
 * poster does not want what they have, so nothing may come of it. That is a
 * weaker signal than a mutual match and it is a signal the recipient opted
 * into. Mutual matches are strictly better, so they are not discarded: they
 * sort FIRST (see `mutual` below) and the message says so. When the field is
 * widely populated, tightening this to a filter is a one-line change and the
 * sort order is already the evidence for whether it is safe.
 */

// ── The primitive ────────────────────────────────────────────────────────────

/**
 * The categories two sets have in common, in the order of the first.
 *
 * Order matters to the caller: the sentence names `shared[0]`, so a stable
 * order means the same pair of users gets the same sentence twice rather than
 * whichever category the Set happened to yield first.
 */
export function sharedCategories(
  mine: readonly string[],
  theirs: readonly string[],
): string[] {
  if (mine.length === 0 || theirs.length === 0) return []
  const set = new Set(theirs)
  const out: string[] = []
  for (const c of mine) if (set.has(c) && !out.includes(c)) out.push(c)
  return out
}

/**
 * The sentence shown under a suggested trading partner.
 *
 * Extracted from the two routes that each had their own copy. `top` is the
 * candidate's most prominent category and is used only when nothing is shared;
 * with neither, the candidate has no listings worth describing.
 */
export function matchReason(shared: readonly string[], top: string | null | undefined): string {
  if (shared.length > 0) return `Both trading ${categoryLabel(shared[0])}`
  if (top) return `Has ${categoryLabel(top)} you might like`
  return "New to Baylo"
}

// ── The event-triggered path ─────────────────────────────────────────────────

/**
 * How many people one new listing may notify.
 *
 * A CAP, NOT A PAGE SIZE. "FOOD" is a category thousands of listings name, and
 * without a ceiling a single post fans out into a write per matching owner plus
 * a Pusher call each — on the listing-creation path, which is a hot write. The
 * cap makes the cost of posting an item bounded and independent of how popular
 * the category is.
 *
 * Whom it drops when it binds is decided by the ordering in the query below:
 * mutual matches first, then most recently active. So the people cut are the
 * least-interested and least-active, which is the right end to cut from.
 */
export const MATCH_NOTIFY_CAP = 25

/** One matched listing, and why it matched. */
export interface CategoryMatch {
  itemId: string
  ownerId: string
  category: string
  /** True when the overlap runs BOTH ways. Sorted first; worded differently. */
  mutual: boolean
}

/**
 * Find the listings whose owners asked for this item's category.
 *
 * ── WHAT IS EXCLUDED, AND WHY EACH ──────────────────────────────────────────
 *
 *   the poster's own items   you are not a match for yourself, and an org's
 *                            backing row posting means `authorUserId` is the
 *                            org — so this excludes the ORG's other listings,
 *                            which is right, and not the staff member's own.
 *   non-AVAILABLE            IN_TRADE, PENDING_REVIEW, VALUE_REJECTED and
 *                            EXPIRED are all listings nobody can act on.
 *   moderator takedowns      `moderationHiddenAt` — invisible means invisible,
 *                            including to the matcher.
 *   blocked, either way      the single most conspicuous way a half-enforced
 *                            block announces itself is a notification.
 *   suspended owners         a suspended account cannot trade, so telling them
 *                            about a listing is an invitation to a wall.
 *   empty preferences        `hasSome: []` is FALSE in Postgres, so a row with
 *                            no stated preference simply does not match. It is
 *                            not treated as "wants everything", which is the
 *                            reading that would turn this into a broadcast.
 *
 * ONE ROW PER OWNER. `distinct` on ownerId, because a person with six Food
 * listings asked to be told about Food once, not six times.
 */
export async function findCategoryMatches(
  db: Pick<PrismaClient, "item">,
  input: {
    itemId: string
    authorUserId: string
    category: string
    lookingForCategories: readonly string[]
  },
): Promise<CategoryMatch[]> {
  const rows = await db.item.findMany({
    where: {
      id: { not: input.itemId },
      userId: { not: input.authorUserId },
      status: "AVAILABLE",
      moderationHiddenAt: null,
      // The recipient's stated want. THE DIRECTION — see the header.
      lookingForCategories: { has: input.category as never },
      user: {
        deletedAt: null,
        ...userNotBlocked(input.authorUserId),
        ...notSuspendedWhere(),
      },
    },
    select: { id: true, userId: true, category: true },
    distinct: ["userId"],
    // Most recently touched first. The cap cuts from the other end, so what is
    // dropped is the least active — see MATCH_NOTIFY_CAP. Mutual matches are
    // promoted after the fetch rather than in the ORDER BY, because "is my
    // category in THEIR list" is a per-row test the database cannot express as
    // a sort key without a second index it would not otherwise need.
    orderBy: { updatedAt: "desc" },
    // Over-fetch so the mutual promotion has something to promote FROM. Without
    // this the cap is applied before the sort and a mutual match sitting at
    // position 26 is lost to a one-directional one at 25.
    take: MATCH_NOTIFY_CAP * 4,
  })

  const wanted = new Set(input.lookingForCategories)
  return rows
    .map((r) => ({
      itemId: r.id,
      ownerId: r.userId,
      category: r.category as string,
      mutual: wanted.has(r.category as string),
    }))
    .sort((a, b) => Number(b.mutual) - Number(a.mutual))
    .slice(0, MATCH_NOTIFY_CAP)
}

/**
 * The message the recipient reads.
 *
 * It names BOTH categories, because a notification that says only "new Food
 * listing" does not explain why this person is being told. The second half —
 * "you have a Plants listing" — is the reason, and a notification whose reason
 * is not in its own text is one people turn off.
 *
 * "near you" is in the spec's wording and is NOT in this sentence. Nothing in
 * this query is geographic: matches are by category across the whole
 * marketplace, and `pickupLat`/`pickupLng` are not consulted. Writing "near
 * you" would be a claim the code does not make, on the one surface where a
 * user cannot check it.
 */
export function matchMessage(newCategory: string, theirCategory: string, mutual: boolean): string {
  const theirs = categoryLabel(theirCategory)
  const mine = categoryLabel(newCategory)
  return mutual
    ? `New ${mine} listing — and they're looking for ${theirs}, which you have`
    : `New ${mine} listing — you have a ${theirs} listing`
}

/**
 * Notify everyone who asked for this item's category. Fire-and-forget.
 *
 * ── IT NEVER BLOCKS THE CREATE ──────────────────────────────────────────────
 *
 * Same contract as `awardTaskAsync`, and for a stronger reason: this does up to
 * MATCH_NOTIFY_CAP writes and the same number of Pusher calls, and not one of
 * them is worth failing a listing creation over. A caller that awaits this has
 * made posting an item as slow as the slowest of twenty-five network calls.
 * Call it with `void`.
 *
 * The notification rows go in ONE createMany — twenty-five round trips to write
 * twenty-five rows is the shape this deliberately avoids — and the Pusher calls
 * then fan out, each catching its own failure. A dropped push is a notification
 * the client picks up on its next poll; a dropped row is one that never existed.
 * That is why the row is written first and the push is best-effort.
 */
export function notifyCategoryMatchesAsync(input: {
  itemId: string
  authorUserId: string
  category: string
  lookingForCategories: readonly string[]
}): void {
  // Nothing to do for a listing whose category nobody could have asked for by
  // name, and nothing to do before the row is visible to the matcher's query.
  void (async () => {
    const matches = await findCategoryMatches(prisma, input)
    if (matches.length === 0) return

    await prisma.notification.createMany({
      data: matches.map((m) => ({
        userId: m.ownerId,
        type: "CATEGORY_MATCH" as const,
        message: matchMessage(input.category, m.category, m.mutual),
        // The NEW listing, which is the only useful destination. "item" is a
        // new routing token — not "trade", not "conversation"; see the note on
        // Notification.entityType.
        entityType: "item",
        entityId: input.itemId,
        // NO ACTOR. `actorId` is "the person who did this to you", and nobody
        // did anything to the recipient — they posted an item to the
        // marketplace. Setting it would put the poster's face on a
        // notification they did not send, and would let one account spam a
        // recipient's actor-grouped list by posting repeatedly.
        link: `/listings/${input.itemId}`,
      })),
      // The recipient may already have been told about this exact listing if a
      // retry reaches here twice. There is no unique constraint to lean on, so
      // this is a cheap guard and not a guarantee; the cap above is what bounds
      // the damage of a genuine double-send.
      skipDuplicates: true,
    })

    for (const m of matches) {
      pusher
        .trigger(`private-user-${m.ownerId}`, "notification-created", { type: "CATEGORY_MATCH" })
        .catch(() => {})
    }
  })().catch(() => {
    /* Matching is best-effort. A listing must not fail because nobody was told
       about it — and the pull-based matchers above still surface the overlap. */
  })
}
