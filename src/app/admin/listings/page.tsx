import Link from "next/link"
import { auth } from "@root/auth"
import prisma from "@/lib/prisma"
import { bracketOf } from "@/lib/brackets"
import { valueCap } from "@/lib/trade-rules"
import { VALUE_REJECTION_REASONS } from "@/lib/value-rejection"
import ListingActions from "./ListingActions"
import { TakedownDisclosure } from "./TakedownDisclosure"
import { FilterChips } from "@/components/admin/FilterChips"
import { StaggerGroup, StaggerItem } from "@/components/admin/Stagger"

export const dynamic = "force-dynamic"
export const revalidate = 0

interface Props {
  searchParams: Promise<{ q?: string; status?: string }>
}

const STATUSES = ["available", "pending_review", "value_rejected", "in_trade", "traded", "owned", "removed", "hidden"] as const
type StatusFilter = (typeof STATUSES)[number]
type ItemStatus = "AVAILABLE" | "IN_TRADE" | "TRADED" | "OWNED" | "REMOVED" | "PENDING_REVIEW" | "VALUE_REJECTED"

/**
 * The Moderation column, in words that say who the listing is waiting on.
 *
 * "Visible" used to be the answer for anything not hidden, which on a
 * PENDING_REVIEW row was a lie: nobody but the owner could see it. Hidden
 * wins over the review states because it is the one an owner cannot undo by
 * editing.
 */
function moderationLabel(status: string, hidden: boolean): { text: string; color: string } {
  if (hidden) return { text: "Hidden", color: "#b91c1c" }
  if (status === "PENDING_REVIEW") return { text: "Waiting for review", color: "#b45309" }
  if (status === "VALUE_REJECTED") return { text: "Value rejected — owner choosing", color: "#7c2d12" }
  if (status === "AVAILABLE") return { text: "Visible", color: "#15803d" }
  return { text: "Not listed", color: "#666" }
}


