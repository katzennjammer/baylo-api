// Value reviews, part A (18 Sep 2026): the admin decision and what the owner
// can see afterwards.
//
//   1  a reject needs a reason CODE; an approve needs a typed reason
//   2  approve publishes at the requested value and tells the owner
//   3  reject moves the listing to VALUE_REJECTED with the code, tells the
//      owner the code's sentence and NOT the note, names no moderator, and
//      is routable (entityType "listing_review")
//   4  a second decision on a decided listing is a 409, not a second notification
//   5  the queue and the filters tell "waiting for admin" from "waiting for owner"
//   6  the owner reads their own rejected/waiting listing (200 + review block);
//      a stranger gets 404
//   7  the owner's shelf lists rejected and waiting listings, with counts
//   8  PATCH leaves VALUE_REJECTED: to AVAILABLE within the cap, back to
//      PENDING_REVIEW above it, clearing the reason either way
//   9  a takedown notifies the owner (no actor), and the owner can still open
//      the hidden listing (200, review.state "hidden") -- the 404 fix
//  10  a restore sends nothing
//
// HTTP against a dev server bound to the SAME scratch schema as this script:
//
//   .\scripts\scratch.ps1 -Push -Name scratch_vr
//   .\scripts\scratch.ps1 -Dev  -Name scratch_vr -Port 3001      (other window)
//   $env:ACCEPT_BASE="http://127.0.0.1:3001"
//   $env:DATABASE_URL="<live url>?schema=scratch_vr"
//   npx tsx --env-file=.env scripts\verify-value-review.ts
//
// Refuses to run against `public` (live).

import prisma from "../src/lib/prisma"
import { signAccessToken } from "../src/lib/auth-tokens"
import { requireScratchSchema } from "./lib/live-guard"
import { VALUE_REJECTION_REASONS } from "../src/lib/value-rejection"

