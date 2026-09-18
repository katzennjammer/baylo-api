import Link from "next/link"
import { auth } from "@root/auth"
import prisma from "@/lib/prisma"
import ListingActions from "./ListingActions"

export const dynamic = "force-dynamic"
export const revalidate = 0

interface Props {
  searchParams: Promise<{ q?: string; status?: string }>
}

const STATUSES = ["available", "in_trade", "traded", "owned", "removed", "hidden"] as const
const VALID_ITEM_STATUSES = new Set(["AVAILABLE", "IN_TRADE", "TRADED", "OWNED", "REMOVED"])

function normalizeStatus(raw?: string): (typeof STATUSES)[number] | undefined {
  if (!raw) return undefined
  const value = raw.trim().toLowerCase()
  return (STATUSES as readonly string[]).includes(value) ? (value as (typeof STATUSES)[number]) : undefined
}

function chip(active: boolean): React.CSSProperties {
  return {
    padding: "6px 12px", borderRadius: 999, fontSize: 13, fontWeight: 600,
    textDecoration: "none", border: `1px solid ${active ? "#4CAF50" : "rgba(0,0,0,.14)"}`,
    background: active ? "rgba(76,175,80,.12)" : "#fff", color: active ? "#2e7d32" : "#555",
  }
}

export default async function ListingsPage({ searchParams }: Props) {
  const sp = await searchParams
  const q = sp.q?.trim() ?? ""
  const status = normalizeStatus(sp.status)
  const session = await auth()
  const me = session?.user?.id
    ? await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } })
    : null
  const canAct = me?.role === "MODERATOR" || me?.role === "ADMIN"

  const listings = await prisma.item.findMany({
    where: {
      AND: [
        ...(q ? [{ OR: [{ title: { contains: q } }, { user: { name: { contains: q } } }, { user: { email: { contains: q } } }] }] : []),
        ...(status === "hidden"
          ? [{ moderationHiddenAt: { not: null } }]
          : status && VALID_ITEM_STATUSES.has(status.toUpperCase())
            ? [{ status: status.toUpperCase() as "AVAILABLE" | "IN_TRADE" | "TRADED" | "OWNED" | "REMOVED" }]
            : []),
      ],
    },
    select: {
      id: true, title: true, status: true, moderationHiddenAt: true,
      createdAt: true, valueLeaves: true,
      user: { select: { id: true, name: true, email: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 100,
  })

  const href = (patch: Record<string, string | undefined>) => {
    const next = { q: q || undefined, status, ...patch }
    const query = Object.entries(next).filter(([, value]) => value)
      .map(([key, value]) => `${key}=${encodeURIComponent(value as string)}`).join("&")
    return query ? `/admin/listings?${query}` : "/admin/listings"
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 800 }}>Listings</h1>
        <p style={{ fontSize: 13, color: "#777", marginTop: 4 }}>
          Search listings and manage moderator takedowns without opening a report.
        </p>
      </div>
      <form action="/admin/listings" style={{ display: "flex", gap: 8, maxWidth: 620 }}>
        <input name="q" defaultValue={q} placeholder="Search title or owner" style={{ flex: 1, padding: "10px 12px", borderRadius: 9, border: "1px solid rgba(0,0,0,.16)", fontSize: 14 }} />
        <button type="submit" style={{ padding: "10px 16px", border: 0, borderRadius: 9, background: "#17201b", color: "#fff", fontWeight: 700 }}>Search</button>
      </form>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Link href={href({ status: undefined })} style={chip(!status)}>All</Link>
        {STATUSES.map((value) => (
          <Link key={value} href={href({ status: status === value ? undefined : value })} style={chip(status === value)}>
            {value.replace("_", " ")[0].toUpperCase() + value.replace("_", " ").slice(1)}
          </Link>
        ))}
      </div>
      {listings.length === 0 ? (
        <p style={{ padding: 32, textAlign: "center", background: "#fff", borderRadius: 14, color: "#888" }}>No listings found.</p>
      ) : (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid rgba(0,0,0,.08)", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1000, fontSize: 13 }}>
            <thead><tr style={{ textAlign: "left", color: "#888", fontSize: 12 }}>
              <th style={{ padding: "12px 14px" }}>Listing</th>
              <th style={{ padding: "12px 14px" }}>Owner</th>
              <th style={{ padding: "12px 14px" }}>Lifecycle</th>
              <th style={{ padding: "12px 14px" }}>Created</th>
              <th style={{ padding: "12px 14px" }}>Moderation</th>
            </tr></thead>
            <tbody>
              {listings.map((listing) => {
                const hidden = listing.moderationHiddenAt !== null
                return (
                  <tr key={listing.id} style={{ borderTop: "1px solid rgba(0,0,0,.06)", verticalAlign: "top" }}>
                    <td style={{ padding: "14px" }}>
                      <Link href={`/listings/${listing.id}`} style={{ color: "#21643d", fontWeight: 700 }}>{listing.title}</Link>
                      <div style={{ color: "#777", marginTop: 4 }}>{listing.valueLeaves ?? "—"} Leaves</div>
                    </td>
                    <td style={{ padding: "14px" }}>
                      <strong>{listing.user.name}</strong>
                      <div style={{ color: "#777", marginTop: 3 }}>{listing.user.email}</div>
                    </td>
                    <td style={{ padding: "14px" }}>{listing.status}</td>
                    <td style={{ padding: "14px", color: "#666", whiteSpace: "nowrap" }}>{listing.createdAt.toLocaleDateString()}</td>
                    <td style={{ padding: "14px" }}>
                      <div style={{ color: hidden ? "#b91c1c" : "#15803d", fontWeight: 700, marginBottom: 6 }}>
                        {hidden ? "Hidden" : "Visible"}
                      </div>
                      <ListingActions listingId={listing.id} hidden={hidden} canAct={canAct} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
