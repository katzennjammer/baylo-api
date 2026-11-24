import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok, fail, unauthenticated, notFound } from "@/lib/v1/envelope"
import { parseJsonBody } from "@/lib/v1/body"
import { resolveInbox } from "@/lib/inbox"
import { clearedAt, withCleared } from "@/lib/chat-prefs"

export const dynamic = "force-dynamic"

/**
 * GET   /api/v1/messages/conversations/[partnerId]  -> { muted, clearedAt }
 * PATCH /api/v1/messages/conversations/[partnerId]  { muted?: boolean, clear?: true }
 *
 * Chat info's Mute and Delete chat. Both act on the ACCOUNT reading the chat
 * -- the person, or the shop's backing row while acting as the shop -- and
 * neither touches the other side: muting is silent, and deleting a chat hides
 * it for you only (see @/lib/chat-prefs).
 */

const patchSchema = z.strictObject({
  muted: z.boolean().optional(),
  clear: z.literal(true).optional(),
})

async function owner(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return { error: unauthenticated() } as const
  const inbox = await resolveInbox(session.user.id, req.headers)
  if (!inbox.ok) return { error: fail("ORG_CONTEXT_REFUSED", inbox.message) } as const
  return { inboxId: inbox.inboxId } as const
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ partnerId: string }> }) {
  const who = await owner(req)
  if ("error" in who) return who.error
  const { partnerId } = await params
  const me = await prisma.user.findUnique({
    where: { id: who.inboxId },
    select: { mutedChatUserIds: true, clearedChats: true },
  })
  if (!me) return notFound("Account not found")
  const at = clearedAt(me.clearedChats, partnerId)
  return ok({ partnerId, muted: me.mutedChatUserIds.includes(partnerId), clearedAt: at?.toISOString() ?? null })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ partnerId: string }> }) {
  const who = await owner(req)
  if ("error" in who) return who.error
  const { partnerId } = await params
  const body = await parseJsonBody(req, patchSchema)
  if (!body.ok) return body.response

  const partner = await prisma.user.findUnique({ where: { id: partnerId }, select: { id: true } })
  if (!partner || partnerId === who.inboxId) return notFound("That conversation does not exist")

  const me = await prisma.user.findUnique({
    where: { id: who.inboxId },
    select: { mutedChatUserIds: true, clearedChats: true },
  })
  if (!me) return notFound("Account not found")

  const data: { mutedChatUserIds?: string[]; clearedChats?: Record<string, string> } = {}
  if (body.data.muted !== undefined) {
    const rest = me.mutedChatUserIds.filter((id) => id !== partnerId)
    data.mutedChatUserIds = body.data.muted ? [...rest, partnerId] : rest
  }
  const now = new Date()
  if (body.data.clear) {
    data.clearedChats = withCleared(me.clearedChats, partnerId, now)
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: who.inboxId }, data })
    // A deleted chat leaves no unread badge behind.
    if (body.data.clear) {
      await tx.message.updateMany({
        where: { senderId: partnerId, receiverId: who.inboxId, read: false, createdAt: { lte: now } },
        data: { read: true },
      })
    }
  })

  const muted = data.mutedChatUserIds ? data.mutedChatUserIds.includes(partnerId) : me.mutedChatUserIds.includes(partnerId)
  const at = body.data.clear ? now : clearedAt(me.clearedChats, partnerId)
  return ok({ partnerId, muted, clearedAt: at?.toISOString() ?? null })
}
