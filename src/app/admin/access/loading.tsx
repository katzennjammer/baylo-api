export default function Loading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 800 }}>Access management</h1>
        <p style={{ color: "#777", fontSize: 13 }}>Only admins can change staff roles.</p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} style={{ background: "#fff", padding: 14, borderRadius: 10, display: "flex", gap: 12, alignItems: "center" }}>
            <div style={{ flex: 1 }}>
              <span className="admin-skeleton" style={{ display: "block", height: 12, width: 160 }} />
              <span className="admin-skeleton" style={{ display: "block", height: 10, width: 220, marginTop: 6 }} />
            </div>
            <span className="admin-skeleton" style={{ height: 32, width: 90 }} />
            <span className="admin-skeleton" style={{ height: 32, width: 64 }} />
          </div>
        ))}
      </div>
    </div>
  )
}
