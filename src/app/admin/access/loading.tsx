export default function Loading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div>
        <h1 style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--adm-text)" }}>Access management</h1>
        <p style={{ color: "var(--adm-text-secondary)", fontSize: 14, fontWeight: 500, marginTop: 6 }}>Only admins can change staff roles.</p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            style={{
              background: "var(--adm-panel-flat)",
              border: "1px solid var(--adm-border)",
              padding: "14px 18px",
              borderRadius: "var(--adm-radius-tile)",
              display: "flex",
              gap: 14,
              alignItems: "center",
            }}
          >
            <div style={{ flex: 1 }}>
              <span className="admin-skeleton" style={{ display: "block", height: 14, width: 160 }} />
              <span className="admin-skeleton" style={{ display: "block", height: 11, width: 220, marginTop: 8 }} />
            </div>
            <span className="admin-skeleton" style={{ height: 24, width: 60, borderRadius: 999 }} />
            <span className="admin-skeleton" style={{ height: 36, width: 90, borderRadius: 999 }} />
            <span className="admin-skeleton" style={{ height: 36, width: 64, borderRadius: 999 }} />
          </div>
        ))}
      </div>
    </div>
  )
}
