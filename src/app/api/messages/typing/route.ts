import { NextRequest, NextResponse } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import pusher from "@/lib/pusher"
import { blockDirection } from "@/lib/blocking"
import { legacyOrgRefusal, resolveInbox } from "@/lib/inbox"

export async function POST(req: NextRequest) {
  try {
    const session = await resolveSession()
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    // Acting as a shop, the shop is typing: the partner's thread filters these
    // events on the id it is talking to, which is the shop's backing row.
    const inbox = await resolveInbox(session.user.id, req.headers)
    if (!inbox.ok) return legacyOrgRefusal(inbox.message)
    const senderId = inbox.inboxId

    const body = (await req.json()) as { receiverId?: unknown; isTyping?: unknown }
    const receiverId = typeof body.receiverId === "string" ? body.receiverId : ""
    if (!receiverId) return NextResponse.json({ error: "receiverId required" }, { status: 400 })

    if ((await blockDirection(senderId, receiverId)) !== "none") {
      return NextResponse.json({ ok: true })
    }

    pusher.trigger(`private-user-${receiverId}`, "typing", {
      senderId,
      senderName: inbox.acting.organization?.name ?? session.user.name ?? "Someone",
      isTyping: body.isTyping === true,
    }).catch(() => {})

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
