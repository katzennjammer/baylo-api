import type { ListingAppealKind, Prisma } from "@/generated/prisma/client"
import prisma from "@/lib/prisma"

/**
 * Listing appeals: the pieces the owner route, the admin routes and the
 * item detail all need to agree on.
 *
 * ── WHAT IS APPEALED IS AN AUDIT ROW ────────────────────────────────────────
 *
 * An appeal is against a DECISION, and the decision's record is the
 * AdminAction written when it was made: LISTING_VALUE_REJECTED for a value
 * review, LISTING_HIDDEN for a takedown. ListingAppeal.actionId points at
 * that row and is unique, which is the whole of the "one appeal per
 * rejection / an upheld appeal cannot be re-opened" rule -- and also why a
 * fresh rejection after the owner edits is a fresh right of appeal: it is a
 * fresh row.
 *
 * ── THE LISTING IS LOCKED WHILE AN APPEAL IS OPEN ───────────────────────────
 *
 * Editing the value, the category or the condition, or deleting the listing,
 * is refused with 409 APPEAL_OPEN. The appeal is a request to publish THIS
 * listing at THIS value; a value that moved under it would leave the admin
 * deciding about a listing that no longer exists. There is no withdraw --
 * the queue is short and the decision closes the lock either way.
 */

export const APPEAL_MESSAGE_MAX = 300

type Db = Prisma.TransactionClient | typeof prisma

/**
 * Which kind of appeal a listing can take right now, or null.
 *
 * A takedown wins over a value rejection when both apply: the takedown is
 * the one the owner cannot undo by editing, so it is the one worth appealing,
 * and an overturned takedown leaves the value state exactly where it was.
 */
export function appealKindFor(item: {
  status: string
  moderationHiddenAt: Date | null
}): ListingAppealKind | null {
  if (item.moderationHiddenAt !== null) return "MODERATION_HIDE"
  if (item.status === "VALUE_REJECTED") return "VALUE_REJECTION"
  return null
}

/**
 * The AdminAction an appeal of `kind` on this listing would be against: the
 * most recent row of the matching kind. Null when there is none, which can
 * only mean the state was reached without an audit row -- a seeded fixture,
 * or a manual UPDATE -- and then there is nothing to appeal.
 */
export function appealableAction(db: Db, itemId: string, kind: ListingAppealKind) {
  return db.adminAction.findFirst({
    where: {
      targetType: "LISTING",
      targetId: itemId,
      action: kind === "MODERATION_HIDE" ? "LISTING_HIDDEN" : "LISTING_VALUE_REJECTED",
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, actorId: true, reason: true, detail: true, createdAt: true },
  })
}

/** TRUE while an appeal on this listing is waiting for a decision. */
export async function hasOpenAppeal(db: Db, itemId: string): Promise<boolean> {
  const n = await db.listingAppeal.count({ where: { itemId, status: "OPEN" } })
  return n > 0
}

/**
 * What the item detail tells the owner about appealing, for the decision
 * currently in force. `canAppeal` is false when there is nothing to appeal,
 * when one is already open, or when one was upheld -- and the `status` says
 * which, so the client can word it.
 */
export async function ownerAppealState(db: Db, item: { id: string; status: string; moderationHiddenAt: Date | null }) {
  const kind = appealKindFor(item)
  if (kind === null) return { id: null, status: null, kind: null, message: null, createdAt: null, decidedAt: null, canAppeal: false }
  const action = await appealableAction(db, item.id, kind)
  if (!action) return { id: null, status: null, kind, message: null, createdAt: null, decidedAt: null, canAppeal: false }
  const appeal = await db.listingAppeal.findUnique({
    where: { actionId: action.id },
    select: { id: true, status: true, message: true, createdAt: true, decidedAt: true },
  })
  return {
    id: appeal?.id ?? null,
    status: appeal?.status ?? null,
    kind,
    message: appeal?.message ?? null,
    createdAt: appeal?.createdAt ?? null,
    decidedAt: appeal?.decidedAt ?? null,
    canAppeal: appeal === null,
  }
}
