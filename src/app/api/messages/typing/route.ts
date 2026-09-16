import { NextRequest, NextResponse } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import pusher from "@/lib/pusher"
import { blockDirection } from "@/lib/blocking"

export async function POST(req: NextRequest) {
  try {
    const session = await resolveSession()
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const body = (await req.json()) as { receiverId?: unknown; isTyping?: unknown }
    const receiverId = typeof body.receiverId === "string" ? body.receiverId : ""
    if (!receiverId) return NextResponse.json({ error: "receiverId required" }, { status: 400 })

    if ((await blockDirection(session.user.id, receiverId)) !== "none") {
      return NextResponse.json({ ok: true })
    }

    pusher.trigger(`private-user-${receiverId}`, "typing", {
      senderId: session.user.id,
      senderName: session.user.name ?? "Someone",
      isTyping: body.isTyping === true,
    }).catch(() => {})

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
