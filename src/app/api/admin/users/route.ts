import { NextRequest } from "next/server"
import { z } from "zod"
import { requireRole } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok } from "@/lib/v1/envelope"
import { parseQuery } from "@/lib/v1/query"

export const dynamic = "force-dynamic"

const querySchema = z.strictObject({
  q: z.string().trim().max(120).optional(),
  status: z.enum(["active", "suspended", "deleted"]).optional(),
  role: z.enum(["USER", "MODERATOR", "ADMIN"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  page: z.coerce.number().int().min(1).default(1),
})

export async function GET(req: NextRequest) {
  const gate = await requireRole("MODERATOR")
  if (gate.response) return gate.response

  const parsed = parseQuery(req, querySchema)
  if (!parsed.ok) return parsed.response
  const { q, status, role, limit, page } = parsed.data
  const now = new Date()
  const where = {
    ...(q
      ? { OR: [{ name: { contains: q } }, { email: { contains: q } }] }
      : {}),
    ...(role ? { role } : {}),
    ...(status === "active"
      ? {
          deletedAt: null,
          OR: [{ suspendedAt: null }, { suspendedUntil: { lte: now } }],
        }
      : {}),
    ...(status === "suspended"
      ? {
          deletedAt: null,
          suspendedAt: { not: null },
          AND: [{ OR: [{ suspendedUntil: null }, { suspendedUntil: { gt: now } }] }],
        }
      : {}),
    ...(status === "deleted" ? { deletedAt: { not: null } } : {}),
  }

  const [users, total] = await prisma.$transaction([
    prisma.user.findMany({
      where,
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isVerified: true,
      dateOfBirth: true,
      createdAt: true,
      suspendedAt: true,
      suspendedUntil: true,
      deletedAt: true,
      _count: {
        select: {
          items: true,
          reportsMade: true,
          idVerifications: true,
          sentRequests: true,
          receivedRequests: true,
        },
      },
      idVerifications: {
        select: { status: true, submittedAt: true },
        orderBy: { submittedAt: "desc" },
        take: 1,
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      skip: (page - 1) * limit,
    }),
    prisma.user.count({ where }),
  ])

  return ok({
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    users: users.map((user) => ({
      ...user,
      idVerification: user.idVerifications[0] ?? null,
      idVerifications: undefined,
      suspended: user.suspendedAt !== null && (
        user.suspendedUntil === null || user.suspendedUntil > new Date()
      ),
    })),
  })
}
