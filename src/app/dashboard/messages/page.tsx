import { redirect } from "next/navigation"
import { auth } from "@root/auth"
import prisma from "@/lib/prisma"
import DashShell from "../_shell/DashShell"
import MessagesClient from "./MessagesClient"
import { describeMessage } from "@/lib/chat-helpers"

export const dynamic = "force-dynamic"
export const revalidate = 0

export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ partner?: string }>
}) {
  const session = await auth()
  if (!session?.user?.id) redirect("/auth/login")
  const { partner: initialPartnerId } = await searchParams

  const userId = session.user.id

  const [conversations, hiddenRows] = await Promise.all([
    prisma.message.findMany({
      where: { OR: [{ senderId: userId }, { receiverId: userId }] },
      include: {
        sender: { select: { id: true, name: true, avatar: true } },
        receiver: { select: { id: true, name: true, avatar: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.conversationHide.findMany({
      where: { viewerId: userId },
      select: { partnerId: true },
    }),
  ])

  const hiddenPartners = new Set(hiddenRows.map((row) => row.partnerId))

  const seen = new Set<string>()
  const uniqueConversations = conversations.filter((msg) => {
    const partnerId = msg.senderId === userId ? msg.receiverId : msg.senderId
    if (hiddenPartners.has(partnerId)) return false
    if (seen.has(partnerId)) return false
    seen.add(partnerId)
    return true
  })

  return (
    <DashShell title="Messages" description="Your conversations">
      {uniqueConversations.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-2xl border border-gray-100 text-gray-400">
          <p className="text-lg mb-1">No messages yet.</p>
          <p className="text-sm">Start a conversation by sending a trade request.</p>
        </div>
      ) : (
        <MessagesClient
          conversations={uniqueConversations.map((msg) => {
            const partner = msg.senderId === userId ? msg.receiver : msg.sender
            return {
              partnerId: partner.id,
              partnerName: partner.name,
              partnerAvatar: partner.avatar,
              lastMessage: describeMessage(msg.content),
              lastMessageDate: msg.createdAt.toISOString(),
              unread: !msg.read && msg.receiverId === userId,
            }
          })}
          currentUserId={userId}
          initialPartnerId={initialPartnerId}
        />
      )}
    </DashShell>
  )
}
