import Link from "next/link"
import { auth } from "@root/auth"
import prisma from "@/lib/prisma"
import { bracketOf } from "@/lib/brackets"
import { valueCap } from "@/lib/trade-rules"
import { VALUE_REJECTION_REASONS } from "@/lib/value-rejection"
import { categoryLabel } from "@/lib/v1/taxonomy"
import ListingActions from "./ListingActions"
import { moderationLabel } from "./moderation-label"
import { TakedownDisclosure } from "./TakedownDisclosure"
import { FilterChips } from "@/components/admin/FilterChips"
import { StaggerGroup, StaggerItem } from "@/components/admin/Stagger"
import UrlSyncedForm from "@/components/admin/primitives/UrlSyncedForm"
import { adminThumb } from "@/lib/admin-display"

export const dynamic = "force-dynamic"
export const revalidate = 0

interface Props {
  searchParams: Promise<{ q?: string; status?: string }>
}

const STATUSES = ["available", "pending_review", "value_rejected", "in_trade", "traded", "owned", "removed", "hidden"] as const
type StatusFilter = (typeof STATUSES)[number]
type ItemStatus = "AVAILABLE" | "IN_TRADE" | "TRADED" | "OWNED" | "REMOVED" | "PENDING_REVIEW" | "VALUE_REJECTED"



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
      id: true, title: true, category: true, status: true, moderationHiddenAt: true, valueRejectionReason: true,
      createdAt: true, valueLeaves: true, suggestedLeaves: true, valueSetByUser: true,
      user: { select: { id: true, name: true, email: true } },
      images: { select: { url: true }, orderBy: { position: "asc" }, take: 1 },
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
        <h1 style={{ fontSize: 24, fontWeight: 800, color: "var(--adm-text)" }}>Listings</h1>
        <p style={{ fontSize: 13, color: "var(--adm-text-secondary)", marginTop: 4 }}>
          Search listings, decide value reviews, and manage moderator takedowns without opening a report.
        </p>
      </div>
      <UrlSyncedForm action="/admin/listings" style={{ display: "flex", gap: 8, maxWidth: 620 }}>
        <input name="q" defaultValue={q} placeholder="Search title or owner" style={{ flex: 1, padding: "10px 12px", borderRadius: 9, border: "1px solid var(--adm-border-control)", fontSize: 14 }} />
        <button type="submit" style={{ padding: "10px 16px", border: 0, borderRadius: 9, background: "var(--adm-text)", color: "var(--adm-shell)", fontWeight: 700 }}>Search</button>
      </UrlSyncedForm>
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
        <p style={{ padding: 32, textAlign: "center", background: "var(--adm-panel)", borderRadius: 14, color: "var(--adm-text-muted)" }}>No listings found.</p>
      ) : (
        <div style={{ background: "var(--adm-panel)", borderRadius: 14, border: "1px solid var(--adm-border)", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1000, fontSize: 13 }}>
            <thead><tr style={{ textAlign: "left", color: "var(--adm-text-muted)", fontSize: 12 }}>
              <th style={{ padding: "12px 14px" }}>Listing</th>
              <th style={{ padding: "12px 14px" }}>Category</th>
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
                    style={{ borderTop: "1px solid var(--adm-border)", verticalAlign: "top" }}
                  >
                    <td style={{ padding: "14px" }}>
                      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                      {/*
                        The admin detail page, NOT /listings/<id>: that is the
                        retired user web app, whose guard sends every admin to
                        /admin/dashboard -- which is how clicking a listing here
                        used to land on Overview.
                      */}
                      <Link href={`/admin/listings/${listing.id}`} aria-hidden tabIndex={-1} style={{ flexShrink: 0 }}>
                        {listing.images[0] ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={adminThumb(listing.images[0].url, 96)}
                            alt=""
                            width={48}
                            height={48}
                            loading="lazy"
                            style={{ width: 48, height: 48, borderRadius: 8, objectFit: "cover", display: "block", border: "1px solid var(--adm-border)" }}
                          />
                        ) : (
                          <div style={{ width: 48, height: 48, borderRadius: 8, background: "var(--adm-border)" }} />
                        )}
                      </Link>
                      <div>
                      <Link href={`/admin/listings/${listing.id}`} style={{ color: "var(--adm-good)", fontWeight: 700 }}>{listing.title}</Link>
                      {/*
                        BOTH numbers, always. The one the model suggested and the
                        one the owner listed at are different facts, and the gap
                        between them is the only thing that tells a moderator
                        whether a listing is priced honestly. A listing that went
                        to review shows it here as well as in the queue.
                      */}
                      <div style={{ color: "var(--adm-text-muted)", marginTop: 4 }}>
                        {requested?.toLocaleString() ?? "—"} Leaves
                        {requested !== null ? <span style={{ color: "var(--adm-text-muted)" }}> · bracket {bracketOf(requested)}</span> : null}
                        {listing.valueSetByUser ? (
                          <span style={{ color: "var(--adm-queue)", fontWeight: 700 }}> · owner-set</span>
                        ) : null}
                      </div>
                      {suggested !== null && suggested !== requested ? (
                        <div style={{ color: "var(--adm-text-muted)", fontSize: 12, marginTop: 2 }}>
                          suggested {suggested.toLocaleString()} · bracket {bracketOf(suggested)}
                          {cap !== null ? ` · live without review up to ${cap}` : ""}
                        </div>
                      ) : null}
                      {listing.status === "VALUE_REJECTED" && listing.valueRejectionReason ? (
                        <div style={{ color: "var(--adm-warn)", fontSize: 12, marginTop: 2 }}>
                          rejected: {VALUE_REJECTION_REASONS[listing.valueRejectionReason]?.label ?? listing.valueRejectionReason}
                        </div>
                      ) : null}
                      </div>
                      </div>
                    </td>
                    <td style={{ padding: "14px", whiteSpace: "nowrap" }}>{categoryLabel(listing.category)}</td>
                    <td style={{ padding: "14px" }}>
                      <strong>{listing.user.name}</strong>
                      <div style={{ color: "var(--adm-text-muted)", marginTop: 3 }}>{listing.user.email}</div>
                    </td>
                    <td style={{ padding: "14px" }}>{listing.status}</td>
                    <td style={{ padding: "14px", color: "var(--adm-text-secondary)", whiteSpace: "nowrap" }}>{listing.createdAt.toLocaleDateString()}</td>
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
                          <Link href="/admin/review-queue" style={{ color: "var(--adm-good)", fontWeight: 700 }}>
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
