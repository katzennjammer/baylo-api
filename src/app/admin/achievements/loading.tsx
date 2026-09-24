import { AdminTableSkeleton } from "@/components/admin/AdminTableSkeleton"

export default function Loading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 800 }}>Achievements</h1>
        <p style={{ fontSize: 13, color: "#777", marginTop: 4 }}>Loading badge definitions…</p>
      </div>
      <AdminTableSkeleton columns={7} rows={8} rowHeight={70} />
    </div>
  )
}
