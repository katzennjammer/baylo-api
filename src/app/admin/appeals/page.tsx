import Link from "next/link"
import { auth } from "@root/auth"
import { loadAppeals, shapeAppeal } from "@/lib/admin-appeals"
import { AdminListingImage } from "@/components/AdminListingImage"
import { AppealActions } from "./AppealActions"

export const dynamic = "force-dynamic"
export const revalidate = 0

/**
 * /admin/appeals — owners' appeals against value rejections and takedowns.
 *
 * A QUEUE, oldest first, like the value reviews: somebody is waiting, and
 * their listing is invisible until this is answered. Each row shows the whole
 * case -- the listing, both values and both brackets, the decision being
 * appealed with who made it and the reason, and the owner's message -- so
 * the decision is made from this page and not from three others.
 *
 * The same-reviewer warning is drawn per row by AppealActions; see there for
 * why it warns rather than blocks.
 */

interface Props {
  searchParams: Promise<{ status?: string }>
}

const card: React.CSSProperties = {
  background: "#fff", borderRadius: 14, border: "1px solid rgba(0,0,0,.08)", padding: 20,
}
const th: React.CSSProperties = { padding: "10px 12px", textAlign: "left", color: "#888", fontSize: 12 }
const td: React.CSSProperties = { padding: "12px", fontSize: 13, verticalAlign: "top" }

function chip(active: boolean): React.CSSProperties {
  return {
    padding: "6px 12px", borderRadius: 999, fontSize: 13, fontWeight: 600, textDecoration: "none",
    border: `1px solid ${active ? "#4CAF50" : "rgba(0,0,0,.14)"}`,
    background: active ? "rgba(76,175,80,.12)" : "#fff", color: active ? "#2e7d32" : "#555",
  }
}

export default async function AppealsPage({ searchParams }: Props) {
  const sp = await searchParams
  const status = sp.status === "decided" ? "decided" : "open"
  const session = await auth()
  const viewerId = session?.user?.id ?? ""

  const rows = (await loadAppeals(status, 100)).map((r) => shapeAppeal(r, viewerId))

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-.02em" }}>Appeals</h1>
        <p style={{ fontSize: 13, color: "#777", marginTop: 4, maxWidth: "80ch", lineHeight: 1.6 }}>
          Owners appealing a value rejection or a takedown, in their own words. The listing
          stays hidden until this is answered. <strong>Uphold</strong> keeps the decision and
          closes the appeal for good; <strong>Overturn</strong> publishes the listing at the
          value the owner asked for (or restores a hidden one). An owner who deletes the
          listing withdraws their own appeal. Prefer to decide appeals against somebody
          else&apos;s decision.
        </p>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <Link href="/admin/appeals" style={chip(status === "open")}>Open</Link>
        <Link href="/admin/appeals?status=decided" style={chip(status === "decided")}>Decided</Link>
      </div>

      {rows.length === 0 ? (
        <p style={{ ...card, textAlign: "center", color: "#888" }}>
          {status === "open" ? "No appeals waiting." : "No appeals decided yet."}
        </p>
      ) : (
        <div style={{ ...card, padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1100 }}>
            <thead>
              <tr>
                <th style={th}>Listing</th>
                <th style={th}>Owner</th>
                <th style={th}>Decision appealed</th>
                <th style={th}>Owner&apos;s appeal</th>
                <th style={th}>{status === "open" ? "Decide" : "Outcome"}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} style={{ borderTop: "1px solid rgba(0,0,0,.06)", background: a.sameReviewer && status === "open" ? "#fffbeb" : undefined }}>
                  <td style={td}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <AdminListingImage src={a.listing.imageUrl} alt={a.listing.title} size={52} />
                      <div>
                        <Link href={`/admin/listings?q=${encodeURIComponent(a.listing.title)}`} style={{ color: "#21643d", fontWeight: 700 }}>
                          {a.listing.title}
                        </Link>
                        <div style={{ fontSize: 11, color: "#aaa", marginTop: 2 }}>
                          {a.kind === "VALUE_REJECTION" ? "Value rejection" : "Takedown"} · {a.listing.category} · {a.listing.condition}
                        </div>
                        <div style={{ marginTop: 6, color: "#555" }}>
                          asked <strong>{a.listing.requestedLeaves?.toLocaleString() ?? "—"}</strong>
                          {a.listing.requestedBracket !== null ? ` (bracket ${a.listing.requestedBracket})` : ""}
                        </div>
                        <div style={{ color: "#888", fontSize: 12 }}>
                          suggested {a.listing.suggestedLeaves?.toLocaleString() ?? "—"}
                          {a.listing.suggestedBracket !== null ? ` (bracket ${a.listing.suggestedBracket})` : ""}
                        </div>
                        <div style={{ fontSize: 11, color: "#aaa", marginTop: 4 }}>
                          now: {a.listing.status}{a.listing.hidden ? " · hidden" : ""}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td style={td}>
                    {a.owner.name}
                    <div style={{ fontSize: 11, color: "#aaa" }}>{a.owner.email}</div>
                  </td>
                  <td style={td}>
                    {a.decision ? (
                      <>
                        <div>
                          {a.decision.reasonLabel ?? a.decision.reason}
                        </div>
                        {a.decision.note ? (
                          <div style={{ fontSize: 12, color: "#777", marginTop: 3 }}>note: {a.decision.note}</div>
                        ) : null}
                        <div style={{ fontSize: 11, color: "#aaa", marginTop: 4 }}>
                          by {a.decision.by?.name ?? "—"}{a.sameReviewer ? " (you)" : ""} · {new Date(a.decision.at).toLocaleString()}
                        </div>
                      </>
                    ) : (
                      <span style={{ color: "#b91c1c" }}>audit row missing</span>
                    )}
                  </td>
                  <td style={{ ...td, maxWidth: 320 }}>
                    <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{a.message}</div>
                    <div style={{ fontSize: 11, color: "#aaa", marginTop: 4 }}>{new Date(a.createdAt).toLocaleString()}</div>
                  </td>
                  <td style={td}>
                    {status === "open" ? (
                      <AppealActions appealId={a.id} sameReviewer={a.sameReviewer} />
                    ) : (
                      <>
                        <div style={{ fontWeight: 700, color: a.status === "OVERTURNED" ? "#15803d" : a.status === "WITHDRAWN" ? "#6b7280" : "#7c2d12" }}>{a.status}</div>
                        <div style={{ fontSize: 12, color: "#555", marginTop: 3 }}>{a.decisionReason}</div>
                        <div style={{ fontSize: 11, color: "#aaa", marginTop: 4 }}>
                          by {a.decidedBy?.name ?? "—"} · {a.decidedAt ? new Date(a.decidedAt).toLocaleString() : "—"}
                        </div>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
