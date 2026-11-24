import { NextRequest, NextResponse } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { excludeDirectMessageNotifications, legacyOrgRefusal, resolveInbox, shopBellWhere } from "@/lib/inbox"

// Mark all unread notifications as read for the current inbox -- the person's,
// or the shop's while acting as it. See @/lib/inbox. A shop marks only what
// its bell shows (shopBellWhere): the rest stay unread until their type works
// as a shop and they appear.
export async function PATCH(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const inbox = await resolveInbox(session.user.id, req.headers)
  if (!inbox.ok) return legacyOrgRefusal(inbox.message)

  await prisma.notification.updateMany({
    where: {
      userId: inbox.inboxId,
      read: false,
      ...excludeDirectMessageNotifications(),
      AND: inbox.acting.organization ? [shopBellWhere()] : [],
    },
    data: { read: true },
  })

  return NextResponse.json({ ok: true })
}

/**
 * DELETE /api/notifications -- "Clear all" (16 Nov 2026).
 *
 * Removes everything the current bell SHOWS: the person's, or the shop's
 * while acting as it (shopBellWhere), never the hidden direct-message rows.
 * Deleted rather than hidden because the table has no hide column (schema
 * freeze), the same as account deletion does with notifications.
 *
 * ONE EXCEPTION: the "suspension ended" notice (entityType "suspension") is
 * also the record that the person has been told (notifySuspensionEnded() in
 * @/lib/moderation). Deleting it would make the notice come back at the next
 * sign-in, so it stays.
 */
export async function DELETE(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const inbox = await resolveInbox(session.user.id, req.headers)
  if (!inbox.ok) return legacyOrgRefusal(inbox.message)

  const cleared = await prisma.notification.deleteMany({
    where: {
      userId: inbox.inboxId,
      ...excludeDirectMessageNotifications(),
      AND: [
        ...(inbox.acting.organization ? [shopBellWhere()] : []),
        { OR: [{ entityType: null }, { entityType: { not: "suspension" } }] },
      ],
    },
  })

  return NextResponse.json({ ok: true, cleared: cleared.count })
}
