import { AdminTableSkeleton } from "@/components/admin/AdminTableSkeleton"

export default function Loading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-.02em" }}>Review queue</h1>
        <p style={{ fontSize: 13, color: "#777", marginTop: 4 }}>Loading…</p>
      </div>
      <AdminTableSkeleton columns={7} rows={5} rowHeight={64} />
      <AdminTableSkeleton columns={4} rows={4} rowHeight={54} />
    </div>
  )
}
