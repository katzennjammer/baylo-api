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

export async function GET(req: NextRequest) {
  const gate = await requireRole("MODERATOR")
  if (gate.response) return gate.response

  const parsed = parseQuery(req, querySchema)
  if (!parsed.ok) return parsed.response
  const { q, status, limit } = parsed.data

  const items = await prisma.item.findMany({
    where: {
      AND: [
        ...(q ? [{ OR: [{ title: { contains: q, mode: "insensitive" as const } }, { user: { name: { contains: q, mode: "insensitive" as const } } }, { user: { email: { contains: q, mode: "insensitive" as const } } }] }] : []),
        ...(status === "hidden"
          ? [{ moderationHiddenAt: { not: null } }]
          : status
            ? [{ status: status.toUpperCase() as "AVAILABLE" | "IN_TRADE" | "TRADED" | "OWNED" | "REMOVED" }]
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
