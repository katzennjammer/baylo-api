import Link from "next/link"
import { notFound } from "next/navigation"
import { auth } from "@root/auth"
import prisma from "@/lib/prisma"
import { bracketOf } from "@/lib/brackets"
import { ITEM_IMAGES, toImageUrls } from "@/lib/item-images"
import { REPORT } from "@/lib/report-case"
import { VALUE_REJECTION_REASONS } from "@/lib/value-rejection"
import { categoryLabel, conditionLabel } from "@/lib/v1/taxonomy"
import ReportImageViewer from "../../reports/[id]/ReportImageViewer"
import ListingActions from "../ListingActions"
import { moderationLabel } from "../moderation-label"

/**
 * One listing, for a moderator (20 Oct 2026).
 *
 * The Listings table linked each title to /listings/<id> -- the retired user
 * web app, whose UserAreaGuard sends every admin to /admin/dashboard. So a
 * click on any listing landed on Overview. This is the page that link meant:
 * every photo (click for full size), what the owner wrote and asked for, who
 * owns it, where it meets, the reports filed against it, and the same
 * hide/restore control the table has.
 *
 * The pickup ADDRESS and coordinates are deliberately not shown: they are the
 * owner's home more often than not, and a takedown decision never needs them.
 * The safe-zone hubs are public places and are.
 */

export const dynamic = "force-dynamic"
export const revalidate = 0

const card: React.CSSProperties = {
  background: "var(--adm-panel)", borderRadius: 14, border: "1px solid var(--adm-border)",
  padding: 20, display: "flex", flexDirection: "column", gap: 10,
}
const label: React.CSSProperties = { fontSize: 12, color: "var(--adm-text-muted)", fontWeight: 600 }
const sentence = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ")

function Fact({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 12, fontSize: 13 }}>
      <span style={label}>{name}</span>
      <span style={{ color: "var(--adm-text)" }}>{children}</span>
    </div>
  )
}

