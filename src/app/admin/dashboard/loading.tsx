import { AdminCardSkeleton } from "@/components/admin/AdminTableSkeleton"

export default function Loading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      <div>
        <h1 style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--adm-text)" }}>Dashboard overview</h1>
        <p style={{ fontSize: 14, fontWeight: 500, color: "var(--adm-text-secondary)", marginTop: 6 }}>
          A quick view of the moderation and safety queues that need attention.
        </p>
      </div>
      <AdminCardSkeleton count={8} />
    </div>
  )
}
