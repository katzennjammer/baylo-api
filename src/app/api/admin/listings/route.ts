import { NextRequest } from "next/server"
import { z } from "zod"
import { requireRole } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok } from "@/lib/v1/envelope"
import { parseQuery } from "@/lib/v1/query"

export const dynamic = "force-dynamic"

const querySchema = z.strictObject({
  q: z.string().trim().max(120).optional(),
  status: z.enum(["available", "in_trade", "traded", "owned", "removed", "hidden"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

const VALID_ITEM_STATUSES = new Set(["AVAILABLE", "IN_TRADE", "TRADED", "OWNED", "REMOVED"])

export async function GET(req: NextRequest) {
  const gate = await requireRole("MODERATOR")
  if (gate.response) return gate.response

  const parsed = parseQuery(req, querySchema)
  if (!parsed.ok) return parsed.response
  const { q, status, limit } = parsed.data

  const itemStatus = status && VALID_ITEM_STATUSES.has(status.toUpperCase())
    ? (status.toUpperCase() as "AVAILABLE" | "IN_TRADE" | "TRADED" | "OWNED" | "REMOVED")
    : undefined

  const items = await prisma.item.findMany({
    where: {
      AND: [
        ...(q ? [{ OR: [{ title: { contains: q } }, { user: { name: { contains: q } } }, { user: { email: { contains: q } } }] }] : []),
        ...(status === "hidden"
          ? [{ moderationHiddenAt: { not: null } }]
          : itemStatus
            ? [{ status: itemStatus }]
            : []),
      ],
    },
    select: {
      id: true, title: true, status: true, moderationHiddenAt: true,
      createdAt: true, updatedAt: true, valueLeaves: true,
      user: { select: { id: true, name: true, email: true, suspendedAt: true, suspendedUntil: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  })

  return ok({ listings: items })
}
