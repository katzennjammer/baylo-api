import prisma from "@/lib/prisma"
import { auth } from "@root/auth"
import { redirect } from "next/navigation"
import AccessActions from "./AccessActions"

export const dynamic = "force-dynamic"

export default async function AccessPage() {
  const session = await auth()
  const me = session?.user?.id ? await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } }) : null
  if (me?.role !== "SUPER_ADMIN") redirect("/admin/dashboard")
  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, role: true, deletedAt: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  })
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div><h1 style={{ fontSize: 24, fontWeight: 800 }}>Access management</h1><p style={{ color: "#777", fontSize: 13 }}>Only Super Admins can change staff roles.</p></div>
      <AccessActions users={users} />
    </div>
  )
}
