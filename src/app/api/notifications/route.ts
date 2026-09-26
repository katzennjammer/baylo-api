import { NextRequest, NextResponse } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { legacyOrgRefusal, resolveInbox, shopBellWhere } from "@/lib/inbox"

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
      AND: inbox.acting.organization ? [shopBellWhere()] : [],
    },
    data: { read: true },
  })

  return NextResponse.json({ ok: true })
}
