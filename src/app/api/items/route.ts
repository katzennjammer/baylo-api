import { NextRequest, NextResponse } from "next/server"
import { headers } from "next/headers"
import { resolveSession } from "@/lib/api-auth"
import { ORG_CONTEXT_HEADER, orgPostingRefusal, resolveActingIdentity } from "@/lib/organizations"
import { decidePerishableValue } from "@/lib/perishable"
import { notifyCategoryMatchesAsync } from "@/lib/category-match"
import prisma from "@/lib/prisma"
import { awardTaskAsync } from "@/lib/tasks"
import { createItemSchema, parseBody, categorySchema } from "@/lib/validation"
import { imageHashRows, leadImageHash } from "@/lib/image-hashes"
import { decideItemValue, reviewNotice } from "@/lib/valuation-server"
import { visibleItemWhere } from "@/lib/blocking"
import { enforceIdVerifiedLegacy } from "@/lib/id-verification"
import {
  ITEM_PUBLIC_SELECT,
  ITEM_PUBLIC_USER_SELECT,
  preciseAccessItemIds,
  shapeItem,
} from "@/lib/item-visibility"
import {
  SAFE_ZONE_HUB_SELECT,
  resolveHubIds,
  v1Hub,
  type SafeZoneHubRow,
} from "@/lib/safe-zones"

