import type { Prisma } from "@/generated/prisma/client"

/**
 * Per-account chat preferences, in two User columns the owner approved on
 * 4 Nov 2026 (no new table):
 *
 *   mutedChatUserIds  people whose chat messages send this account no push.
 *   clearedChats      { [partnerId]: ISO time } -- "Delete chat" for this
 *                     account only. Messages with that partner up to that
 *                     time are hidden from this account. The other person
 *                     keeps theirs, and moderators still see every row: the
 *                     messages are hidden, never deleted.
 */

/** The cleared-at time for one partner, or null. Tolerates a malformed value. */
export function clearedAt(cleared: Prisma.JsonValue | null | undefined, partnerId: string): Date | null {
  if (!cleared || typeof cleared !== "object" || Array.isArray(cleared)) return null
  const raw = (cleared as Record<string, unknown>)[partnerId]
  if (typeof raw !== "string") return null
  const at = new Date(raw)
  return Number.isNaN(at.getTime()) ? null : at
}

/** `cleared` with `partnerId` set to `at`. Never mutates its input. */
export function withCleared(
  cleared: Prisma.JsonValue | null | undefined,
  partnerId: string,
  at: Date,
): Record<string, string> {
  const base =
    cleared && typeof cleared === "object" && !Array.isArray(cleared)
      ? Object.fromEntries(Object.entries(cleared as Record<string, unknown>).filter(([, v]) => typeof v === "string"))
      : {}
  return { ...(base as Record<string, string>), [partnerId]: at.toISOString() }
}
