import { AdminTableSkeleton } from "@/components/admin/AdminTableSkeleton"

export default function Loading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 800 }}>Listings</h1>
        <p style={{ fontSize: 13, color: "#777", marginTop: 4 }}>
          Search listings, decide value reviews, and manage moderator takedowns without opening a report.
        </p>
      </div>
      <AdminTableSkeleton columns={5} rows={8} rowHeight={78} />
    </div>
  )
}
