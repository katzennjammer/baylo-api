export default function Loading() {
  const cardStyle: React.CSSProperties = { background: "#fff", border: "1px solid rgba(0,0,0,.08)", borderRadius: 14, padding: 18 }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }} className="no-print">
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-.02em" }}>Overall report</h1>
        <p style={{ fontSize: 13, color: "#777", marginTop: 4 }}>Reading the figures…</p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 330px), 1fr))", gap: 12 }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} style={cardStyle}>
            <span className="admin-skeleton" style={{ display: "block", height: 10, width: "50%" }} />
            <span className="admin-skeleton" style={{ display: "block", height: 24, width: "35%", marginTop: 10 }} />
            <span className="admin-skeleton" style={{ display: "block", height: 9, width: "65%", marginTop: 10 }} />
          </div>
        ))}
      </div>
    </div>
  )
}
