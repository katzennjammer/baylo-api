import { auth } from "@root/auth"
import prisma from "@/lib/prisma"
import AchievementForm from "./AchievementForm"

export const dynamic = "force-dynamic"
export const revalidate = 0

const criterionLabels: Record<string, string> = {
  VERIFIED_ACCOUNT: "Verified account",
  ID_VERIFIED: "Government ID verified",
  FIRST_LISTING: "First listing",
  COMPLETED_TRADES: "Completed trades",
}

export default async function AchievementsPage() {
  const session = await auth()
  const me = session?.user?.id
    ? await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } })
    : null
  const canEdit = me?.role === "ADMIN" || me?.role === "SUPER_ADMIN"
  const achievements = await prisma.achievement.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: { _count: { select: { unlocks: true } } },
  })

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 800 }}>Achievements</h1>
          <p style={{ fontSize: 13, color: "#777", marginTop: 4, maxWidth: 650 }}>
            Manage the public catalog. Unlocks are derived from verified account activity and cannot be granted manually.
          </p>
        </div>
        {canEdit && <AchievementForm />}
      </div>
      {achievements.length === 0 ? (
        <p style={{ padding: 32, textAlign: "center", background: "#fff", borderRadius: 14, color: "#888" }}>No achievements yet.</p>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {achievements.map((achievement) => (
            <div key={achievement.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, padding: 16, background: "#fff", border: "1px solid rgba(0,0,0,.08)", borderRadius: 14, flexWrap: "wrap" }}>
              <div style={{ display: "flex", gap: 12, alignItems: "start" }}>
                <div style={{ width: 42, height: 42, display: "grid", placeItems: "center", borderRadius: 12, background: achievement.isActive ? "#e8f5ec" : "#eef0ef", fontSize: 21 }}>{achievement.icon}</div>
                <div>
                  <strong>{achievement.name}</strong>
                  <div style={{ color: "#777", fontSize: 13, marginTop: 3 }}>{achievement.description}</div>
                  <div style={{ color: "#9a6b19", fontSize: 12, marginTop: 7 }}>{criterionLabels[achievement.criterion] ?? achievement.criterion} · threshold {achievement.threshold}</div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ color: achievement.isActive ? "#15803d" : "#777", fontSize: 13, fontWeight: 700 }}>{achievement.isActive ? "Active" : "Paused"} · {achievement._count.unlocks} unlocked</span>
                {canEdit && <AchievementForm initial={{ ...achievement, unlockCount: achievement._count.unlocks }} />}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
