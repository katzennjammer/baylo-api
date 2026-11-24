import { after } from "next/server"

/**
 * Phone push for every bell notification (20 Oct 2026).
 *
 * ── ONE HOOK, NOT TWENTY-EIGHT ──────────────────────────────────────────────
 *
 * Notifications are written by ~28 call sites. Rather than teach each one to
 * push, the Prisma client (@/lib/prisma) hands the new rows to
 * schedulePush*() after notification.create / createMany. So anything that
 * lights the bell also buzzes the phone, including code written later.
 *
 * ── AFTER THE RESPONSE, AND ONLY IF THE ROW SURVIVED ────────────────────────
 *
 * Many of those writes sit inside an interactive transaction that can still
 * roll back. The push therefore runs in `after()` -- once the request is done,
 * so the transaction has committed or not -- and re-reads the rows: a rolled-
 * back notification is simply not found, and nothing is sent. Outside a
 * request (a tsx script) after() throws and the send runs straight away.
 *
 * ── WHO GETS IT ─────────────────────────────────────────────────────────────
 *
 * The recipient's own token (User.pushToken, one phone per account). A shop's
 * notifications belong to its backing row, which cannot sign in, so those go
 * to the shop's OWNER, titled with the shop's name.
 *
 * ── WHAT IT SAYS ────────────────────────────────────────────────────────────
 *
 * "<actor> <notification text>", never the message body: a lock screen is
 * not a private place. The data carries the notification's own fields, so the
 * app routes a tap exactly as it routes a tap on the bell's row.
 *
 * Best effort throughout: a failed push is logged and dropped, never retried,
 * never allowed to fail the request that caused it.
 */

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
/** Expo accepts up to 100 messages per request. */
const BATCH = 100

const TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,}\]$/

export function isExpoPushToken(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && TOKEN.test(value)
}

export interface PushRow {
  id: string
  type: string
  message: string
  link: string | null
  entityType: string | null
  entityId: string | null
  userId: string
  actorId: string | null
  actorName: string | null
}

export interface PushMessage {
  to: string
  title: string
  body: string
  sound: "default"
  priority: "high"
  channelId: "alerts"
  data: { notificationId: string; type: string; link: string | null; entityType: string | null; entityId: string | null; actorId: string | null }
}

/**
 * Pure: notification rows -> Expo messages.
 * `tokens` maps a user id to its push token; `shops` maps a shop's backing
 * user id to its owner and name. Rows with nobody to reach are dropped.
 */
export function buildPushMessages(
  rows: PushRow[],
  tokens: Map<string, string>,
  shops: Map<string, { ownerId: string; name: string }>,
): PushMessage[] {
  const out: PushMessage[] = []
  for (const row of rows) {
    const shop = shops.get(row.userId)
    const to = tokens.get(shop ? shop.ownerId : row.userId)
    if (!to) continue
    const text = row.message.trim()
    // The actor is the sentence's subject, as on the bell -- unless the text
    // already names them ("Aj cancelled the trade for ...").
    const body =
      row.actorName && !text.startsWith(row.actorName)
        ? `${row.actorName} ${text}`
        : text.charAt(0).toUpperCase() + text.slice(1)
    out.push({
      to,
      title: shop ? shop.name : "Baylo",
      body,
      sound: "default",
      priority: "high",
      channelId: "alerts",
      data: {
        notificationId: row.id,
        type: row.type,
        link: row.link,
        entityType: row.entityType,
        entityId: row.entityId,
        actorId: row.actorId,
      },
    })
  }
  return out
}

/**
 * Pure: drops chat-message rows from people the recipient muted (Chat info >
 * Mute). Only NEW_MESSAGE: muting a person quiets their chat, not offers or
 * trades with them. For a shop's inbox the OWNER's mute list applies, since
 * the owner's phone is the one that would buzz.
 */
export function withoutMuted(
  rows: PushRow[],
  muted: Map<string, Set<string>>,
  shops: Map<string, { ownerId: string; name: string }>,
): PushRow[] {
  return rows.filter((row) => {
    if (row.type !== "NEW_MESSAGE" || !row.actorId) return true
    const phoneOwner = shops.get(row.userId)?.ownerId ?? row.userId
    return !muted.get(phoneOwner)?.has(row.actorId)
  })
}

