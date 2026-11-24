import Link from "next/link"
import { auth } from "@root/auth"
import { loadAppeals, shapeAppeal } from "@/lib/admin-appeals"
import { AdminListingImage } from "@/components/AdminListingImage"
import { AppealActions } from "./AppealActions"
import { FilterChips } from "@/components/admin/FilterChips"
import { StaggerGroup, StaggerItem } from "@/components/admin/Stagger"

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
  background: "var(--adm-panel)", borderRadius: 14, border: "1px solid var(--adm-border)", padding: 20,
}
const th: React.CSSProperties = { padding: "10px 12px", textAlign: "left", color: "var(--adm-text-muted)", fontSize: 12 }
const td: React.CSSProperties = { padding: "12px", fontSize: 13, verticalAlign: "top" }

export default async function AppealsPage({ searchParams }: Props) {
  const sp = await searchParams
  const status = sp.status === "decided" ? "decided" : "open"
  const session = await auth()
  const viewerId = session?.user?.id ?? ""

  const rows = (await loadAppeals(status, 100)).map((r) => shapeAppeal(r, viewerId))

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-.02em", color: "var(--adm-text)" }}>Appeals</h1>
        <p style={{ fontSize: 13, color: "var(--adm-text-secondary)", marginTop: 4, maxWidth: "80ch", lineHeight: 1.6 }}>
          Owners appealing a value rejection or a takedown, in their own words. The listing
          stays hidden until this is answered. <strong>Uphold</strong> keeps the decision and
          closes the appeal for good; <strong>Overturn</strong> publishes the listing at the
          value the owner asked for (or restores a hidden one). An owner who deletes the
          listing withdraws their own appeal. Prefer to decide appeals against somebody
          else&apos;s decision.
        </p>
      </div>

      <FilterChips
        groupId="status"
        options={[
          { key: "open", label: "Open", href: "/admin/appeals" },
          { key: "decided", label: "Decided", href: "/admin/appeals?status=decided" },
        ]}
      />

      {rows.length === 0 ? (
        <p style={{ ...card, textAlign: "center", color: "var(--adm-text-muted)" }}>
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
            <StaggerGroup as="tbody">
              {rows.map((a, index) => (
                <StaggerItem
                  as="tr"
                  index={index}
                  key={a.id}
                  className="admin-row-hover"
                  style={{ borderTop: "1px solid var(--adm-border)", background: a.sameReviewer && status === "open" ? "var(--adm-queue-bg)" : undefined }}
                >
                  <td style={td}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <AdminListingImage src={a.listing.imageUrl} alt={a.listing.title} size={52} />
                      <div>
                        <Link href={`/admin/listings?q=${encodeURIComponent(a.listing.title)}`} style={{ color: "var(--adm-good)", fontWeight: 700 }}>
                          {a.listing.title}
                        </Link>
                        <div style={{ fontSize: 11, color: "var(--adm-text-muted)", marginTop: 2 }}>
                          {a.kind === "VALUE_REJECTION" ? "Value rejection" : "Takedown"} · {a.listing.category} · {a.listing.condition}
                        </div>
                        <div style={{ marginTop: 6, color: "var(--adm-text-secondary)" }}>
                          asked <strong>{a.listing.requestedLeaves?.toLocaleString() ?? "—"}</strong>
                          {a.listing.requestedBracket !== null ? ` (bracket ${a.listing.requestedBracket})` : ""}
                        </div>
                        <div style={{ color: "var(--adm-text-muted)", fontSize: 12 }}>
                          suggested {a.listing.suggestedLeaves?.toLocaleString() ?? "—"}
                          {a.listing.suggestedBracket !== null ? ` (bracket ${a.listing.suggestedBracket})` : ""}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--adm-text-muted)", marginTop: 4 }}>
                          now: {a.listing.status}{a.listing.hidden ? " · hidden" : ""}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td style={td}>
                    {a.owner.name}
                    <div style={{ fontSize: 11, color: "var(--adm-text-muted)" }}>{a.owner.email}</div>
                  </td>
                  <td style={td}>
                    {a.decision ? (
                      <>
                        <div>
                          {a.decision.reasonLabel ?? a.decision.reason}
                        </div>
                        {a.decision.note ? (
                          <div style={{ fontSize: 12, color: "var(--adm-text-muted)", marginTop: 3 }}>note: {a.decision.note}</div>
                        ) : null}
                        <div style={{ fontSize: 11, color: "var(--adm-text-muted)", marginTop: 4 }}>
                          by {a.decision.by?.name ?? "—"}{a.sameReviewer ? " (you)" : ""} · {new Date(a.decision.at).toLocaleString()}
                        </div>
                      </>
                    ) : (
                      <span style={{ color: "var(--adm-warn)" }}>audit row missing</span>
                    )}
                  </td>
                  <td style={{ ...td, maxWidth: 320 }}>
                    <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{a.message}</div>
                    <div style={{ fontSize: 11, color: "var(--adm-text-muted)", marginTop: 4 }}>{new Date(a.createdAt).toLocaleString()}</div>
                  </td>
                  <td style={td}>
                    {status === "open" ? (
                      <AppealActions appealId={a.id} sameReviewer={a.sameReviewer} />
                    ) : (
                      <>
                        <div style={{ fontWeight: 700, color: a.status === "OVERTURNED" ? "var(--adm-good)" : a.status === "WITHDRAWN" ? "var(--adm-text-muted)" : "var(--adm-warn)" }}>{a.status}</div>
                        <div style={{ fontSize: 12, color: "var(--adm-text-secondary)", marginTop: 3 }}>{a.decisionReason}</div>
                        <div style={{ fontSize: 11, color: "var(--adm-text-muted)", marginTop: 4 }}>
                          by {a.decidedBy?.name ?? "—"} · {a.decidedAt ? new Date(a.decidedAt).toLocaleString() : "—"}
                        </div>
                      </>
                    )}
                  </td>
                </StaggerItem>
              ))}
            </StaggerGroup>
          </table>
        </div>
      )}
    </div>
  )
}
