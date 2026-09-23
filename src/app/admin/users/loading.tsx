import { AdminTableSkeleton } from "@/components/admin/AdminTableSkeleton"

export default function Loading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 800 }}>Users</h1>
        <p style={{ fontSize: 13, color: "#777", marginTop: 4 }}>
          Search accounts, inspect moderation state, and manage suspensions.
        </p>
      </div>
      <AdminTableSkeleton columns={5} rows={10} rowHeight={68} />
    </div>
  )
}
