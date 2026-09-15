import type { ReactNode } from "react"
import { redirect } from "next/navigation"
import { auth } from "@root/auth"
import prisma from "@/lib/prisma"
import { suspensionState } from "@/lib/moderation"

export async function UserAreaGuard({ children }: { children: ReactNode }) {
  const session = await auth()
  if (!session?.user?.id) redirect("/auth/login")

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { role: true, deletedAt: true, suspendedAt: true, suspendedUntil: true },
  })

  if (!user || user.deletedAt || suspensionState(user).suspended) redirect("/auth/login")
  if (user.role === "ADMIN" || user.role === "MODERATOR") redirect("/admin/dashboard")

  return children
}