export default async function AdminListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  const me = session?.user?.id
    ? await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } })
    : null
  const canAct = me?.role === "ADMIN"

  const item = await prisma.item.findUnique({
    where: { id },
    select: {
      id: true, title: true, description: true, category: true, condition: true, status: true,
      valueLeaves: true, suggestedLeaves: true, valueSetByUser: true, valueRejectionReason: true,
      wantedItems: true, moderationHiddenAt: true, createdAt: true, updatedAt: true,
      isPerishable: true, quantity: true, quantityUnit: true, tradeWithinHours: true,
      images: ITEM_IMAGES,
      user: { select: { id: true, name: true, email: true } },
      safeZones: { select: { hub: { select: { name: true, city: true } } } },
    },
  })
  if (!item) notFound()

  const reports = await prisma.moderationCase.findMany({
    where: { ...REPORT, targetType: "LISTING", targetId: item.id },
    select: { id: true, status: true, category: true, createdAt: true, filedBy: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 20,
  })

  const images = toImageUrls(item.images)
  const hidden = item.moderationHiddenAt !== null
  const mod = moderationLabel(item.status, hidden)

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <Link href="/admin/listings" style={{ color: "var(--adm-good)", fontSize: 13, fontWeight: 600 }}>
        ← Back to listings
      </Link>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(280px, 1fr)", gap: 18, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <section style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
              <h1 style={{ fontSize: 22, fontWeight: 800, color: "var(--adm-text)" }}>{item.title}</h1>
              <span style={{ color: mod.color, fontWeight: 700, fontSize: 13, whiteSpace: "nowrap" }}>{mod.text}</span>
            </div>
            <span style={label}>
              {categoryLabel(item.category)} · {conditionLabel(item.condition)} · {item.status}
            </span>
            {images.length > 0 ? (
              <>
                <span style={label}>{images.length === 1 ? "1 photo" : `${images.length} photos`} · click one for full size</span>
                <ReportImageViewer images={images} title={item.title} />
              </>
            ) : (
              <p style={{ color: "var(--adm-text-muted)", fontSize: 13 }}>No photos.</p>
            )}
          </section>

          <section style={card}>
            <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--adm-text)" }}>What the owner wrote</h2>
            <p style={{ fontSize: 14, color: "var(--adm-text)", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{item.description}</p>
            {item.wantedItems ? (
              <>
                <span style={label}>Wants in return</span>
                <p style={{ fontSize: 14, color: "var(--adm-text)", whiteSpace: "pre-wrap" }}>{item.wantedItems}</p>
              </>
            ) : null}
          </section>

          <section style={card}>
            <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--adm-text)" }}>Reports about this listing ({reports.length})</h2>
            {reports.length === 0 ? (
              <p style={{ fontSize: 13, color: "var(--adm-text-muted)" }}>None filed.</p>
            ) : (
              reports.map((r) => (
                <Link
                  key={r.id}
                  href={`/admin/reports/${r.id}`}
                  style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13, padding: "8px 0", borderTop: "1px solid var(--adm-border)", color: "var(--adm-text)" }}
                >
                  <span>
                    {r.category ? sentence(r.category) : "Report"} · by {r.filedBy.name} · {r.createdAt.toLocaleDateString()}
                  </span>
                  <span style={{ color: "var(--adm-good)", fontWeight: 700 }}>{sentence(r.status)} →</span>
                </Link>
              ))
            )}
          </section>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <section style={card}>
            <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--adm-text)" }}>Value</h2>
            <Fact name="Listed at">
              {item.valueLeaves !== null ? `${item.valueLeaves.toLocaleString()} Leaves · bracket ${bracketOf(item.valueLeaves)}` : "—"}
              {item.valueSetByUser ? <span style={{ color: "var(--adm-queue)", fontWeight: 700 }}> · owner-set</span> : null}
            </Fact>
            <Fact name="Suggested">
              {item.suggestedLeaves !== null ? `${item.suggestedLeaves.toLocaleString()} Leaves · bracket ${bracketOf(item.suggestedLeaves)}` : "—"}
            </Fact>
            {item.status === "VALUE_REJECTED" && item.valueRejectionReason ? (
              <Fact name="Rejected">
                <span style={{ color: "var(--adm-warn)" }}>
                  {VALUE_REJECTION_REASONS[item.valueRejectionReason]?.label ?? item.valueRejectionReason}
                </span>
              </Fact>
            ) : null}
            {item.status === "PENDING_REVIEW" ? (
              <Link href="/admin/review-queue" style={{ color: "var(--adm-good)", fontWeight: 700, fontSize: 13 }}>
                Review value in queue →
              </Link>
            ) : null}
          </section>

          <section style={card}>
            <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--adm-text)" }}>Owner</h2>
            <strong style={{ color: "var(--adm-text)" }}>{item.user.name}</strong>
            <span style={{ fontSize: 13, color: "var(--adm-text-secondary)" }}>{item.user.email}</span>
            <Link href={`/admin/users?q=${encodeURIComponent(item.user.email)}`} style={{ color: "var(--adm-good)", fontWeight: 700, fontSize: 13 }}>
              Open in Users →
            </Link>
          </section>

          <section style={card}>
            <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--adm-text)" }}>Listing</h2>
            <Fact name="Created">{item.createdAt.toLocaleString()}</Fact>
            <Fact name="Last changed">{item.updatedAt.toLocaleString()}</Fact>
            <Fact name="Meets at">
              {item.safeZones.length > 0 ? item.safeZones.map((z) => `${z.hub.name}, ${z.hub.city}`).join(" · ") : "No hub chosen"}
            </Fact>
            {item.isPerishable ? (
              <Fact name="Perishable">
                {item.quantity !== null ? `${item.quantity} ${item.quantityUnit?.toLowerCase() ?? ""} · ` : ""}
                {item.tradeWithinHours !== null ? `trade within ${item.tradeWithinHours}h` : "yes"}
              </Fact>
            ) : null}
          </section>

          <section style={card}>
            <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--adm-text)" }}>Moderation</h2>
            <span style={{ color: mod.color, fontWeight: 700, fontSize: 13 }}>
              {mod.text}
              {hidden && item.moderationHiddenAt ? ` since ${item.moderationHiddenAt.toLocaleDateString()}` : ""}
            </span>
            <ListingActions listingId={item.id} hidden={hidden} canAct={canAct} />
          </section>
        </div>
      </div>
    </div>
  )
}
