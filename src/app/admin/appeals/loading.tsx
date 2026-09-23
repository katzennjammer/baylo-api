import { AdminTableSkeleton } from "@/components/admin/AdminTableSkeleton"

export default function Loading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-.02em" }}>Appeals</h1>
        <p style={{ fontSize: 13, color: "#777", marginTop: 4 }}>Loading the queue…</p>
      </div>
      <AdminTableSkeleton columns={5} rows={6} rowHeight={96} />
    </div>
  )
}
