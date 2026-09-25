import { auth } from "@root/auth"
import prisma from "@/lib/prisma"
import AchievementForm from "./AchievementForm"
import AchievementToggle from "./AchievementToggle"
import { StaggerGroup, StaggerItem } from "@/components/admin/Stagger"

export const dynamic = "force-dynamic"
export const revalidate = 0

/**
 * /admin/achievements -- define what can be earned.
 *
 * ── WHAT AN ADMIN DOES HERE ──────────────────────────
 *
 * Creates the badge definitions the user side reads: a key, a name, art (an
 * uploaded image, with an emoji fallback), and a CRITERION -- one of the closed
 * set @/lib/achievements knows how to evaluate. When a user's activity meets the
 * criterion, the engine grants the badge automatically; nobody toggles a user's
 * row by hand. The "Gray" state on the user side is simply "no UserAchievement
 * row yet", and this page is what decides the thing that would create one.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────
 *
 * There is no delete. A UserAchievement cascades from its Achievement, so
 * deleting a definition would strip the badge off every profile that had earned
 * it -- the one outcome that must never happen. Deactivation stops new grants
 * and hides the badge from the shelf; earned copies survive. See the column note
 * on Achievement.isActive.
 *
 * Creating and editing are ADMIN, not MODERATOR (the routes enforce it):
 * a badge is a reward given to users, and getting the definitions wrong is a
 * product decision rather than a moderation one.
 */

// Keys MUST match the live "AchievementCriterion" enum.
const CRITERION_LABEL: Record<string, string> = {
  VERIFIED_ACCOUNT: "Verified email",
  ID_VERIFIED: "Government ID verified",
  PROFILE_COMPLETE: "Completed profile",
  FIRST_LISTING: "Listings posted",
  COMPLETED_TRADES: "Completed trades",
  LIFETIME_LEAVES: "Lifetime Leaves",
  SAFEZONE_MEETUPS: "Safe-Zone meetups",
  REPORTS_FILED: "Reports filed",
  BRIDGE_COMPLETED: "Trades with a bridge fee paid",
  PREMIUM_SUBSCRIBER: "Premium subscriber",
}

function describeCriterion(criterion: string, threshold: number): string {
  const label = CRITERION_LABEL[criterion] ?? criterion
  const counted = ["FIRST_LISTING", "COMPLETED_TRADES", "LIFETIME_LEAVES", "SAFEZONE_MEETUPS", "REPORTS_FILED", "BRIDGE_COMPLETED"].includes(criterion)
  return counted ? `${label} ≥ ${threshold.toLocaleString()}` : label
}

export default async function AdminAchievementsPage() {
  const session = await auth()
  const me = session?.user?.id
    ? await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } })
    : null
  const canDefine = me?.role === "ADMIN"

  const achievements = await prisma.achievement.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true, key: true, name: true, description: true, icon: true, imageUrl: true,
      criterion: true, threshold: true, points: true, sortOrder: true, isActive: true,
      _count: { select: { unlocks: true } },
    },
  })

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: "var(--adm-text)" }}>Achievements</h1>
          <p style={{ fontSize: 13, color: "var(--adm-text-secondary)", marginTop: 4, maxWidth: "72ch", lineHeight: 1.6 }}>
            Define what users can earn. A badge unlocks automatically when a user&apos;s activity meets its
            criterion — nothing here toggles a user&apos;s badge by hand. Deactivate rather than delete: users
            who already earned a badge keep it.
          </p>
        </div>
        {canDefine ? <AchievementForm mode="create" /> : (
          <span style={{ fontSize: 13, color: "#888" }}>Admin-only definition controls.</span>
        )}
      </div>

      {achievements.length === 0 ? (
        <p style={{ padding: 32, textAlign: "center", background: "#fff", borderRadius: 14, color: "#888" }}>
          No achievements defined yet. Create one to start awarding badges.
        </p>
      ) : (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid rgba(0,0,0,.08)", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1000, fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#888", fontSize: 12 }}>
                <th style={{ padding: "12px 14px" }}>Badge</th>
                <th style={{ padding: "12px 14px" }}>Key</th>
                <th style={{ padding: "12px 14px" }}>Earned when</th>
                <th style={{ padding: "12px 14px" }}>Points</th>
                <th style={{ padding: "12px 14px" }}>Earned by</th>
                <th style={{ padding: "12px 14px" }}>State</th>
                <th style={{ padding: "12px 14px" }}>Manage</th>
              </tr>
            </thead>
            <StaggerGroup as="tbody">
              {achievements.map((achievement, index) => (
                <StaggerItem
                  as="tr"
                  index={index}
                  key={achievement.id}
                  className="admin-row-hover"
                  style={{ borderTop: "1px solid rgba(0,0,0,.06)", verticalAlign: "top" }}
                >
                  <td style={{ padding: "14px" }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <div style={{ width: 42, height: 42, borderRadius: 12, display: "grid", placeItems: "center", background: "#E1F1E5", overflow: "hidden", flexShrink: 0 }}>
                        {achievement.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={achievement.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        ) : (
                          <span style={{ fontSize: 22 }}>{achievement.icon}</span>
                        )}
                      </div>
                      <div>
                        <strong>{achievement.name}</strong>
                        <div style={{ color: "#777", maxWidth: 260, marginTop: 2 }}>{achievement.description}</div>
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: "14px", fontFamily: "monospace", color: "#555" }}>{achievement.key}</td>
                  <td style={{ padding: "14px" }}>{describeCriterion(achievement.criterion, achievement.threshold)}</td>
                  <td style={{ padding: "14px", fontWeight: 700 }}>{achievement.points.toLocaleString()}</td>
                  <td style={{ padding: "14px", fontWeight: 700 }}>{achievement._count.unlocks.toLocaleString()}</td>
                  <td style={{ padding: "14px" }}>
                    <span style={{ color: achievement.isActive ? "#15803d" : "#b91c1c", fontWeight: 700 }}>
                      {achievement.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td style={{ padding: "14px" }}>
                    {canDefine ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <AchievementForm
                          mode="edit"
                          initial={{
                            id: achievement.id,
                            key: achievement.key,
                            name: achievement.name,
                            description: achievement.description,
                            icon: achievement.icon,
                            imageUrl: achievement.imageUrl,
                            criterion: achievement.criterion,
                            threshold: achievement.threshold,
                            points: achievement.points,
                            sortOrder: achievement.sortOrder,
                          }}
                        />
                        <AchievementToggle
                          id={achievement.id}
                          isActive={achievement.isActive}
                          earnedCount={achievement._count.unlocks}
                        />
                      </div>
                    ) : (
                      <span style={{ color: "#888" }}>Admin-only</span>
                    )}
                  </td>
                </StaggerItem>
              ))}
            </StaggerGroup>
          </table>
        </div>
      )}
    </div>
  )
}