/** Pure: the tokens Expo says are no longer installed, to forget. */
export function deadTokens(messages: PushMessage[], tickets: unknown): string[] {
  if (!Array.isArray(tickets)) return []
  const dead: string[] = []
  tickets.forEach((t, i) => {
    const ticket = t as { status?: string; details?: { error?: string } }
    if (ticket?.status === "error" && ticket.details?.error === "DeviceNotRegistered" && messages[i]) {
      dead.push(messages[i].to)
    }
  })
  return dead
}

function later(work: () => Promise<void>): void {
  const run = () => work().catch((err) => console.error("[push]", err instanceof Error ? err.message : err))
  try {
    after(run)
  } catch {
    void run()
  }
}

/** notification.create: the row's id. */
export function schedulePushForIds(ids: string[]): void {
  if (ids.length === 0) return
  later(() => sendFor({ id: { in: ids } }))
}

/**
 * notification.createMany returns a count, not rows. Find them again: same
 * recipients and types, written in the last few seconds and still unread. A
 * same-second duplicate from another request can ride along; one extra buzz
 * is the ceiling of that.
 */
export function schedulePushForBatch(data: { userId?: unknown; type?: unknown }[]): void {
  const userIds = [...new Set(data.map((d) => d.userId).filter((v): v is string => typeof v === "string"))]
  const types = [...new Set(data.map((d) => d.type).filter((v): v is string => typeof v === "string"))]
  if (userIds.length === 0) return
  const since = new Date(Date.now() - 10_000)
  later(() =>
    sendFor({
      userId: { in: userIds },
      ...(types.length > 0 && { type: { in: types } }),
      read: false,
      createdAt: { gte: since },
    }),
  )
}

async function sendFor(where: Record<string, unknown>): Promise<void> {
  // Imported here, not at the top: @/lib/prisma imports this module to install
  // the hook, and the client must finish constructing first.
  const { default: prisma } = await import("@/lib/prisma")

  const found = await prisma.notification.findMany({
    where: where as never,
    select: {
      id: true, type: true, message: true, link: true, entityType: true,
      entityId: true, userId: true, actorId: true, actor: { select: { name: true } },
    },
  })
  if (found.length === 0) return
  const rows: PushRow[] = found.map(({ actor, ...r }) => ({ ...r, type: String(r.type), actorName: actor?.name ?? null }))

  const recipientIds = [...new Set(rows.map((r) => r.userId))]
  const orgs = await prisma.organization.findMany({
    where: { orgUserId: { in: recipientIds } },
    select: { orgUserId: true, ownerId: true, name: true },
  })
  const shops = new Map(orgs.map((o) => [o.orgUserId, { ownerId: o.ownerId, name: o.name }]))
  const people = [...new Set([...recipientIds, ...orgs.map((o) => o.ownerId)])]
  const users = await prisma.user.findMany({
    where: { id: { in: people }, pushToken: { not: null } },
    select: { id: true, pushToken: true, mutedChatUserIds: true },
  })
  const tokens = new Map(users.map((u) => [u.id, u.pushToken as string]))
  const muted = new Map(users.map((u) => [u.id, new Set(u.mutedChatUserIds)]))

  const messages = buildPushMessages(withoutMuted(rows, muted, shops), tokens, shops)
  for (let i = 0; i < messages.length; i += BATCH) {
    const batch = messages.slice(i, i + BATCH)
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(process.env.EXPO_ACCESS_TOKEN && { authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` }),
      },
      body: JSON.stringify(batch),
    })
    if (!res.ok) {
      console.error(`[push] Expo answered ${res.status}`)
      continue
    }
    const gone = deadTokens(batch, ((await res.json()) as { data?: unknown }).data)
    if (gone.length > 0) {
      await prisma.user.updateMany({ where: { pushToken: { in: gone } }, data: { pushToken: null } })
    }
  }
}
