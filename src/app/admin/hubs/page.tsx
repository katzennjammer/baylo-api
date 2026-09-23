import prisma from "@/lib/prisma"
import { SAFE_ZONE_TYPE_LABELS, type SafeZoneTypeValue } from "@/lib/safe-zones"
import HubForm from "./HubForm"
import { FilterChips } from "@/components/admin/FilterChips"
import { StaggerGroup, StaggerItem } from "@/components/admin/Stagger"

export const dynamic = "force-dynamic"
export const revalidate = 0

interface Props {
  searchParams: Promise<{ city?: string; status?: string }>
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
      <FilterChips
        groupId="status"
        options={[
          { key: "all", label: "All", href: href({ status: undefined }) },
          { key: "active", label: "Active", href: href({ status: "active" }) },
          { key: "inactive", label: "Inactive", href: href({ status: "inactive" }) },
        ]}
      />
      {cities.length > 0 ? (
        <FilterChips
          groupId="city"
          options={cities.map((value) => ({ key: value, label: value, href: href({ city: city === value ? undefined : value }) }))}
        />
      ) : null}
      {hubs.length === 0 ? (
        <p style={{ padding: 32, textAlign: "center", background: "#fff", borderRadius: 14, color: "#888" }}>No hubs found.</p>
      ) : (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid rgba(0,0,0,.08)", overflowX: "auto" }}>
          {/*
            Explicit <col> widths, not `width: "100%"` on the table alone.
            An auto-layout table with width 100% and short cell content
            (a lat/lng pair, a listing count) dumps whatever extra space the
            1280px admin column has into those narrow columns as dead
            whitespace rather than into the ones that can actually use it
            (Hub, Location). Proportions are declared once here instead of
            left to the browser's auto-layout guess.
          */}
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1050, fontSize: 13 }}>
            <colgroup>
              <col style={{ width: "26%" }} />
              <col style={{ width: "28%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "22%" }} />
            </colgroup>
            <thead><tr style={{ textAlign: "left", color: "#888", fontSize: 12 }}>
              <th style={{ padding: "12px 14px" }}>Hub</th><th style={{ padding: "12px 14px" }}>Location</th>
              <th style={{ padding: "12px 14px" }}>Coordinates</th><th style={{ padding: "12px 14px" }}>Listings</th>
              <th style={{ padding: "12px 14px" }}>State / edit</th>
            </tr></thead>
            <StaggerGroup as="tbody">{hubs.map((hub, index) => (
              <StaggerItem as="tr" index={index} key={hub.id} className="admin-row-hover" style={{ borderTop: "1px solid rgba(0,0,0,.06)", verticalAlign: "top" }}>
                <td style={{ padding: "14px" }}><strong>{hub.name}</strong><div style={{ color: "#777", marginTop: 4 }}>{SAFE_ZONE_TYPE_LABELS[hub.type as SafeZoneTypeValue] ?? hub.type}</div></td>
                <td style={{ padding: "14px" }}>{hub.city}<div style={{ color: "#777", marginTop: 4 }}>{hub.address}<br />{hub.landmark}</div></td>
                <td style={{ padding: "14px", fontFamily: "monospace", color: "#555" }}>{hub.latitude}, {hub.longitude}</td>
                <td style={{ padding: "14px" }}>{hub._count.items}</td>
                <td style={{ padding: "14px" }}><div style={{ color: hub.isActive ? "#15803d" : "#b91c1c", fontWeight: 700, marginBottom: 8 }}>{hub.isActive ? "Active" : "Inactive"}</div><HubForm initial={{ ...hub, type: hub.type as SafeZoneTypeValue }} /></td>
              </StaggerItem>
            ))}</StaggerGroup>
          </table>
        </div>
      )}
    </div>
  )
}
