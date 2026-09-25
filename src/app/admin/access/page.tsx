import prisma from "@/lib/prisma"
import { auth } from "@root/auth"
import { redirect } from "next/navigation"
import AccessActions from "./AccessActions"

export const dynamic = "force-dynamic"

export default async function AccessPage() {
  const session = await auth()
  const me = session?.user?.id ? await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } }) : null
  if (me?.role !== "ADMIN") redirect("/admin/dashboard")
  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, role: true, deletedAt: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  })
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div>
        <h1 style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--adm-text)" }}>Access management</h1>
        <p style={{ fontSize: 14, fontWeight: 500, color: "var(--adm-text-secondary)", marginTop: 6 }}>Only admins can change staff roles.</p>
      </div>
      <AccessActions users={users} />
    </div>
  )
}
