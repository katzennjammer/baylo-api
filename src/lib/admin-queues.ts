import { cache } from "react"
import prisma from "@/lib/prisma"
import { REPORT } from "@/lib/report-case"

/**
 * How many items are waiting in each moderation queue.
 *
 * Wrapped in React's cache(), so the admin layout (rail badges) and the
 * Overview page (queue tiles) share ONE set of five counts per request instead
 * of each running its own. The cache lasts for that request only -- the next
 * navigation or router.refresh() counts again.
 */
export const getQueueCounts = cache(async () => {
  const [openReports, pendingIds, pendingOrgs, valuesInReview, openAppeals] = await Promise.all([
    prisma.moderationCase.count({ where: { ...REPORT, status: { in: ["OPEN", "REVIEWING"] } } }),
    prisma.idVerification.count({ where: { status: "PENDING" } }),
    prisma.organization.count({ where: { verificationStatus: "PENDING" } }),
    prisma.item.count({ where: { status: "PENDING_REVIEW" } }),
    prisma.moderationCase.count({ where: { type: "LISTING_APPEAL", status: "OPEN" } }),
  ])
  return { openReports, pendingIds, pendingOrgs, valuesInReview, openAppeals }
})
