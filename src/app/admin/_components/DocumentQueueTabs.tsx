import Link from "next/link"

/**
 * The document-type tabs shared by the two review queues.
 *
 * ── WHY TWO ROUTES AND NOT ONE PAGE WITH A FILTER ───────────────────────────
 *
 * The spec asked for business documents to be reviewed "through the same admin
 * queue UI as ID verification, but as a separate document type/tab". A single
 * page filtering one query would have meant one list over two tables with
 * different columns, different decision forms, different reason vocabularies
 * and — the part that decides it — different retention rules. An ID has a
 * three-attempt lifetime cap and a uniqueness claim; a business document has
 * neither, and a rejection of one takes away the ability to post while a
 * rejection of the other takes away a badge. Merging them into one row shape
 * would flatten exactly the differences a reviewer has to keep straight.
 *
 * So: two routes that LOOK like one queue with two tabs. This strip is the
 * thing that makes them look like it, and it is the only shared piece.
 *
 * ── THE COUNTS ARE THE POINT OF THE STRIP ───────────────────────────────────
 *
 * Each tab carries its own PENDING count, so a reviewer working IDs can see
 * that four businesses are waiting without navigating to find out. A tab strip
 * without counts is a navigation element; with them it is a queue depth
 * indicator, which is what a moderator actually needs from it.
 */

export type QueueKind = "id" | "organization"

export function DocumentQueueTabs({
  active,
  idPending,
  orgPending,
}: {
  active: QueueKind
  idPending: number
  orgPending: number
}) {
  const tabs: { kind: QueueKind; href: string; label: string; pending: number }[] = [
    { kind: "id", href: "/admin/id-verification", label: "Government ID", pending: idPending },
    {
      kind: "organization",
      href: "/admin/organizations",
      label: "Business document",
      pending: orgPending,
    },
  ]

  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        margin: "0 0 18px",
        borderBottom: "1px solid rgba(0,0,0,.1)",
      }}
    >
      {tabs.map((t) => {
        const on = t.kind === active
        return (
          <Link
            key={t.kind}
            href={t.href}
            style={{
              padding: "10px 16px",
              fontSize: 14,
              fontWeight: on ? 700 : 500,
              textDecoration: "none",
              color: on ? "#2e7d32" : "#666",
              // The underline sits ON the container's border rather than above
              // it, so the active tab reads as connected to the panel below.
              borderBottom: `2px solid ${on ? "#4CAF50" : "transparent"}`,
              marginBottom: -1,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {t.label}
            {t.pending > 0 && (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 800,
                  padding: "2px 7px",
                  borderRadius: 999,
                  background: "rgba(180,83,9,.12)",
                  color: "#b45309",
                }}
              >
                {t.pending}
              </span>
            )}
          </Link>
        )
      })}
    </div>
  )
}
