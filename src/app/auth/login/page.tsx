import prisma from "@/lib/prisma"
import { asTrades } from "@/lib/trade-row"
import LoginClient, { type SwapDisplay } from "./LoginClient"
import { isLeavesOnlyTrade } from "@/lib/trade-format"
import { ITEM_IMAGES, toImageUrls, type ImagesLike } from "@/lib/item-images"

function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime()
  const diffMins = Math.floor(diffMs / 60_000)
  if (diffMins < 1) return "just now"
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays}d ago`
}

function parseFirstImage(raw: ImagesLike): string | null {
  return toImageUrls(raw)[0] ?? null
}

export default async function LoginPage() {
  const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
  const [rawSwaps, userCount, recentUsers] = await Promise.all([
    prisma.trade.findMany({
      where: { status: "COMPLETED" },
      orderBy: { updatedAt: "desc" },
      take: 3,
      select: {
        id: true,
        updatedAt: true,
        senderId: true,
        offeredItemId: true,
        requestedItemId: true,
        sender: { select: { name: true } },
        receiver: { select: { name: true } },
        offeredLeaves: true,
        offeredItem: { select: { title: true, images: ITEM_IMAGES } },
        requestedItem: { select: { title: true, images: ITEM_IMAGES } },
      },
    }).then(asTrades),
    prisma.user.count(),
    prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      take: 4,
      select: { id: true, name: true, avatar: true },
    }),
  ])

  // offeredLeaves for any Leaves-only completed trades. Since schema v2 it is
  // on the deal's own row; it used to be recovered from the accepted Offer by
  // sender + listing, which was not unique.
  const loginOfferedLeavesMap = new Map<string, number>()
  for (const t of rawSwaps) {
    if (isLeavesOnlyTrade(t.offeredItemId, t.requestedItemId) && (t.offeredLeaves ?? 0) > 0) {
      loginOfferedLeavesMap.set(t.id, t.offeredLeaves as number)
    }
  }

  const swaps: SwapDisplay[] = rawSwaps.map((t) => ({
    id: t.id,
    when: formatRelativeTime(t.updatedAt),
    senderFirstName: t.sender.name.split(" ")[0],
    receiverFirstName: t.receiver.name.split(" ")[0],
    offeredLeaves: loginOfferedLeavesMap.get(t.id) ?? null,
    itemA: {
      title: t.offeredItem.title,
      image: parseFirstImage(t.offeredItem.images),
    },
    itemB: {
      title: t.requestedItem.title,
      image: parseFirstImage(t.requestedItem.images),
    },
  }))

  return <LoginClient swaps={swaps} userCount={userCount} recentUsers={recentUsers} googleEnabled={googleEnabled} />
}
