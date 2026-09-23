import { AdminCardSkeleton } from "@/components/admin/AdminTableSkeleton"

export default function Loading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 800 }}>Dashboard overview</h1>
        <p style={{ fontSize: 13, color: "#777", marginTop: 4 }}>
          A quick view of the moderation and safety queues that need attention.
        </p>
      </div>
      <AdminCardSkeleton count={8} />
    </div>
  )
}
