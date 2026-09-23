export default function Loading() {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 20, fontWeight: 800 }}>ID verification</h1>
      </div>
      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid rgba(0,0,0,.08)", overflow: "hidden", marginTop: 16 }}>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 14, padding: "0 18px", height: 56, borderTop: i === 0 ? "none" : "1px solid rgba(0,0,0,.06)" }}>
            <span className="admin-skeleton" style={{ height: 10, width: 60 }} />
            <span className="admin-skeleton" style={{ height: 12, width: 140 }} />
            <span className="admin-skeleton" style={{ height: 10, width: 120 }} />
            <span className="admin-skeleton" style={{ height: 10, width: 100, marginLeft: "auto" }} />
          </div>
        ))}
      </div>
    </div>
  )
}
