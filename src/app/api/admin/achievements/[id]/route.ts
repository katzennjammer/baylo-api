import { NextRequest } from "next/server"
import { z } from "zod"
import { requireRole } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { parseJsonBody } from "@/lib/v1/body"
import { ok, notFound } from "@/lib/v1/envelope"
import { ACHIEVEMENT_CRITERIA } from "@/lib/achievements"

export const dynamic = "force-dynamic"

const updateSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(240),
  icon: z.string().trim().min(1).max(40),
  criterion: z.enum(ACHIEVEMENT_CRITERIA),
  threshold: z.number().int().min(1).max(100_000),
  isActive: z.boolean(),
})

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireRole("ADMIN")
  if (gate.response) return gate.response
  const { id } = await ctx.params
  const parsed = await parseJsonBody(req, updateSchema)
  if (!parsed.ok) return parsed.response

  const existing = await prisma.achievement.findUnique({ where: { id }, select: { id: true } })
  if (!existing) return notFound("Achievement not found")

  const achievement = await prisma.achievement.update({ where: { id }, data: parsed.data })
  return ok({ achievement })
}