const BASE = process.env.ACCEPT_BASE ?? "http://127.0.0.1:3001"
const P = "zzvr-"

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`) }
}
function head(s: string) { console.log(`\n── ${s} ${"─".repeat(Math.max(0, 68 - s.length))}`) }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any
async function call(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const GET = (p: string, t: string | null) => call("GET", p, t)
const POST = (p: string, t: string | null, b?: unknown) => call("POST", p, t, b ?? {})
const PATCH = (p: string, t: string | null, b?: unknown) => call("PATCH", p, t, b ?? {})

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: P } }, select: { id: true } })
  const ids = users.map((u) => u.id)
  if (ids.length === 0) return
  const items = await prisma.item.findMany({ where: { userId: { in: ids } }, select: { id: true } })
  const itemIds = items.map((i) => i.id)
  await prisma.adminAction.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { targetId: { in: [...ids, ...itemIds] } }] } })
  await prisma.listingAppeal.deleteMany({ where: { itemId: { in: itemIds } } })
  await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: ids } }, { actorId: { in: ids } }] } })
  await prisma.item.deleteMany({ where: { userId: { in: ids } } })
  await prisma.user.deleteMany({ where: { id: { in: ids } } })
}

async function makeUser(tag: string, role: "USER" | "ADMIN" = "USER") {
  return prisma.user.create({
    data: { name: `${P}${tag}`, email: `${P}${tag}@test.local`, isVerified: true, role, leaves: 0, lifetimeLeaves: 0 },
    select: { id: true },
  })
}

/** A listing parked for review: asked 2,500 against a 300 suggestion. */
async function makeReview(userId: string, title: string, status: "PENDING_REVIEW" | "AVAILABLE" = "PENDING_REVIEW") {
  return prisma.item.create({
    data: {
      title, description: title, images: "[]", category: "BOOKS", condition: "GOOD",
      valueLeaves: status === "PENDING_REVIEW" ? 2500 : 100, suggestedLeaves: status === "PENDING_REVIEW" ? 300 : 100,
      valueSetByUser: status === "PENDING_REVIEW", status, userId,
    },
    select: { id: true, title: true },
  })
}

async function main() {
  requireScratchSchema("scripts/verify-value-review.ts")
  console.log(`Value review acceptance — ${BASE}`)
  await cleanup()

  const owner = await makeUser("owner")
  const admin = await makeUser("admin", "ADMIN")
  const stranger = await makeUser("stranger")
  const tOwner = await signAccessToken(owner.id)
  const tAdmin = await signAccessToken(admin.id)
  const tStranger = await signAccessToken(stranger.id)

  const toApprove = await makeReview(owner.id, `${P}Approve Me`)
  const toReject = await makeReview(owner.id, `${P}Reject Me`)
  const toRelist = await makeReview(owner.id, `${P}Relist Me`)
  const toRepark = await makeReview(owner.id, `${P}Repark Me`)
  const stillWaiting = await makeReview(owner.id, `${P}Still Waiting`)
  const toHide = await makeReview(owner.id, `${P}Hide Me`, "AVAILABLE")
  const notesBefore = async () => prisma.notification.count({ where: { userId: owner.id } })

  head("1  reasons are required, and of the right kind")
  const r1 = await POST(`/api/admin/listings/${toReject.id}`, tAdmin, { action: "reject-value" })
  check("reject without reasonCode → 400", r1.status === 400, `${r1.status} ${JSON.stringify(r1.body)}`)
  const r2 = await POST(`/api/admin/listings/${toReject.id}`, tAdmin, { action: "reject-value", reasonCode: "BECAUSE" })
  check("reject with unknown reasonCode → 400", r2.status === 400, `${r2.status}`)
  const r3 = await POST(`/api/admin/listings/${toApprove.id}`, tAdmin, { action: "approve-value" })
  check("approve without reason → 400", r3.status === 400, `${r3.status}`)
  const r4 = await POST(`/api/admin/listings/${toApprove.id}`, tStranger, { action: "approve-value", reason: "x" })
  check("non-staff → 403", r4.status === 403, `${r4.status}`)
  check("nothing was decided by the refusals", (await prisma.item.count({ where: { userId: owner.id, status: "PENDING_REVIEW" } })) === 5)

  head("2  approve publishes at the requested value")
  const ap = await POST(`/api/admin/listings/${toApprove.id}`, tAdmin, { action: "approve-value", reason: "model is wrong about this edition" })
  check("approve → 200", ap.status === 200, `${ap.status} ${JSON.stringify(ap.body)}`)
  const apRow = await prisma.item.findUnique({ where: { id: toApprove.id } })
  check("AVAILABLE at 2,500, no rejection reason", apRow?.status === "AVAILABLE" && apRow.valueLeaves === 2500 && apRow.valueRejectionReason === null)
  const apNote = await prisma.notification.findFirst({ where: { userId: owner.id, entityId: toApprove.id } })
  check("owner notified LISTING_VALUE_APPROVED, no actor, routable", apNote?.type === "LISTING_VALUE_APPROVED" && apNote.actorId === null && apNote.entityType === "listing_review", JSON.stringify(apNote))

  head("3  reject: code shown, note hidden, no moderator named")
  const rj = await POST(`/api/admin/listings/${toReject.id}`, tAdmin, { action: "reject-value", reasonCode: "ABOVE_MARKET", note: "three comparables at 300" })
  check("reject → 200", rj.status === 200, `${rj.status} ${JSON.stringify(rj.body)}`)
  check("response says VALUE_REJECTED with the code", rj.body?.data?.listing?.status === "VALUE_REJECTED" && rj.body?.data?.listing?.valueRejectionReason === "ABOVE_MARKET", JSON.stringify(rj.body?.data))
  const rjRow = await prisma.item.findUnique({ where: { id: toReject.id } })
  check("row: VALUE_REJECTED, reason ABOVE_MARKET, value untouched", rjRow?.status === "VALUE_REJECTED" && rjRow.valueRejectionReason === "ABOVE_MARKET" && rjRow.valueLeaves === 2500, JSON.stringify({ s: rjRow?.status, r: rjRow?.valueRejectionReason, v: rjRow?.valueLeaves }))
  const rjAudit = await prisma.adminAction.findFirst({ where: { targetId: toReject.id, action: "LISTING_VALUE_REJECTED" } })
  check("audit row: reason = 'CODE: note', detail carries code and both brackets", (() => {
    if (!rjAudit) return false
    const d = JSON.parse(rjAudit.detail ?? "{}")
    return rjAudit.reason === "ABOVE_MARKET: three comparables at 300" && d.reasonCode === "ABOVE_MARKET" && d.note === "three comparables at 300" && d.requestedBracket > d.suggestedBracket
  })(), JSON.stringify(rjAudit))
  const rjNote = await prisma.notification.findFirst({ where: { userId: owner.id, entityId: toReject.id } })
  check("owner notified LISTING_VALUE_REJECTED, no actor, routable", rjNote?.type === "LISTING_VALUE_REJECTED" && rjNote.actorId === null && rjNote.entityType === "listing_review", JSON.stringify(rjNote))
  check("message carries the code's sentence", (rjNote?.message ?? "").includes(VALUE_REJECTION_REASONS.ABOVE_MARKET.owner), rjNote?.message)
  check("message does NOT carry the moderator's note", !(rjNote?.message ?? "").includes("three comparables"))
  console.log(`      "${rjNote?.message}"`)

  head("4  a decided listing cannot be decided again")
  const n4 = await notesBefore()
  const again = await POST(`/api/admin/listings/${toReject.id}`, tAdmin, { action: "reject-value", reasonCode: "OTHER" })
  check("second reject → 409 NOT_IN_REVIEW", again.status === 409 && again.body?.error?.code === "NOT_IN_REVIEW" || again.body?.meta?.code === "NOT_IN_REVIEW", `${again.status} ${JSON.stringify(again.body)}`)
  const apAgain = await POST(`/api/admin/listings/${toReject.id}`, tAdmin, { action: "approve-value", reason: "changed my mind" })
  check("approve on a rejected listing → 409 (that is the appeal's job)", apAgain.status === 409, `${apAgain.status}`)
  const apTwice = await POST(`/api/admin/listings/${toApprove.id}`, tAdmin, { action: "approve-value", reason: "twice" })
  check("approve on an approved listing → 409", apTwice.status === 409, `${apTwice.status}`)
  check("no notification was sent by any of those", (await notesBefore()) === n4)

  head("5  queue and filters tell the two waits apart")
  const anomalies = await GET(`/api/admin/anomalies`, tAdmin)
  const queued = (anomalies.body?.data?.valueReviews ?? []).map((r: Body) => r.itemId)
  check("anomalies queue still lists the waiting one", queued.includes(stillWaiting.id), JSON.stringify(queued))
  check("anomalies queue no longer lists the rejected one", !queued.includes(toReject.id))
  const filtered = await GET(`/api/admin/listings?status=value_rejected`, tAdmin)
  const filteredIds = (filtered.body?.data?.items ?? filtered.body?.data?.listings ?? []).map((r: Body) => r.id)
  check("GET /api/admin/listings?status=value_rejected → the rejected one only", filtered.status === 200 && filteredIds.includes(toReject.id) && !filteredIds.includes(stillWaiting.id), `${filtered.status} ${JSON.stringify(filteredIds)} keys=${Object.keys(filtered.body?.data ?? {})}`)
  const pendingF = await GET(`/api/admin/listings?status=pending_review`, tAdmin)
  const pendingIds = (pendingF.body?.data?.items ?? pendingF.body?.data?.listings ?? []).map((r: Body) => r.id)
  check("…?status=pending_review → the waiting ones, not the rejected", pendingIds.includes(stillWaiting.id) && !pendingIds.includes(toReject.id), JSON.stringify(pendingIds))

  head("6  the owner can open it; a stranger cannot")
  const det = await GET(`/api/v1/items/${toReject.id}`, tOwner)
  const review = det.body?.data?.review
  check("owner detail on rejected → 200", det.status === 200, `${det.status}`)
  check("review block: state rejected, code, sentence, both brackets, cap", review?.state === "rejected" && review.reasonCode === "ABOVE_MARKET" && review.reason === VALUE_REJECTION_REASONS.ABOVE_MARKET.owner && review.requestedLeaves === 2500 && review.suggestedLeaves === 300 && review.requestedBracket > review.suggestedBracket && typeof review.capBracket === "number", JSON.stringify(review))
  check("item.valueRejectionReason on the shape", det.body?.data?.item?.valueRejectionReason === "ABOVE_MARKET")
  check("review.appeal says an appeal is possible (part C fills the rest)", review?.appeal?.canAppeal === true && review.appeal.id === null, JSON.stringify(review?.appeal))
  const detW = await GET(`/api/v1/items/${stillWaiting.id}`, tOwner)
  check("owner detail on waiting → 200, state waiting, no appeal yet", detW.status === 200 && detW.body?.data?.review?.state === "waiting" && detW.body.data.review.appeal.canAppeal === false, JSON.stringify(detW.body?.data?.review))
  const detA = await GET(`/api/v1/items/${toApprove.id}`, tOwner)
  check("owner detail on the approved one → review null", detA.status === 200 && detA.body?.data?.review === null)
  const detS = await GET(`/api/v1/items/${toReject.id}`, tStranger)
  check("stranger on rejected → 404", detS.status === 404, `${detS.status}`)
  const detS2 = await GET(`/api/v1/items/${stillWaiting.id}`, tStranger)
  check("stranger on waiting → 404", detS2.status === 404, `${detS2.status}`)
  const detS3 = await GET(`/api/v1/items/${toApprove.id}`, tStranger)
  check("stranger on approved → 200 and no review block", detS3.status === 200 && detS3.body?.data?.review === null, `${detS3.status}`)

  head("7  the owner's shelf lists them")
  const me = await GET(`/api/v1/profile/me`, tOwner)
  const shelf: Body[] = me.body?.data?.items ?? []
  const byId = new Map(shelf.map((i) => [i.id, i]))
  check("shelf has the rejected listing, status VALUE_REJECTED, with the code", byId.get(toReject.id)?.status === "VALUE_REJECTED" && byId.get(toReject.id)?.valueRejectionReason === "ABOVE_MARKET", JSON.stringify(byId.get(toReject.id)))
  check("shelf has the waiting listing, status PENDING_REVIEW", byId.get(stillWaiting.id)?.status === "PENDING_REVIEW")
  check("counts: listed 2 (approved + hide-me), waitingReview 3, valueRejected 1", me.body?.data?.counts?.listed === 2 && me.body.data.counts.waitingReview === 3 && me.body.data.counts.valueRejected === 1, JSON.stringify(me.body?.data?.counts))
  const theirs = await GET(`/api/v1/profile/${owner.id}`, tStranger)
  const theirIds = (theirs.body?.data?.items ?? []).map((i: Body) => i.id)
  check("a stranger's view of the profile shows neither", !theirIds.includes(toReject.id) && !theirIds.includes(stillWaiting.id) && theirIds.includes(toApprove.id), JSON.stringify(theirIds))

  head("8  the owner leaves VALUE_REJECTED by editing")
  await POST(`/api/admin/listings/${toRelist.id}`, tAdmin, { action: "reject-value", reasonCode: "OVERVALUED_FOR_CONDITION" })
  await POST(`/api/admin/listings/${toRepark.id}`, tAdmin, { action: "reject-value", reasonCode: "OTHER" })
  const relist = await PATCH(`/api/items/${toRelist.id}`, tOwner, { valueLeaves: null })
  const relistRow = await prisma.item.findUnique({ where: { id: toRelist.id } })
  check("PATCH valueLeaves:null (take the suggestion) → AVAILABLE, reason cleared", relist.status === 200 && relistRow?.status === "AVAILABLE" && relistRow.valueRejectionReason === null && relistRow.valueLeaves === relistRow.suggestedLeaves, `${relist.status} ${JSON.stringify({ s: relistRow?.status, r: relistRow?.valueRejectionReason, v: relistRow?.valueLeaves, sg: relistRow?.suggestedLeaves })}`)
  const repark = await PATCH(`/api/items/${toRepark.id}`, tOwner, { valueLeaves: 50000 })
  const reparkRow = await prisma.item.findUnique({ where: { id: toRepark.id } })
  check("PATCH far above the cap → back to PENDING_REVIEW as a NEW review, reason cleared", repark.status === 200 && reparkRow?.status === "PENDING_REVIEW" && reparkRow.valueRejectionReason === null && repark.body?.valueReview?.pending === true, `${repark.status} ${JSON.stringify({ s: reparkRow?.status, r: reparkRow?.valueRejectionReason, vr: repark.body?.valueReview })}`)
  const reAnom = await GET(`/api/admin/anomalies`, tAdmin)
  check("…and it is back in the queue", (reAnom.body?.data?.valueReviews ?? []).some((r: Body) => r.itemId === toRepark.id))

  head("9  a takedown tells the owner, and the owner can still open it")
  const n9 = await notesBefore()
  const hide = await POST(`/api/admin/listings/${toHide.id}`, tAdmin, { action: "hide", reason: "counterfeit" })
  check("hide → 200", hide.status === 200, `${hide.status}`)
  const hideNote = await prisma.notification.findFirst({ where: { userId: owner.id, entityId: toHide.id }, orderBy: { createdAt: "desc" } })
  check("owner notified LISTING_HIDDEN, no actor, routable, no reason in it", hideNote?.type === "LISTING_HIDDEN" && hideNote.actorId === null && hideNote.entityType === "listing_review" && !hideNote.message.includes("counterfeit"), JSON.stringify(hideNote))
  const detH = await GET(`/api/v1/items/${toHide.id}`, tOwner)
  check("owner detail on HIDDEN → 200 (was 404)", detH.status === 200, `${detH.status} ${JSON.stringify(detH.body)}`)
  check("review.state hidden with hiddenAt; item.hiddenByModerator true", detH.body?.data?.review?.state === "hidden" && !!detH.body.data.review.hiddenAt && detH.body.data.item.hiddenByModerator === true, JSON.stringify(detH.body?.data?.review))
  const detHS = await GET(`/api/v1/items/${toHide.id}`, tStranger)
  check("stranger on hidden → 404", detHS.status === 404, `${detHS.status}`)
  const meH = await GET(`/api/v1/profile/me`, tOwner)
  const hiddenTile = (meH.body?.data?.items ?? []).find((i: Body) => i.id === toHide.id)
  check("owner's shelf tile says hiddenByModerator", hiddenTile?.hiddenByModerator === true, JSON.stringify(hiddenTile))
  const theirsH = await GET(`/api/v1/profile/${owner.id}`, tStranger)
  check("stranger's view of the profile does not list it", !(theirsH.body?.data?.items ?? []).some((i: Body) => i.id === toHide.id))
  check("exactly one notification for the takedown", (await notesBefore()) === n9 + 1)

  head("10  a restore sends nothing")
  const n10 = await notesBefore()
  const unhide = await POST(`/api/admin/listings/${toHide.id}`, tAdmin, { action: "unhide", reason: "appeal by email" })
  check("unhide → 200", unhide.status === 200, `${unhide.status}`)
  check("no notification", (await notesBefore()) === n10)
  const detU = await GET(`/api/v1/items/${toHide.id}`, tOwner)
  check("review block back to null", detU.body?.data?.review === null && detU.body?.data?.item?.hiddenByModerator === false)

  console.log(`\n${pass} pass, ${fail} fail`)
  await cleanup()
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
