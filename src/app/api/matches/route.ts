import { NextResponse } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { userNotBlocked } from "@/lib/blocking"
import { notSuspendedWhere } from "@/lib/moderation"
import { sharedCategories, matchReason } from "@/lib/category-match"
import { notAnOrgWhere } from "@/lib/organizations"
import { categoryLabel } from "@/lib/v1/taxonomy"

export const dynamic = "force-dynamic"

/*
 * THE LOCAL CATEGORY_LABEL MAP IS GONE (23 Sep 2026).
 *
 * It listed ten of the twenty categories, so BAGS, BEAUTY, ACCESSORIES,
 * GAMING, BIKES, MUSIC, ART, COLLECTIBLES, PETS and PLANTS all fell through to
 * the bare enum name and this endpoint answered "Both trading PLANTS". The
 * overlap and the sentence now come from @/lib/category-match, which uses the
 * complete taxonomy — the same one /api/v1/home and the event-triggered
 * matcher use.
 */

export async function GET() {
  const session = await resolveSession()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const userId = session.user.id

  const [myItemCats, candidates] = await Promise.all([
    prisma.item.findMany({
      where: { userId, status: "AVAILABLE" },
      select: { category: true },
    }),
    prisma.user.findMany({
      where: {
        id: { not: userId },
        deletedAt: null,
        items: { some: { status: "AVAILABLE", moderationHiddenAt: null } },
        // Never suggest someone you blocked, or who blocked you, as a match.
        ...userNotBlocked(userId),
        ...notSuspendedWhere(),
        // This list is PEOPLE. See the same call in /api/v1/home.
        ...notAnOrgWhere(),
      },
      select: {
        name: true,
        totalTrades: true,
        items: {
          where: { status: "AVAILABLE", moderationHiddenAt: null },
          select: { category: true },
          take: 5,
        },
      },
      orderBy: { updatedAt: "desc" },
      take: 5,
    }),
  ])

  const myCategories = myItemCats.map((i) => i.category)

  const matches = candidates.map((u) => {
    const cats = [...new Set(u.items.map((i) => i.category))]
    const shared = sharedCategories(myCategories, cats)
    const green = Math.min(100, Math.round(20 + u.totalTrades * 8))
    return {
      name: u.name,
      // One definition of the overlap and one of the sentence, shared with
      // /api/v1/home and the event-triggered matcher. See @/lib/category-match.
      reason: matchReason(shared, cats[0]),
      mutual: shared.length
        ? "Mutual category match"
        : cats[0]
          ? `Active in ${categoryLabel(cats[0])}`
          : "New to Baylo",
      green,
    }
  })

  return NextResponse.json(matches)
}
