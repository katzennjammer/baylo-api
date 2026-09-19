import Link from "next/link"
import { auth } from "@root/auth"
import prisma from "@/lib/prisma"
import { suspensionState } from "@/lib/moderation"
import UserActions from "./UserActions"

export const dynamic = "force-dynamic"
export const revalidate = 0

interface Props {
  searchParams: Promise<{ q?: string; status?: string; role?: string; page?: string }>
}

const STATUSES = ["active", "suspended", "deleted"] as const
const ROLES = ["USER", "ADMIN"] as const

function chip(active: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 600,
    textDecoration: "none",
    border: `1px solid ${active ? "#4CAF50" : "rgba(0,0,0,.14)"}`,
    background: active ? "rgba(76,175,80,.12)" : "#fff",
    color: active ? "#2e7d32" : "#555",
  }
}

function idStatus(user: {
  idVerifiedGrandfatheredAt: Date | null
  idVerifications: { status: string }[]
}) {
  if (user.idVerifiedGrandfatheredAt) return "Grandfathered"
  return user.idVerifications[0]?.status ?? "Not submitted"
}

export default async function UsersPage({ searchParams }: Props) {
  const sp = await searchParams
  const q = sp.q?.trim() ?? ""
  const status = (STATUSES as readonly string[]).includes(sp.status ?? "")
    ? (sp.status as (typeof STATUSES)[number])
    : undefined
  const role = (ROLES as readonly string[]).includes(sp.role ?? "")
    ? (sp.role as (typeof ROLES)[number])
    : undefined
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1)
  const pageSize = 25
  const session = await auth()
  const me = session?.user?.id
    ? await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } })
    : null
  const canSuspend = me?.role === "ADMIN"
  const now = new Date()

  const where = {
      ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" as const } }, { email: { contains: q, mode: "insensitive" as const } }] } : {}),
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
      id: true, name: true, email: true, role: true, isVerified: true,
      idVerifiedGrandfatheredAt: true, createdAt: true, suspendedAt: true,
      suspendedUntil: true, deletedAt: true,
      _count: { select: { items: true, reportsMade: true, idVerifications: true, sentRequests: true, receivedRequests: true } },
      idVerifications: {
        select: { status: true, submittedAt: true },
        orderBy: { submittedAt: "desc" },
        take: 1,
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: pageSize,
    skip: (page - 1) * pageSize,
    }),
    prisma.user.count({ where }),
  ])
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const href = (patch: Record<string, string | undefined>) => {
    const next = { q: q || undefined, status, role, page: page > 1 ? String(page) : undefined, ...patch }
    const query = Object.entries(next)
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}=${encodeURIComponent(value as string)}`)
      .join("&")
    return query ? `/admin/users?${query}` : "/admin/users"
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 800 }}>Users</h1>
        <p style={{ fontSize: 13, color: "#777", marginTop: 4 }}>
          Search accounts, inspect moderation state, and manage suspensions.
        </p>
      </div>

      <form action="/admin/users" style={{ display: "flex", gap: 8, maxWidth: 620 }}>
        <input
          name="q"
          defaultValue={q}
          placeholder="Search name or email"
          style={{ flex: 1, padding: "10px 12px", borderRadius: 9, border: "1px solid rgba(0,0,0,.16)", fontSize: 14 }}
        />
        <button type="submit" style={{ padding: "10px 16px", border: 0, borderRadius: 9, background: "#17201b", color: "#fff", fontWeight: 700 }}>
          Search
        </button>
      </form>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Link href={href({ status: undefined })} style={chip(!status)}>All</Link>
        {STATUSES.map((value) => (
          <Link key={value} href={href({ status: status === value ? undefined : value })} style={chip(status === value)}>
            {value[0].toUpperCase() + value.slice(1)}
          </Link>
        ))}
        {ROLES.map((value) => (
          <Link key={value} href={href({ role: role === value ? undefined : value })} style={chip(role === value)}>
            {value}
          </Link>
        ))}
      </div>

      {users.length === 0 ? (
        <p style={{ padding: 32, textAlign: "center", background: "#fff", borderRadius: 14, color: "#888" }}>No users found.</p>
      ) : (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid rgba(0,0,0,.08)", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1100, fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#888", fontSize: 12 }}>
                <th style={{ padding: "12px 14px" }}>Account</th>
                <th style={{ padding: "12px 14px" }}>Role / state</th>
                <th style={{ padding: "12px 14px" }}>Verification</th>
                <th style={{ padding: "12px 14px" }}>Activity</th>
                <th style={{ padding: "12px 14px" }}>Account action</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const suspension = suspensionState(user)
                return (
                  <tr key={user.id} style={{ borderTop: "1px solid rgba(0,0,0,.06)", verticalAlign: "top" }}>
                    <td style={{ padding: "14px" }}>
                      <strong>{user.name}</strong>
                      <div style={{ color: "#777", marginTop: 3 }}>{user.email}</div>
                      <div style={{ color: "#aaa", fontSize: 11, marginTop: 5 }}>Joined {user.createdAt.toLocaleDateString()}</div>
                    </td>
                    <td style={{ padding: "14px" }}>
                      <strong>{user.role}</strong>
                      <div style={{ marginTop: 5, color: user.deletedAt || suspension.suspended ? "#b91c1c" : "#15803d" }}>
                        {user.deletedAt ? "Deleted" : suspension.suspended ? "Suspended" : "Active"}
                      </div>
                      {user.isVerified && <div style={{ color: "#777", fontSize: 11, marginTop: 3 }}>Email verified</div>}
                    </td>
                    <td style={{ padding: "14px" }}>
                      {idStatus(user)}
                      <div style={{ color: "#777", fontSize: 11, marginTop: 4 }}>
                        {user._count.idVerifications} submission{user._count.idVerifications === 1 ? "" : "s"}
                      </div>
                    </td>
                    <td style={{ padding: "14px", color: "#555", lineHeight: 1.7 }}>
                      <div>{user._count.items} listings</div>
                      <div>{user._count.reportsMade} reports filed</div>
                      <div>{user._count.sentRequests + user._count.receivedRequests} trade requests</div>
                    </td>
                    <td style={{ padding: "14px" }}>
                      {user.deletedAt ? (
                        <span style={{ color: "#888" }}>Deleted accounts cannot be suspended.</span>
                      ) : !canSuspend ? (
                        <span style={{ color: "#888" }}>Admin-only account controls.</span>
                      ) : (
                        <UserActions userId={user.id} suspended={suspension.suspended} canSuspend={canSuspend} />
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {totalPages > 1 && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
          <span style={{ color: "#777" }}>Page {page} of {totalPages} ({total} users)</span>
          <div style={{ display: "flex", gap: 8 }}>
            <Link
              href={href({ page: page > 1 ? String(page - 1) : undefined })}
              aria-disabled={page === 1}
              style={{ ...chip(false), opacity: page === 1 ? 0.45 : 1, pointerEvents: page === 1 ? "none" : "auto" }}
            >
              Previous
            </Link>
            <Link
              href={href({ page: page < totalPages ? String(page + 1) : String(page) })}
              aria-disabled={page === totalPages}
              style={{ ...chip(false), opacity: page === totalPages ? 0.45 : 1, pointerEvents: page === totalPages ? "none" : "auto" }}
            >
              Next
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}
