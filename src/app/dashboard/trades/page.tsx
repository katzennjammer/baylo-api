import { auth } from "@/../auth"
import { redirect } from "next/navigation"
import prisma from "@/lib/prisma"
import { asTrades, asOffer, OFFERED_ITEM_REF, IN_TRADE_PHASE } from "@/lib/trade-row"
import { CO2_PER_CATEGORY, computeImpactData } from "@/lib/impact-constants"
import { isLeavesOnlyTrade } from "@/lib/trade-format"
import TradesClient from "./TradesClient"
import { describeMessage } from "@/lib/chat-helpers"
import { ITEM_IMAGES, toImageUrls, type ImagesLike } from "@/lib/item-images"

const CATEGORY_HASHTAG: Record<string, string> = {
  ELECTRONICS: "#Electronics",
  CLOTHING:    "#Fashion",
  FURNITURE:   "#HomeGarden",
  BOOKS:       "#BooksMedia",
  SPORTS:      "#Sports",
  TOYS:        "#KidsToys",
  TOOLS:       "#ToolsDIY",
  FOOD:        "#Food",
  SERVICES:    "#Services",
  OTHER:       "#Miscellaneous",
}

export const dynamic = "force-dynamic"
export const revalidate = 0

function firstImage(raw: ImagesLike): string | null {
  return toImageUrls(raw)[0] ?? null
}

function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

const NOTIF_ICON: Record<string, string> = {
  TRADE_REQUEST:   "swap",
  TRADE_ACCEPTED:  "check",
  TRADE_REJECTED:  "bolt",
  TRADE_COMPLETED: "star",
  TRADE_CANCELLED: "bolt",
  NEW_MESSAGE:     "chat",
  NEW_REVIEW:      "star",
}

