/**
 * A skeleton table shown by a route's loading.tsx while the server component
 * re-reads Prisma -- real row height, shimmering, so a filter click or a
 * refresh reads as "loading" rather than a blank beat before the table pops
 * back in.
 */
export function AdminTableSkeleton({
  columns,
  rows = 8,
  rowHeight = 52,
}: {
  columns: number
  rows?: number
  rowHeight?: number
}) {
  return (
    <div style={{ background: "#fff", borderRadius: 14, border: "1px solid rgba(0,0,0,.08)", overflow: "hidden" }}>
      <div style={{ display: "flex", padding: "12px 14px", gap: 14, borderBottom: "1px solid rgba(0,0,0,.06)" }}>
        {Array.from({ length: columns }).map((_, i) => (
          <span key={i} className="admin-skeleton" style={{ height: 10, width: i === 0 ? "22%" : `${100 / columns / 1.6}%`, flexShrink: 0 }} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "0 14px",
            height: rowHeight,
            borderTop: r === 0 ? "none" : "1px solid rgba(0,0,0,.06)",
          }}
        >
          {Array.from({ length: columns }).map((_, c) => (
            <span
              key={c}
              className="admin-skeleton"
              style={{ height: 12, width: c === 0 ? "26%" : `${100 / columns / 1.8}%`, flexShrink: 0 }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/** The card-grid equivalent, for the dashboard overview's stat cards. */
export function AdminCardSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{ background: "#fff", border: "1px solid rgba(0,0,0,.08)", borderRadius: 14, padding: 18 }}>
          <span className="admin-skeleton" style={{ display: "block", height: 10, width: "60%" }} />
          <span className="admin-skeleton" style={{ display: "block", height: 26, width: "40%", marginTop: 12 }} />
          <span className="admin-skeleton" style={{ display: "block", height: 10, width: "50%", marginTop: 12 }} />
        </div>
      ))}
    </div>
  )
}
