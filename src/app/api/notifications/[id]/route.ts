import { NextRequest, NextResponse } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { legacyOrgRefusal, resolveInbox, shopBellWhere } from "@/lib/inbox"

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await resolveSession()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // The row must belong to the current inbox: the person's, or the shop's
  // while acting as it -- and, for a shop, be a type its bell shows. See
  // shopBellWhere() in @/lib/inbox.
  const inbox = await resolveInbox(session.user.id, req.headers)
  if (!inbox.ok) return legacyOrgRefusal(inbox.message)

  const { id } = await params

  await prisma.notification.updateMany({
    where: { id, userId: inbox.inboxId, AND: inbox.acting.organization ? [shopBellWhere()] : [] },
    data: { read: true },
  })

  return NextResponse.json({ ok: true })
}