export default async function TradesPage() {
  const session = await auth()
  if (!session?.user?.id) redirect("/auth/login")
  const myId = session.user.id

  const now = new Date()
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

  const [user, trades, rawOffers, rawMsgs, rawNotifs, followReqCount, weeklyCount, weeklyTradesRaw, trendingRaw] = await Promise.all([
    prisma.user.findUnique({
      where: { id: myId },
      select: { name: true, avatar: true, leaves: true },
    }),
    prisma.trade.findMany({
      where: {
        ...IN_TRADE_PHASE,
        OR: [
          { senderId: myId },
          { receiverId: myId },
        ],
      },
      select: {
        // tradeCreatedAt: when the deal became a trade, shown as createdAt below.
        id: true, status: true, tradeCreatedAt: true, updatedAt: true, offeredLeaves: true,
        senderId: true, receiverId: true,
        offeredItemId: true, requestedItemId: true,
        offeredItem:   { select: { id: true, title: true, images: ITEM_IMAGES, category: true, status: true, valueLeaves: true } },
        requestedItem: { select: { id: true, title: true, images: ITEM_IMAGES, category: true, status: true, valueLeaves: true } },
        sender:        { select: { id: true, name: true, avatar: true } },
        receiver:      { select: { id: true, name: true, avatar: true } },
        reviews:       { where: { reviewerId: myId }, select: { id: true, rating: true } },
      },
      orderBy: { updatedAt: "desc" },
    }).then(asTrades),
    // Incoming offers: offers where the current user is the listing owner (receiver)
    prisma.trade.findMany({
      where: { receiverId: myId, offerStatus: "PENDING" },
      include: {
        requestedItem: { select: { id: true, title: true, images: ITEM_IMAGES, valueLeaves: true } },
        offeredItem: OFFERED_ITEM_REF,
        sender: { select: { id: true, name: true, avatar: true, rating: true, totalTrades: true } },
      },
      orderBy: { createdAt: "desc" },
    }).then((rows) => rows.map(asOffer)),
    prisma.message.findMany({
      where: { receiverId: myId },
      include: { sender: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    prisma.notification.findMany({
      where: { userId: myId },
      include: { actor: { select: { name: true, avatar: true } } },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.follow.count({
      where: { followeeId: myId, status: "PENDING" },
    }),
    // Weekly completed trade count for the sidebar goal widget
    prisma.trade.count({
      where: {
        OR: [{ senderId: myId }, { receiverId: myId }],
        status: "COMPLETED",
        updatedAt: { gte: weekAgo },
      },
    }),
    // Weekly completed trades with categories — for CO₂ calc
    prisma.trade.findMany({
      where: {
        OR: [{ senderId: myId }, { receiverId: myId }],
        status: "COMPLETED",
        updatedAt: { gte: weekAgo },
      },
      select: {
        senderId:      true,
        offeredItem:   { select: { category: true } },
        requestedItem: { select: { category: true } },
      },
    }).then(asTrades),
    // Trending: most-used categories in the last 7 days
    prisma.item.groupBy({
      by: ["category"],
      where: { createdAt: { gte: weekAgo }, status: { not: "REMOVED" } },
      _count: { id: true },
      orderBy: { _count: { id: "desc" } },
      take: 5,
    }),
  ])

  if (!user) redirect("/auth/login")

  // Collect all offered item IDs so we can fetch their details (title, image, valueLeaves)
  const allOfferedItemIds = new Set<string>()
  for (const o of rawOffers) {
    try {
      const items: { id: string }[] = JSON.parse(o.offeredItems)
      items.forEach((i) => allOfferedItemIds.add(i.id))
    } catch {
      // malformed JSON — skip
    }
  }

  const offeredItemDetails =
    allOfferedItemIds.size > 0
      ? await prisma.item.findMany({
          where: { id: { in: [...allOfferedItemIds] } },
          select: { id: true, title: true, images: ITEM_IMAGES, valueLeaves: true },
        })
      : []

  const itemMap = new Map(offeredItemDetails.map((i) => [i.id, i]))

  // ── Leaves-only: offeredLeaves ───────────────────────────────────────────
  // For Leaves-only trades, offeredItemId === requestedItemId (placeholder).
  // The amount is on the deal's own row since schema v2; it used to be
  // recovered from the accepted Offer by (senderId, postId), which was not unique.
  const offeredLeavesMap = new Map<string, number>() // tradeId → Leaves
  for (const t of trades) {
    if (isLeavesOnlyTrade(t.offeredItemId, t.requestedItemId) && (t.offeredLeaves ?? 0) > 0) {
      offeredLeavesMap.set(t.id, t.offeredLeaves as number)
    }
  }

  // ── Serialize trades ─────────────────────────────────────────────────────
  const serializedTrades = trades.map((t) => {
    let co2Saved: number | null = null
    if (t.status === "COMPLETED") {
      const givenCategory = t.senderId === myId ? t.offeredItem.category : t.requestedItem.category
      const kg = CO2_PER_CATEGORY[givenCategory as string]
      if (kg !== undefined && kg > 0) co2Saved = kg
    }

    // Leaves value of "my item" (the item I'm trading away)
    const myItemRaw    = t.senderId === myId ? t.offeredItem   : t.requestedItem
    const myItemLeaves = myItemRaw.valueLeaves

    return {
      id:            t.id,
      status:        t.status as string,
      createdAt:     (t.tradeCreatedAt ?? t.updatedAt).toISOString(),
      updatedAt:     t.updatedAt.toISOString(),
      offeredItem:   {
        id:             t.offeredItem.id,
        title:          t.offeredItem.title,
        image:          firstImage(t.offeredItem.images),
        category:       t.offeredItem.category as string,
        itemStatus:     t.offeredItem.status   as string,
        valueLeaves: t.offeredItem.valueLeaves ?? null,
      },
      requestedItem: {
        id:             t.requestedItem.id,
        title:          t.requestedItem.title,
        image:          firstImage(t.requestedItem.images),
        category:       t.requestedItem.category as string,
        itemStatus:     t.requestedItem.status   as string,
        valueLeaves: t.requestedItem.valueLeaves ?? null,
      },
      sender:           { id: t.sender.id,   name: t.sender.name,   avatar: t.sender.avatar   ?? null },
      receiver:         { id: t.receiver.id, name: t.receiver.name, avatar: t.receiver.avatar ?? null },
      co2Saved,
      myItemLeaves,
      offeredLeaves: offeredLeavesMap.get(t.id) ?? null,
      myReview: t.reviews[0] ? { rating: t.reviews[0].rating } : null,
    }
  })

  // ── Serialize offers ──────────────────────────────────────────────────────
  const serializedOffers = rawOffers.map((o) => {
    const parsedItems: { id: string }[] = (() => {
      try { return JSON.parse(o.offeredItems) } catch { return [] }
    })()

    const firstItemDetails = parsedItems[0] ? itemMap.get(parsedItems[0].id) : null
    const postValue      = o.post.valueLeaves
    const offeredValue   = firstItemDetails?.valueLeaves ?? null

    let fairness: "low" | "fair" | "generous" | null = null
    if (postValue !== null && offeredValue !== null && postValue > 0) {
      const ratio = offeredValue / postValue
      fairness = ratio >= 1.2 ? "generous" : ratio >= 0.8 ? "fair" : "low"
    }

    return {
      id:           o.id,
      createdAt:    o.createdAt.toISOString(),
      post: {
        id:    o.post.id,
        title: o.post.title,
        image: firstImage(o.post.images),
      },
      sender: {
        id:          o.sender.id,
        name:        o.sender.name,
        avatar:      o.sender.avatar ?? null,
        rating:      o.sender.rating,
        totalTrades: o.sender.totalTrades,
      },
      offeredItems: parsedItems.map((item) => {
        const d = itemMap.get(item.id)
        return { id: item.id, title: d?.title ?? "Item", image: d ? firstImage(d.images) : null }
      }),
      offeredLeaves: o.offeredLeaves ?? null,
      fairness,
    }
  })

  const weeklyBase   = computeImpactData(myId, weeklyTradesRaw)
  const weeklyCO2    = weeklyBase.co2Avoided
  const trendingTags = trendingRaw.map((r) => CATEGORY_HASHTAG[r.category] ?? `#${r.category}`)

  const handle = user.name.toLowerCase().replace(/\s+/g, "").slice(0, 20)

  const msgSeen = new Set<string>()
  const messages = rawMsgs
    .filter((m) => { if (msgSeen.has(m.senderId)) return false; msgSeen.add(m.senderId); return true })
    .slice(0, 5)
    .map((m) => ({
      name:      m.sender.name,
      preview:      describeMessage(m.content),
      time:      timeAgo(m.createdAt),
      unread:    !m.read,
      partnerId: m.senderId,
    }))

  type NotificationIcon = keyof typeof NOTIF_ICON | "bell"

  const notifications = rawNotifs.map((n) => ({
    id:      n.id,
    who:     n.actor?.name ?? "Baylo",
    avatar:  n.actor?.avatar ?? null,
    icon:    (NOTIF_ICON[n.type] ?? "bell") as NotificationIcon,
    text:    n.message,
    link:    n.link ?? null,
    time:    timeAgo(n.createdAt),
    unread:  !n.read,
    actorId: n.actorId ?? null,
  }))

  return (
    <TradesClient
      me={{ name: user.name, handle, avatar: user.avatar ?? null, leaves: user.leaves }}
      trades={serializedTrades}
      initialOffers={serializedOffers}
      myId={myId}
      followReqCount={followReqCount}
      notifs={notifications}
      messages={messages}
      weeklyTrades={weeklyCount}
      weeklyCO2={weeklyCO2}
      trendingTags={trendingTags}
    />
  )
}
