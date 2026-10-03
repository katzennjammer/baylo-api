import prisma from "@/lib/prisma"
import { bracketOf } from "@/lib/brackets"
import { VALUE_REJECTION_REASONS } from "@/lib/value-rejection"
import { ITEM_IMAGES, toImageUrls, type ImagesLike } from "@/lib/item-images"

/**
 * The appeals queue's rows, loaded and shaped once for both readers: the
 * JSON route (GET /api/admin/appeals) and the server-rendered admin page.
 * A route file may export only handlers, which is why this is not in one.
 */

function parseFirstImage(raw: ImagesLike): string | null {
  return toImageUrls(raw)[0] ?? null
}

export async function loadAppeals(status: "open" | "decided", limit: number) {
  // LISTING_APPEAL rows of ModerationCase (schema v2), mapped back to the
  // appeal shape below so the queue pages and shapeAppeal() are unchanged.
  const rows = await prisma.moderationCase.findMany({
    where: { type: "LISTING_APPEAL", ...(status === "open" ? { status: "OPEN" as const } : { status: { in: ["UPHELD" as const, "OVERTURNED" as const, "WITHDRAWN" as const] } }) },
    select: {
      id: true, appealKind: true, status: true, message: true, actionId: true, createdAt: true,
      decidedAt: true, decisionNote: true,
      decidedBy: { select: { id: true, name: true } },
      filedBy: { select: { id: true, name: true, email: true } },
      item: {
        select: {
          id: true, title: true, status: true, category: true, condition: true, images: ITEM_IMAGES,
          valueLeaves: true, suggestedLeaves: true, moderationHiddenAt: true, valueRejectionReason: true,
        },
      },
    },
    orderBy: status === "open" ? [{ createdAt: "asc" }, { id: "asc" }] : [{ decidedAt: "desc" }, { id: "desc" }],
    take: limit,
  })
  // The CHECK constraint guarantees every LISTING_APPEAL row has these four.
  const appeals = rows.map(({ appealKind, decisionNote, filedBy, item, actionId, message, ...rest }) => ({
    ...rest,
    kind: appealKind!,
    decisionReason: decisionNote,
    owner: filedBy,
    item: item!,
    actionId: actionId!,
    message: message!,
  }))

  // The decisions being appealed, in one query. actionId is a plain string
  // (the audit is pointed at, never joined), so this is the join by hand.
  const actionIds = appeals.map((a) => a.actionId)
  const actions = actionIds.length
    ? await prisma.adminAction.findMany({
        where: { id: { in: actionIds } },
        select: { id: true, actorId: true, reason: true, detail: true, createdAt: true, actor: { select: { id: true, name: true } } },
      })
    : []
  const actionById = new Map(actions.map((a) => [a.id, a]))
  return appeals.map((a) => ({ ...a, action: actionById.get(a.actionId) ?? null }))
}

export type AppealRow = Awaited<ReturnType<typeof loadAppeals>>[number]

export function shapeAppeal(a: AppealRow, viewerId: string) {
  const detail = parseDetail(a.action?.detail)
  const reasonCode = typeof detail.reasonCode === "string" ? detail.reasonCode : null
  return {
    id: a.id,
    kind: a.kind,
    status: a.status,
    message: a.message,
    createdAt: a.createdAt,
    owner: a.owner,
    listing: {
      id: a.item.id,
      title: a.item.title,
      status: a.item.status,
      category: a.item.category,
      condition: a.item.condition,
      imageUrl: parseFirstImage(a.item.images),
      hidden: a.item.moderationHiddenAt !== null,
      requestedLeaves: a.item.valueLeaves,
      suggestedLeaves: a.item.suggestedLeaves,
      requestedBracket: a.item.valueLeaves === null ? null : bracketOf(a.item.valueLeaves),
      suggestedBracket: a.item.suggestedLeaves === null ? null : bracketOf(a.item.suggestedLeaves),
    },
    decision: a.action
      ? {
          actionId: a.action.id,
          by: a.action.actor,
          at: a.action.createdAt,
          // For a value rejection: the code the owner saw and the note they
          // did not. For a takedown: the typed reason.
          reasonCode,
          reasonLabel: reasonCode ? (VALUE_REJECTION_REASONS[reasonCode as keyof typeof VALUE_REJECTION_REASONS]?.label ?? reasonCode) : null,
          note: typeof detail.note === "string" ? detail.note : null,
          reason: a.action.reason,
        }
      : null,
    sameReviewer: a.action?.actorId === viewerId,
    decidedBy: a.decidedBy,
    decidedAt: a.decidedAt,
    decisionReason: a.decisionReason,
  }
}

function parseDetail(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const v: unknown = JSON.parse(raw)
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
