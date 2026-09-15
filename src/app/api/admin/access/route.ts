import { NextRequest } from "next/server"
import { z } from "zod"
import { requireRole } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok } from "@/lib/v1/envelope"
import { parseQuery } from "@/lib/v1/query"

const roleSchema = z.enum(["USER", "MODERATOR", "ADMIN", "SUPER_ADMIN"])
const querySchema = z.strictObject({ q: z.string().trim().max(120).optional() })
const bodySchema = z.strictObject({
  userId: z.string().min(1),
  role: roleSchema,
  reason: z.string().trim().min(1).max(1000),
})

export async function GET(req: NextRequest) {
  const gate = await requireRole("SUPER_ADMIN")
  if (gate.response) return gate.response
  const parsed = parseQuery(req, querySchema)
  if (!parsed.ok) return parsed.response
  const users = await prisma.user.findMany({
    where: parsed.data.q
      ? { OR: [{ name: { contains: parsed.data.q, mode: "insensitive" as const } }, { email: { contains: parsed.data.q, mode: "insensitive" as const } }] }
      : undefined,
    select: { id: true, name: true, email: true, role: true, deletedAt: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  })
  return ok({ users })
}

export async function PATCH(req: NextRequest) {
  const gate = await requireRole("SUPER_ADMIN")
  if (gate.response) return gate.response
  const parsed = bodySchema.safeParse(await req.json())
  if (!parsed.success) return Response.json({ error: "Invalid role change request" }, { status: 400 })
  const target = await prisma.user.findUnique({ where: { id: parsed.data.userId }, select: { id: true, role: true, name: true, email: true } })
  if (!target) return Response.json({ error: "User not found" }, { status: 404 })
  if (target.id === gate.actor.id && parsed.data.role !== "SUPER_ADMIN") {
    return Response.json({ error: "You cannot remove your own Super Admin access" }, { status: 400 })
  }
  if (target.role === "SUPER_ADMIN" && parsed.data.role !== "SUPER_ADMIN") {
    const count = await prisma.user.count({ where: { role: "SUPER_ADMIN", deletedAt: null } })
    if (count <= 1) return Response.json({ error: "The last Super Admin cannot be demoted" }, { status: 400 })
  }
  const updated = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({ where: { id: target.id }, data: { role: parsed.data.role }, select: { id: true, name: true, email: true, role: true } })
    await tx.adminAction.create({
      data: {
        actorId: gate.actor.id,
        action: "ROLE_CHANGED",
        targetType: "USER",
        targetId: target.id,
        reason: parsed.data.reason,
        detail: JSON.stringify({ from: target.role, to: parsed.data.role }),
      },
    })
    return user
  })
  return ok({ user: updated })
}