export default async function ListingsPage({ searchParams }: Props) {
  const sp = await searchParams
  const q = sp.q?.trim() ?? ""
  const status = (STATUSES as readonly string[]).includes(sp.status ?? "")
    ? (sp.status as StatusFilter)
    : undefined
  const session = await auth()
  const me = session?.user?.id
    ? await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } })
    : null
  const canAct = me?.role === "ADMIN"

  const listings = await prisma.item.findMany({
    where: {
      AND: [
        ...(q ? [{ OR: [{ title: { contains: q, mode: "insensitive" as const } }, { user: { name: { contains: q, mode: "insensitive" as const } } }, { user: { email: { contains: q, mode: "insensitive" as const } } }] }] : []),
        ...(status === "hidden"
          ? [{ moderationHiddenAt: { not: null } }]
          : status
            ? [{ status: status.toUpperCase() as ItemStatus }]
            : []),
      ],
    },
    select: {
      id: true, title: true, status: true, moderationHiddenAt: true, valueRejectionReason: true,
      createdAt: true, valueLeaves: true, suggestedLeaves: true, valueSetByUser: true,
      user: { select: { id: true, name: true, email: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 100,
  })

  const href = (patch: Record<string, string | undefined>) => {
    const next = { q: q || undefined, status, ...patch }
    const query = Object.entries(next).filter(([, value]) => value)
      .map(([key, value]) => `${key}=${encodeURIComponent(value as string)}`).join("&")
    return query ? `/admin/listings?${query}` : "/admin/listings"
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 800 }}>Listings</h1>
        <p style={{ fontSize: 13, color: "#777", marginTop: 4 }}>
          Search listings, decide value reviews, and manage moderator takedowns without opening a report.
        </p>
      </div>
      <form action="/admin/listings" style={{ display: "flex", gap: 8, maxWidth: 620 }}>
        <input name="q" defaultValue={q} placeholder="Search title or owner" style={{ flex: 1, padding: "10px 12px", borderRadius: 9, border: "1px solid rgba(0,0,0,.16)", fontSize: 14 }} />
        <button type="submit" style={{ padding: "10px 16px", border: 0, borderRadius: 9, background: "#17201b", color: "#fff", fontWeight: 700 }}>Search</button>
      </form>
      <FilterChips
        groupId="status"
        options={[
          { key: "all", label: "All", href: href({ status: undefined }) },
          ...STATUSES.map((value) => ({
            key: value,
            label: value.replace("_", " ")[0].toUpperCase() + value.replace("_", " ").slice(1),
            href: href({ status: status === value ? undefined : value }),
          })),
        ]}
      />
      {listings.length === 0 ? (
        <p style={{ padding: 32, textAlign: "center", background: "#fff", borderRadius: 14, color: "#888" }}>No listings found.</p>
      ) : (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid rgba(0,0,0,.08)", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1000, fontSize: 13 }}>
            <thead><tr style={{ textAlign: "left", color: "#888", fontSize: 12 }}>
              <th style={{ padding: "12px 14px" }}>Listing</th>
              <th style={{ padding: "12px 14px" }}>Owner</th>
              <th style={{ padding: "12px 14px" }}>Lifecycle</th>
              <th style={{ padding: "12px 14px" }}>Created</th>
              <th style={{ padding: "12px 14px" }}>Moderation</th>
            </tr></thead>
            <StaggerGroup as="tbody">
              {listings.map((listing, index) => {
                const hidden = listing.moderationHiddenAt !== null
                const inReview = listing.status === "PENDING_REVIEW"
                const label = moderationLabel(listing.status, hidden)
                const requested = listing.valueLeaves
                const suggested = listing.suggestedLeaves
                const cap = suggested === null ? null : valueCap(suggested).maxBracketWithoutReview
                return (
                  <StaggerItem
                    as="tr"
                    index={index}
                    key={listing.id}
                    className="admin-row-hover"
                    style={{ borderTop: "1px solid rgba(0,0,0,.06)", verticalAlign: "top" }}
                  >
                    <td style={{ padding: "14px" }}>
                      <Link href={`/listings/${listing.id}`} style={{ color: "#21643d", fontWeight: 700 }}>{listing.title}</Link>
                      {/*
                        BOTH numbers, always. The one the model suggested and the
                        one the owner listed at are different facts, and the gap
                        between them is the only thing that tells a moderator
                        whether a listing is priced honestly. A listing that went
                        to review shows it here as well as in the queue.
                      */}
                      <div style={{ color: "#777", marginTop: 4 }}>
                        {requested?.toLocaleString() ?? "—"} Leaves
                        {requested !== null ? <span style={{ color: "#999" }}> · bracket {bracketOf(requested)}</span> : null}
                        {listing.valueSetByUser ? (
                          <span style={{ color: "#b45309", fontWeight: 700 }}> · owner-set</span>
                        ) : null}
                      </div>
                      {suggested !== null && suggested !== requested ? (
                        <div style={{ color: "#aaa", fontSize: 12, marginTop: 2 }}>
                          suggested {suggested.toLocaleString()} · bracket {bracketOf(suggested)}
                          {cap !== null ? ` · live without review up to ${cap}` : ""}
                        </div>
                      ) : null}
                      {listing.status === "VALUE_REJECTED" && listing.valueRejectionReason ? (
                        <div style={{ color: "#7c2d12", fontSize: 12, marginTop: 2 }}>
                          rejected: {VALUE_REJECTION_REASONS[listing.valueRejectionReason]?.label ?? listing.valueRejectionReason}
                        </div>
                      ) : null}
                    </td>
                    <td style={{ padding: "14px" }}>
                      <strong>{listing.user.name}</strong>
                      <div style={{ color: "#777", marginTop: 3 }}>{listing.user.email}</div>
                    </td>
                    <td style={{ padding: "14px" }}>{listing.status}</td>
                    <td style={{ padding: "14px", color: "#666", whiteSpace: "nowrap" }}>{listing.createdAt.toLocaleDateString()}</td>
                    <td style={{ padding: "14px" }}>
                      <div style={{ color: label.color, fontWeight: 700, marginBottom: 6 }}>
                        {label.text}
                      </div>
                      {/*
                        On a row waiting for review the VALUE decision is the
                        action, so it is drawn first and the takedown is folded
                        behind a secondary toggle -- a takedown is the answer to
                        "should this exist", not to "is this number right".
                      */}
                      {inReview ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          <Link href="/admin/review-queue" style={{ color: "#21643d", fontWeight: 700 }}>
                            Review value in queue →
                          </Link>
                          {canAct ? (
                            <TakedownDisclosure>
                              <ListingActions listingId={listing.id} hidden={hidden} canAct={canAct} />
                            </TakedownDisclosure>
                          ) : null}
                        </div>
                      ) : (
                        <ListingActions listingId={listing.id} hidden={hidden} canAct={canAct} />
                      )}
                    </td>
                  </StaggerItem>
                )
              })}
            </StaggerGroup>
          </table>
        </div>
      )}
    </div>
  )
}
