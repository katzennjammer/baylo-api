import type { ReactNode } from "react"
import { redirect } from "next/navigation"
import { auth } from "@root/auth"
import prisma from "@/lib/prisma"
import { suspensionState, activeSuspension } from "@/lib/moderation"

export async function UserAreaGuard({ children }: { children: ReactNode }) {
  const session = await auth()
  if (!session?.user?.id) redirect("/auth/login")

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { role: true, deletedAt: true, suspensions: activeSuspension() },
  })

  // Not /auth/login: the cookie is still valid, so the proxy would bounce it
  // straight back here. See the note on /api/auth/clear-session.
  if (!user || user.deletedAt || suspensionState(user).suspended) redirect("/api/auth/clear-session")
  if (user.role === "ADMIN") redirect("/admin/dashboard")

  return children
}
