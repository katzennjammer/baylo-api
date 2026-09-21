import prisma from "@/lib/prisma"

type SystemMessageInput = {
  eventKey: string
  senderId: string
  receiverId: string
  tradeId?: string
  content: string
}

export async function createSystemMessage(input: SystemMessageInput) {
  try {
    return await prisma.message.create({
      data: {
        systemEventKey: input.eventKey,
        senderId: input.senderId,
        receiverId: input.receiverId,
        tradeId: input.tradeId,
        content: input.content,
        read: false,
      },
    })
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      const existing = await prisma.message.findUnique({ where: { systemEventKey: input.eventKey } })
      if (existing) return existing
    }
    throw error
  }
}