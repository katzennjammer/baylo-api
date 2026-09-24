import { AdminTableSkeleton } from "@/components/admin/AdminTableSkeleton"

export default function Loading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-.02em" }}>Report queue</h1>
        <p style={{ fontSize: 13, color: "#777", marginTop: 4 }}>Loading…</p>
      </div>
      <AdminTableSkeleton columns={7} rows={10} rowHeight={56} />
    </div>
  )
}
