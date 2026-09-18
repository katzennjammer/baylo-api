import { NextRequest } from "next/server"
import { z } from "zod"
import { requireRole } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { parseJsonBody } from "@/lib/v1/body"
import { ok, conflict } from "@/lib/v1/envelope"
import { ACHIEVEMENT_CRITERIA } from "@/lib/achievements"

export const dynamic = "force-dynamic"

const achievementSchema = z.strictObject({
  key: z.string().trim().regex(/^[A-Z][A-Z0-9_]{2,60}$/, "Use an uppercase key such as FIRST_LISTING"),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(240),
  icon: z.string().trim().min(1).max(40).default("trophy"),
  criterion: z.enum(ACHIEVEMENT_CRITERIA),
  threshold: z.number().int().min(1).max(100_000).default(1),
  isActive: z.boolean().default(true),
})

export async function GET() {
  const gate = await requireRole("MODERATOR")
  if (gate.response) return gate.response

  const achievements = await prisma.achievement.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: { _count: { select: { unlocks: true } } },
  })
  return ok({ achievements })
}

export async function POST(req: NextRequest) {
  const gate = await requireRole("ADMIN")
  if (gate.response) return gate.response

  const parsed = await parseJsonBody(req, achievementSchema)
  if (!parsed.ok) return parsed.response

  try {
    const achievement = await prisma.achievement.create({ data: parsed.data })
    return ok({ achievement }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unique constraint")) {
      return conflict("An achievement with that key already exists", { code: "DUPLICATE_ACHIEVEMENT_KEY" })
    }
    throw error
  }
}