export async function GET(req: NextRequest) {
  try {
    // Authentication is required for the whole route, not only the `mine`
    // branch. The session used to be resolved here and then consulted only
    // inside `if (mine)`, so every other request fell through unauthenticated —
    // and the response carried each item's pickup coordinates.
    const session = await resolveSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const viewerId = session.user.id

    const { searchParams } = new URL(req.url)
    const categoryParam = searchParams.get("category")
    const q = searchParams.get("q")
    const mine = searchParams.get("mine") === "true"

    // An unknown category is ignored rather than passed through as an enum.
    const categoryFilter =
      categoryParam && categoryParam !== "ALL"
        ? categorySchema.safeParse(categoryParam)
        : null
    if (categoryFilter && !categoryFilter.success) {
      return NextResponse.json({ error: "Unknown category" }, { status: 400 })
    }

    if (mine) {
      const items = await prisma.item.findMany({
        where: { userId: viewerId, status: "AVAILABLE" },
        select: ITEM_PUBLIC_SELECT,
        orderBy: { createdAt: "desc" },
      })
      // Own items: the owner always sees their own exact pickup point.
      return NextResponse.json(items.map((i) => shapeItem(i, viewerId)))
    }

    // The web's browse AND search path. visibleItemWhere() goes in beside the
    // status filter rather than after the fetch, so a blocked owner's listing is
    // excluded by the SQL on both — searching for it by title finds nothing,
    // which is the whole point.
    //
    // The `mine` branch above deliberately does NOT get this: those are the
    // caller's own items, nobody can block themselves, and a moderator takedown
    // must stay visible to its owner or the listing silently vanishes with no
    // explanation.
    const items = await prisma.item.findMany({
      where: {
        status: "AVAILABLE",
        ...visibleItemWhere(viewerId),
        ...(categoryFilter?.success ? { category: categoryFilter.data } : {}),
        ...(q ? { OR: [{ title: { contains: q, mode: "insensitive" as const } }, { description: { contains: q, mode: "insensitive" as const } }] } : {}),
      },
      select: { ...ITEM_PUBLIC_SELECT, user: { select: ITEM_PUBLIC_USER_SELECT } },
      orderBy: { createdAt: "desc" },
    })

    // One query for the whole page rather than one per item.
    const access = await preciseAccessItemIds(viewerId, items.map((i) => i.id))

    return NextResponse.json(items.map((i) => shapeItem(i, viewerId, access)))
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await resolveSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // ── Acting as an organisation ───────────────────────────────────────────
    //
    // FIRST, because it decides which gate applies below. It reads only a
    // header and one indexed row, so the ID gate still refuses before the body
    // is parsed.
    //
    // The membership is re-read from the database here, on this request; it is
    // not a claim on the token. See the header of @/lib/organizations for why.
    const acting = await resolveActingIdentity(
      prisma,
      session.user.id,
      (await headers()).get(ORG_CONTEXT_HEADER),
    )
    if (!acting.ok) {
      return NextResponse.json(
        {
          error:
            acting.reason === "membership_pending"
              ? "Accept the invitation before posting for this organisation"
              : "You are not a member of that organisation",
          code: "ORG_CONTEXT_REFUSED",
        },
        { status: 403 },
      )
    }

    // ── The ID gate ─────────────────────────────────────────────────────────
    //
    // One of exactly two places this gate exists; the other is POST
    // /api/v1/contracts. Listing an item is the act that puts something in
    // front of other people to trade for, so it is the act that has to be
    // attached to something a person has checked.
    //
    // WHICH CHECK DEPENDS ON WHO IS POSTING (changed 24 Sep 2026):
    //
    //   as a VERIFIED organisation  the org's own review is the check. A
    //                               moderator has matched its DTI/SEC or permit
    //                               document, so the listing is attached to a
    //                               verified business, and the staff member's
    //                               personal ID is NOT consulted. A shop's
    //                               staff should not need a government ID on
    //                               file to list the shop's stock.
    //   as a PENDING or REJECTED    REFUSED, whatever the staff member's own ID
    //   organisation                says. A person's ID is not a stand-in for
    //                               an unreviewed or failed business review, so
    //                               there is no fallback. The 403 carries the
    //                               sentence from orgPostingRefusal(), which is
    //                               the same one the phone shows up front.
    //   as oneself                  the PERSON'S government ID, exactly as
    //                               before, whatever state their orgs are in.
    //
    // The org's status comes from resolveActingIdentity() above, re-read on
    // this request, so a status change takes effect at once.
    //
    // BEFORE THE BODY IS EVEN PARSED. A 403 that arrives after the valuation
    // model has run and the hub ids have been resolved is the same 403 with
    // extra queries behind it, and the wizard has by then uploaded photos it
    // will have to throw away.
    //
    // NOTE WHAT IS NOT GATED, one function down and elsewhere in the tree: GET
    // on this route, browsing, searching, messaging, and accepting a trade. See
    // the header of @/lib/id-verification for why the accept path is
    // deliberately open — blocking it strands a counterparty in a trade they
    // did not cause.
    const actingOrg = acting.acting.organization
    if (actingOrg) {
      const refusal = orgPostingRefusal(actingOrg.verificationStatus, actingOrg.rejectionReason)
      if (refusal) {
        return NextResponse.json(
          {
            error: refusal.message,
            code: refusal.code,
            organization: {
              id: actingOrg.id,
              verificationStatus: actingOrg.verificationStatus,
              rejectionReason: refusal.rejectionReason,
            },
          },
          { status: 403 },
        )
      }
    } else {
      const unverified = await enforceIdVerifiedLegacy(session.user.id, "post")
      if (unverified) return unverified
    }

    const parsed = await parseBody(req, createItemSchema)
    if (!parsed.ok) return parsed.response
    const body = parsed.data
    // The AUTHOR. The org's backing row when acting as one, the person
    // otherwise — the same `userId` column either way, which is the whole
    // reason an organisation is a User row.
    const authorId = acting.acting.actingUserId

    const resolvedTitle = body.title ?? body.wantedItem!

    // ── Valuation ───────────────────────────────────────────────────────────
    // The value is not simply whatever the client sent. The server recomputes
    // the suggestion for this (category, condition) from the same deterministic
    // model the listing wizard was shown, and judges the submitted number
    // against it by BRACKET: lower is fine, up to one bracket above is fine,
    // further than that and the listing is created in PENDING_REVIEW rather
    // than refused (see decideItemValue). The client is not trusted to report
    // the suggestion it was given — it does not need to be, because the model
    // returns the same number to anyone who asks with the same two labels.
    //
    // A listing with no value takes the suggestion, so `suggestedLeaves` and
    // `valueLeaves` are both populated on every listing created from here and
    // the divergence between them is measurable.
    const valued = await decideItemValue(body.category, body.condition, body.valueLeaves)

    // ── The perishable rule ─────────────────────────────────────────────────
    //
    // A perishable does not WAIT, and it does not get a free bracket. Where
    // decideItemValue() would have said PENDING_REVIEW, the value is clamped to
    // the same ceiling anybody may raise to unreviewed and the listing goes
    // live at once. Read the header of @/lib/perishable before changing this —
    // skipping the cap as well as the queue would make the poster the author of
    // their own bracket, and the bracket is what the bridging fee and the
    // premium gate are computed from.
    //
    // Standard listings are untouched: `decidePerishableValue` is only
    // consulted when `isPerishable`, and it returns its input unchanged for
    // anything that did not need review anyway.
    const perishable = body.isPerishable === true
    const finalValue = perishable ? decidePerishableValue(valued) : null
    const valueData = finalValue?.data ?? valued.data
    const needsReview = perishable ? false : valued.needsReview

    // ── Safe-Zone hubs ──────────────────────────────────────────────────────
    // Validated against the table BEFORE the item is created, so a bad hub id
    // is a 400 with nothing written rather than an orphaned listing plus a
    // failed association. No `currentHubIds` here: nothing exists yet to
    // retain, so every hub named must be active.
    // One derivation, two destinations. See @/lib/image-hashes.
    const hashRows = imageHashRows(body)
    const leadHash = leadImageHash(hashRows)

    const hubs = await resolveHubIds(prisma, body.hubIds ?? [])
    if (!hubs.ok) return NextResponse.json({ error: hubs.message }, { status: 400 })

    // Pickup goes to its own columns. It is no longer folded into wantedItems,
    // which is now the free text it was always named for.
    const hasPickup =
      body.localPickup === true && body.pickupLat != null && body.pickupLng != null

    const item = await prisma.item.create({
      data: {
        title: resolvedTitle,
        description: body.description || resolvedTitle,
        category: body.category,
        condition: body.condition,
        ...valueData,
        // Above the cap: the row exists, the owner can see it, nobody else
        // can, and the admin Review queue lists it. See ItemStatus. A
        // perishable never lands here — it was clamped instead.
        ...(needsReview ? { status: "PENDING_REVIEW" as const } : {}),
        wantedItems: body.wantedItems ?? null,
        images: JSON.stringify(body.images ?? []),
        userId: authorId,
        // The perishable block. All four are written together or not at all;
        // the schema refuses any other combination.
        ...(perishable
          ? {
              isPerishable: true,
              quantity: body.quantity ?? null,
              quantityUnit: body.quantityUnit ?? null,
              tradeWithinHours: body.tradeWithinHours ?? null,
            }
          : {}),
        // NOT perishable-only. This is the matcher's input and a standard
        // listing is just as likely to name what it wants back.
        ...(body.lookingForCategories?.length
          ? { lookingForCategories: body.lookingForCategories }
          : {}),
        ...(hasPickup
          ? {
              pickupLat: body.pickupLat!,
              pickupLng: body.pickupLng!,
              pickupAddress: body.pickupAddress ?? null,
            }
          : {}),
        // BOTH the legacy column and the per-photo rows, from one derivation so
        // they cannot drift. `imageHash` stays because the web wizard reads it
        // back in edit mode; `imageHashes` is what the duplicate check scans.
        ...(leadHash ? { imageHash: leadHash } : {}),
        ...(hashRows.length > 0 ? { imageHashes: { create: hashRows } } : {}),
        // Written inline with the item rather than in a second statement: a
        // listing that exists without the hubs its owner picked is a listing
        // that quietly lost them, and there would be no way to tell afterwards
        // that they were ever asked for.
        ...(hubs.hubIds.length > 0
          ? { safeZones: { create: hubs.hubIds.map((hubId) => ({ hubId })) } }
          : {}),
      },
      select: {
        ...ITEM_PUBLIC_SELECT,
        user: { select: ITEM_PUBLIC_USER_SELECT },
        safeZones: { select: { hub: { select: SAFE_ZONE_HUB_SELECT } } },
      },
    })

    // FIRST_LISTING is one-time — the @@unique([userId, task, refId]) constraint
    // on TaskCompletion makes every later listing a no-op. There is deliberately
    // NO per-listing reward: posting must never be a faucet.
    // THE PERSON, NOT THE ORG. A task reward is a fact about somebody learning
    // to use Baylo, and crediting it to the org's backing row would both rob
    // the staff member of their own first-listing award and pay Leaves into an
    // account no person controls. `humanUserId` is always the real person —
    // see ActingIdentity.
    awardTaskAsync(acting.acting.humanUserId, "FIRST_LISTING", "", {
      description: "Task reward: listed your first item",
    })

    // ── Tell the people who asked for this category ─────────────────────────
    //
    // FIRE-AND-FORGET, and `void` is load-bearing: this does up to
    // MATCH_NOTIFY_CAP writes and as many Pusher calls, and awaiting it would
    // make posting an item as slow as the slowest of twenty-five network calls.
    // A listing must not fail because nobody could be told about it.
    //
    // Skipped for a listing nobody can see yet — a PENDING_REVIEW row is
    // invisible to everyone but its owner, and notifying strangers about it
    // would be the one surface that leaks it.
    if (!needsReview) {
      notifyCategoryMatchesAsync({
        itemId: item.id,
        authorUserId: authorId,
        category: body.category,
        lookingForCategories: body.lookingForCategories ?? [],
      })
    }

    // The creator is the owner, so this response carries the exact point back.
    //
    // `safeZones` is rebuilt from the rows rather than left to shapeItem()'s
    // spread, which would ship the raw `{ hub: { … } }` join shape. Same reason
    // that function deletes the pickup columns instead of trusting a caller to.
    const { safeZones, ...itemRow } = item
    return NextResponse.json(
      {
        // The AUTHOR sees the exact point back — which is the org's row when
        // posting for an org, and the staff member is acting as it.
        ...shapeItem(itemRow, authorId),
        safeZones: safeZones.map((s) => v1Hub(s.hub as SafeZoneHubRow)),
        // What happened to the value, so the wizard's posted dialog can say
        // "live", "waiting for review" or "capped" without re-deriving the rule.
        valueReview: {
          decision: valued.decision,
          pending: needsReview,
          notice: needsReview
            ? reviewNotice(valueData.valueLeaves, valueData.suggestedLeaves)
            : null,
          // Set only when the perishable rule lowered the value. A separate
          // field from `notice` because it is not a refusal and the wizard
          // styles it differently — the listing IS live.
          clamped: finalValue?.clamped ?? false,
          clampNotice: finalValue?.notice ?? null,
          requestedLeaves: finalValue?.requestedLeaves ?? null,
        },
        // Who it was posted as, so the wizard can say "Posted as <org>" rather
        // than leaving the staff member to wonder whose shelf it landed on.
        postedAs: acting.acting.organization
          ? { organizationId: acting.acting.organization.id, name: acting.acting.organization.name }
          : null,
      },
      { status: 201 },
    )
  } catch (e) {
    // TEMPORARY (24 Sep 2026): a perishable post failed with nothing in the
    // dev log, because this catch swallowed the exception whole. Remove once
    // the cause is known.
    console.error("[items POST] unhandled", e)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
