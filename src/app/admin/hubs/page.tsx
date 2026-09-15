import Link from "next/link"
import prisma from "@/lib/prisma"
import { SAFE_ZONE_TYPE_LABELS, type SafeZoneTypeValue } from "@/lib/safe-zones"
import HubForm from "./HubForm"

export const dynamic = "force-dynamic"
export const revalidate = 0

interface Props {
  searchParams: Promise<{ city?: string; status?: string }>
}

function chip(active: boolean): React.CSSProperties {
  return {
    padding: "6px 12px", borderRadius: 999, fontSize: 13, fontWeight: 600,
    textDecoration: "none", border: `1px solid ${active ? "#4CAF50" : "rgba(0,0,0,.14)"}`,
    background: active ? "rgba(76,175,80,.12)" : "#fff", color: active ? "#2e7d32" : "#555",
  }
}

export default async function HubsPage({ searchParams }: Props) {
  const sp = await searchParams
  const status = sp.status === "active" || sp.status === "inactive" ? sp.status : undefined
  const city = sp.city?.trim() || undefined
  const hubs = await prisma.safeZoneHub.findMany({
    where: { ...(city ? { city } : {}), ...(status ? { isActive: status === "active" } : {}) },
    select: {
      id: true, name: true, type: true, address: true, city: true, landmark: true,
      latitude: true, longitude: true, isActive: true, createdAt: true,
      _count: { select: { items: true } },
    },
    orderBy: [{ city: "asc" }, { name: "asc" }],
  })
  const cities = [...new Set(hubs.map((hub) => hub.city))].sort()
  const href = (patch: Record<string, string | undefined>) => {
    const next = { city, status, ...patch }
    const query = Object.entries(next).filter(([, value]) => value)
      .map(([key, value]) => `${key}=${encodeURIComponent(value as string)}`).join("&")
    return query ? `/admin/hubs?${query}` : "/admin/hubs"
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 800 }}>Safe-Zone hubs</h1>
          <p style={{ fontSize: 13, color: "#777", marginTop: 4 }}>Manage public meetup points and their availability.</p>
        </div>
        <HubForm />
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Link href={href({ status: undefined })} style={chip(!status)}>All</Link>
        <Link href={href({ status: "active" })} style={chip(status === "active")}>Active</Link>
        <Link href={href({ status: "inactive" })} style={chip(status === "inactive")}>Inactive</Link>
        {cities.map((value) => <Link key={value} href={href({ city: city === value ? undefined : value })} style={chip(city === value)}>{value}</Link>)}
      </div>
      {hubs.length === 0 ? (
        <p style={{ padding: 32, textAlign: "center", background: "#fff", borderRadius: 14, color: "#888" }}>No hubs found.</p>
      ) : (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid rgba(0,0,0,.08)", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1050, fontSize: 13 }}>
            <thead><tr style={{ textAlign: "left", color: "#888", fontSize: 12 }}>
              <th style={{ padding: "12px 14px" }}>Hub</th><th style={{ padding: "12px 14px" }}>Location</th>
              <th style={{ padding: "12px 14px" }}>Coordinates</th><th style={{ padding: "12px 14px" }}>Listings</th>
              <th style={{ padding: "12px 14px" }}>State / edit</th>
            </tr></thead>
            <tbody>{hubs.map((hub) => (
              <tr key={hub.id} style={{ borderTop: "1px solid rgba(0,0,0,.06)", verticalAlign: "top" }}>
                <td style={{ padding: "14px" }}><strong>{hub.name}</strong><div style={{ color: "#777", marginTop: 4 }}>{SAFE_ZONE_TYPE_LABELS[hub.type as SafeZoneTypeValue] ?? hub.type}</div></td>
                <td style={{ padding: "14px" }}>{hub.city}<div style={{ color: "#777", marginTop: 4 }}>{hub.address}<br />{hub.landmark}</div></td>
                <td style={{ padding: "14px", fontFamily: "monospace", color: "#555" }}>{hub.latitude}, {hub.longitude}</td>
                <td style={{ padding: "14px" }}>{hub._count.items}</td>
                <td style={{ padding: "14px" }}><div style={{ color: hub.isActive ? "#15803d" : "#b91c1c", fontWeight: 700, marginBottom: 8 }}>{hub.isActive ? "Active" : "Inactive"}</div><HubForm initial={{ ...hub, type: hub.type as SafeZoneTypeValue }} /></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  )
}
