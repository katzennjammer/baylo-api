// Listing appeals, part C (18 Sep 2026): the owner's appeal, the lock, the
// admin queue, and both outcomes.
//
//   1  what can be appealed: a value rejection or a takedown; nothing else;
//      by the owner only; 1..300 characters
//   2  one appeal per decision, and filing changes nothing on the listing
//   3  the listing is locked while the appeal is open (value edit, delete)
//   4  the queue shows the whole case; non-staff cannot read it
//   5  overturn a value rejection: AVAILABLE at the requested value, audit,
//      owner told; deciding again is a 409
//   6  uphold: nothing moves, final (no re-appeal), the lock is released
//   7  same reviewer: allowed, recorded in the audit detail
//   8  takedown appeals: overturn clears the hide; uphold keeps it; a fresh
//      takedown is a fresh right of appeal
//   9  the state moved under an open appeal: 409 STATE_CHANGED, appeal stays open
//  10  the decided list
//
// HTTP against a dev server bound to the SAME scratch schema as this script;
// see scripts/verify-value-review.ts for the incantation. Refuses `public`.

import prisma from "../src/lib/prisma"
import { signAccessToken } from "../src/lib/auth-tokens"
import { requireScratchSchema } from "./lib/live-guard"

const BASE = process.env.ACCEPT_BASE ?? "http://127.0.0.1:3001"
const P = "zzap-"

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
const DEL = (p: string, t: string | null) => call("DELETE", p, t)
const code = (r: { body: Body }) => r.body?.meta?.code ?? r.body?.code ?? r.body?.error?.code

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: P } }, select: { id: true } })
  const ids = users.map((u) => u.id)
  if (ids.length === 0) return
  const items = await prisma.item.findMany({ where: { userId: { in: ids } }, select: { id: true } })
  const itemIds = items.map((i) => i.id)
  const appeals = await prisma.listingAppeal.findMany({ where: { itemId: { in: itemIds } }, select: { id: true } })
  await prisma.adminAction.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { targetId: { in: [...ids, ...itemIds, ...appeals.map((a) => a.id)] } }] } })
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
async function makeItem(userId: string, title: string, status: "PENDING_REVIEW" | "AVAILABLE") {
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
  requireScratchSchema("scripts/verify-appeals.ts")
  console.log(`Appeals acceptance — ${BASE}`)
  await cleanup()

  const owner = await makeUser("owner")
  const adminA = await makeUser("adminA", "ADMIN")   // makes the decisions
  const adminB = await makeUser("adminB", "ADMIN")   // decides the appeals
  const stranger = await makeUser("stranger")
  const tOwner = await signAccessToken(owner.id)
  const tA = await signAccessToken(adminA.id)
  const tB = await signAccessToken(adminB.id)
  const tStranger = await signAccessToken(stranger.id)

  const reject = (id: string, reasonCode = "ABOVE_MARKET") =>
    POST(`/api/admin/listings/${id}`, tA, { action: "reject-value", reasonCode, note: "private note" })
  const hide = (id: string, who = tA) => POST(`/api/admin/listings/${id}`, who, { action: "hide", reason: "counterfeit" })
  const appeal = (id: string, message = "The suggestion ignores that this is a first edition; three of these sold at 2,400 this month.") =>
    POST(`/api/v1/items/${id}/appeal`, tOwner, { message })
  const rejectedAction = (id: string) => prisma.adminAction.findFirst({ where: { targetId: id, action: "LISTING_VALUE_REJECTED" }, orderBy: { createdAt: "desc" } })
  const notes = () => prisma.notification.count({ where: { userId: owner.id } })

  const r1 = await makeItem(owner.id, `${P}Overturn Me`, "PENDING_REVIEW")
  const r2 = await makeItem(owner.id, `${P}Uphold Me`, "PENDING_REVIEW")
  const r3 = await makeItem(owner.id, `${P}Same Reviewer`, "PENDING_REVIEW")
  const r5 = await makeItem(owner.id, `${P}State Changes`, "PENDING_REVIEW")
  const pending = await makeItem(owner.id, `${P}Still Waiting`, "PENDING_REVIEW")
  const plain = await makeItem(owner.id, `${P}Plain`, "AVAILABLE")
  const h1 = await makeItem(owner.id, `${P}Hidden Overturn`, "AVAILABLE")
  const h2 = await makeItem(owner.id, `${P}Hidden Uphold`, "AVAILABLE")
  for (const i of [r1, r2, r3, r5]) await reject(i.id)

  head("1  what can be appealed")
  const a1 = await appeal(plain.id)
  check("AVAILABLE listing → 409 NOTHING_TO_APPEAL", a1.status === 409 && code(a1) === "NOTHING_TO_APPEAL", `${a1.status} ${JSON.stringify(a1.body)}`)
  const a2 = await appeal(pending.id)
  check("PENDING_REVIEW (not decided yet) → 409 NOTHING_TO_APPEAL", a2.status === 409 && code(a2) === "NOTHING_TO_APPEAL", `${a2.status}`)
  const a3 = await POST(`/api/v1/items/${r1.id}/appeal`, tStranger, { message: "mine now" })
  check("stranger → 404", a3.status === 404, `${a3.status}`)
  const a4 = await appeal(r1.id, "")
  check("empty message → 400", a4.status === 400, `${a4.status}`)
  const a5 = await appeal(r1.id, "x".repeat(301))
  check("301 characters → 400", a5.status === 400, `${a5.status}`)
  const a6 = await appeal(r1.id, "x".repeat(300))
  check("300 characters → 200", a6.status === 200, `${a6.status} ${JSON.stringify(a6.body)}`)
  const row1 = await prisma.listingAppeal.findUnique({ where: { id: a6.body?.data?.appeal?.id ?? "" } })
  const act1 = await rejectedAction(r1.id)
  check("row: OPEN, VALUE_REJECTION, actionId = the rejection's audit row", row1?.status === "OPEN" && row1.kind === "VALUE_REJECTION" && row1.actionId === act1?.id, JSON.stringify(row1))
  check("filing wrote NO AdminAction", (await prisma.adminAction.count({ where: { targetType: "LISTING_APPEAL" } })) === 0)

  head("2  one per decision; filing changes nothing")
  const dup = await appeal(r1.id, "again")
  check("second appeal → 409 APPEAL_OPEN", dup.status === 409 && code(dup) === "APPEAL_OPEN", `${dup.status} ${JSON.stringify(dup.body)}`)
  const r1Row = await prisma.item.findUnique({ where: { id: r1.id } })
  check("listing still VALUE_REJECTED with its reason", r1Row?.status === "VALUE_REJECTED" && r1Row.valueRejectionReason === "ABOVE_MARKET")
  check("stranger still gets 404", (await GET(`/api/v1/items/${r1.id}`, tStranger)).status === 404)
  const det = await GET(`/api/v1/items/${r1.id}`, tOwner)
  const ap = det.body?.data?.review?.appeal
  check("owner detail: review.appeal { id, status OPEN, kind, message, canAppeal false }", ap?.id === row1?.id && ap.status === "OPEN" && ap.kind === "VALUE_REJECTION" && ap.message?.length === 300 && ap.canAppeal === false, JSON.stringify(ap))

  head("3  locked while open")
  const lockV = await PATCH(`/api/items/${r1.id}`, tOwner, { valueLeaves: null })
  check("PATCH value → 409 APPEAL_OPEN", lockV.status === 409 && code(lockV) === "APPEAL_OPEN", `${lockV.status} ${JSON.stringify(lockV.body)}`)
  const lockC = await PATCH(`/api/items/${r1.id}`, tOwner, { condition: "POOR" })
  check("PATCH condition → 409 APPEAL_OPEN", lockC.status === 409, `${lockC.status}`)
  const lockT = await PATCH(`/api/items/${r1.id}`, tOwner, { title: `${P}Overturn Me (retitled)` })
  check("PATCH title only → 200 (not a valuation input)", lockT.status === 200, `${lockT.status} ${JSON.stringify(lockT.body)}`)
  const lockD = await DEL(`/api/items/${r1.id}`, tOwner)
  check("DELETE → 409 APPEAL_OPEN", lockD.status === 409 && code(lockD) === "APPEAL_OPEN", `${lockD.status}`)
  check("…and it was not deleted", (await prisma.item.findUnique({ where: { id: r1.id } }))?.status === "VALUE_REJECTED")

  head("4  the queue")
  const q403 = await GET(`/api/admin/appeals`, tOwner)
  check("non-staff → 403", q403.status === 403, `${q403.status}`)
  const qB = await GET(`/api/admin/appeals`, tB)
  const rowB = (qB.body?.data?.appeals ?? []).find((a: Body) => a.id === row1?.id)
  check("adminB sees the case: listing values+brackets, decision by adminA with code+note, message, sameReviewer false", !!rowB && rowB.listing.requestedLeaves === 2500 && rowB.listing.suggestedLeaves === 300 && rowB.listing.requestedBracket === 6 && rowB.listing.suggestedBracket === 3 && rowB.decision?.by?.id === adminA.id && rowB.decision.reasonCode === "ABOVE_MARKET" && rowB.decision.note === "private note" && rowB.message.length === 300 && rowB.sameReviewer === false, JSON.stringify(rowB))
  const qA = await GET(`/api/admin/appeals`, tA)
  const rowA = (qA.body?.data?.appeals ?? []).find((a: Body) => a.id === row1?.id)
  check("adminA sees sameReviewer true on the same row", rowA?.sameReviewer === true)
  check("open queue is oldest first", (qB.body?.data?.appeals ?? []).every((a: Body, i: number, arr: Body[]) => i === 0 || a.createdAt >= arr[i - 1].createdAt))

  head("5  overturn a value rejection")
  const noReason = await POST(`/api/admin/appeals/${row1?.id}`, tB, { decision: "overturn" })
  check("no reason → 400", noReason.status === 400, `${noReason.status}`)
  const nonStaff = await POST(`/api/admin/appeals/${row1?.id}`, tOwner, { decision: "overturn", reason: "please" })
  check("non-staff → 403", nonStaff.status === 403, `${nonStaff.status}`)
  const n5 = await notes()
  const ov = await POST(`/api/admin/appeals/${row1?.id}`, tB, { decision: "overturn", reason: "first edition, comparables support it" })
  check("overturn → 200, sameReviewer false", ov.status === 200 && ov.body?.data?.appeal?.status === "OVERTURNED" && ov.body.data.appeal.sameReviewer === false, `${ov.status} ${JSON.stringify(ov.body)}`)
  const r1After = await prisma.item.findUnique({ where: { id: r1.id } })
  check("listing AVAILABLE at 2,500, reason cleared", r1After?.status === "AVAILABLE" && r1After.valueLeaves === 2500 && r1After.valueRejectionReason === null, JSON.stringify({ s: r1After?.status, v: r1After?.valueLeaves }))
  const ap1 = await prisma.listingAppeal.findUnique({ where: { id: row1!.id } })
  check("appeal OVERTURNED by adminB with the reason", ap1?.status === "OVERTURNED" && ap1.decidedById === adminB.id && ap1.decisionReason === "first edition, comparables support it" && !!ap1.decidedAt)
  const aud1 = await prisma.adminAction.findFirst({ where: { targetType: "LISTING_APPEAL", targetId: row1!.id } })
  const d1 = JSON.parse(aud1?.detail ?? "{}")
  check("audit: LISTING_APPEAL_OVERTURNED by adminB, detail names the appealed row, both brackets, no sameReviewer", aud1?.action === "LISTING_APPEAL_OVERTURNED" && aud1.actorId === adminB.id && d1.appealedActionId === act1?.id && d1.appealedActorId === adminA.id && d1.requestedBracket === 6 && d1.suggestedBracket === 3 && d1.sameReviewer === undefined, JSON.stringify(aud1))
  const note1 = await prisma.notification.findFirst({ where: { userId: owner.id, type: "LISTING_APPEAL_OVERTURNED" } })
  check("owner notified LISTING_APPEAL_OVERTURNED, no actor, routable, says 'live at 2,500'", note1?.actorId === null && note1.entityType === "listing_review" && note1.entityId === r1.id && note1.message.includes("2,500") && (await notes()) === n5 + 1, JSON.stringify(note1))
  check("stranger can now open it", (await GET(`/api/v1/items/${r1.id}`, tStranger)).status === 200)
  const twice = await POST(`/api/admin/appeals/${row1?.id}`, tB, { decision: "uphold", reason: "changed my mind" })
  check("deciding again → 409 ALREADY_DECIDED", twice.status === 409 && code(twice) === "ALREADY_DECIDED", `${twice.status}`)
  const reAppeal = await appeal(r1.id, "again?")
  check("appealing an overturned decision → 409 (nothing to appeal: it is AVAILABLE now)", reAppeal.status === 409, `${reAppeal.status} ${code(reAppeal)}`)

  head("6  uphold")
  const a2r = await appeal(r2.id)
  const row2 = a2r.body?.data?.appeal
  const up = await POST(`/api/admin/appeals/${row2?.id}`, tB, { decision: "uphold", reason: "condition photos show wear" })
  check("uphold → 200", up.status === 200 && up.body?.data?.appeal?.status === "UPHELD", `${up.status} ${JSON.stringify(up.body)}`)
  const r2After = await prisma.item.findUnique({ where: { id: r2.id } })
  check("listing still VALUE_REJECTED, reason kept, value untouched", r2After?.status === "VALUE_REJECTED" && r2After.valueRejectionReason === "ABOVE_MARKET" && r2After.valueLeaves === 2500)
  const aud2 = await prisma.adminAction.findFirst({ where: { targetType: "LISTING_APPEAL", targetId: row2?.id ?? "" } })
  check("audit: LISTING_APPEAL_UPHELD", aud2?.action === "LISTING_APPEAL_UPHELD" && aud2.actorId === adminB.id)
  const note2 = await prisma.notification.findFirst({ where: { userId: owner.id, type: "LISTING_APPEAL_UPHELD", entityId: r2.id } })
  check("owner notified LISTING_APPEAL_UPHELD with the three exits and 'can't be appealed again'", !!note2 && note2.actorId === null && note2.message.includes("can't be appealed again") && note2.message.includes("suggested 300"), note2?.message)
  const reUp = await appeal(r2.id, "please look again")
  check("re-appeal → 409 APPEAL_UPHELD", reUp.status === 409 && code(reUp) === "APPEAL_UPHELD", `${reUp.status} ${code(reUp)}`)
  const det2 = await GET(`/api/v1/items/${r2.id}`, tOwner)
  check("owner detail: review.appeal.status UPHELD, canAppeal false", det2.body?.data?.review?.appeal?.status === "UPHELD" && det2.body.data.review.appeal.canAppeal === false, JSON.stringify(det2.body?.data?.review?.appeal))
  const unlock = await PATCH(`/api/items/${r2.id}`, tOwner, { valueLeaves: null })
  const r2Relist = await prisma.item.findUnique({ where: { id: r2.id } })
  check("lock released: PATCH to the suggestion → AVAILABLE", unlock.status === 200 && r2Relist?.status === "AVAILABLE", `${unlock.status} ${r2Relist?.status}`)

  head("7  same reviewer: allowed, recorded")
  const a3r = await appeal(r3.id)
  const row3 = a3r.body?.data?.appeal
  const same = await POST(`/api/admin/appeals/${row3?.id}`, tA, { decision: "uphold", reason: "still above market" })
  check("adminA decides their own decision → 200, sameReviewer true", same.status === 200 && same.body?.data?.appeal?.sameReviewer === true, `${same.status} ${JSON.stringify(same.body)}`)
  const aud3 = await prisma.adminAction.findFirst({ where: { targetType: "LISTING_APPEAL", targetId: row3?.id ?? "" } })
  check("audit detail.sameReviewer === true", JSON.parse(aud3?.detail ?? "{}").sameReviewer === true, aud3?.detail ?? "")

  head("8  takedown appeals")
  await hide(h1.id)
  await hide(h2.id)
  const hideAct1 = await prisma.adminAction.findFirst({ where: { targetId: h1.id, action: "LISTING_HIDDEN" } })
  const ah1 = await appeal(h1.id, "This is my own photo of my own bag; the report was wrong.")
  check("appeal on a hidden listing → 200, kind MODERATION_HIDE against the LISTING_HIDDEN row", ah1.status === 200 && ah1.body?.data?.appeal?.kind === "MODERATION_HIDE" && (await prisma.listingAppeal.findUnique({ where: { id: ah1.body.data.appeal.id } }))?.actionId === hideAct1?.id, `${ah1.status} ${JSON.stringify(ah1.body)}`)
  const qH = await GET(`/api/admin/appeals`, tB)
  const rowH = (qH.body?.data?.appeals ?? []).find((a: Body) => a.id === ah1.body?.data?.appeal?.id)
  check("queue row: Takedown, decision.reason 'counterfeit', listing.hidden true", rowH?.kind === "MODERATION_HIDE" && rowH.decision?.reason === "counterfeit" && rowH.listing.hidden === true, JSON.stringify(rowH))
  const ovH = await POST(`/api/admin/appeals/${rowH?.id}`, tB, { decision: "overturn", reason: "reporter was mistaken" })
  const h1After = await prisma.item.findUnique({ where: { id: h1.id } })
  check("overturn → visible again (moderationHiddenAt null), status untouched", ovH.status === 200 && h1After?.moderationHiddenAt === null && h1After.status === "AVAILABLE", `${ovH.status} ${JSON.stringify(h1After)}`)
  check("stranger can open it", (await GET(`/api/v1/items/${h1.id}`, tStranger)).status === 200)
  const noteH = await prisma.notification.findFirst({ where: { userId: owner.id, type: "LISTING_APPEAL_OVERTURNED", entityId: h1.id } })
  check("owner told 'visible again'", !!noteH && noteH.message.includes("visible again"), noteH?.message)
  const ah2 = await appeal(h2.id, "Please reconsider.")
  const upH = await POST(`/api/admin/appeals/${ah2.body?.data?.appeal?.id}`, tB, { decision: "uphold", reason: "it is counterfeit" })
  const h2After = await prisma.item.findUnique({ where: { id: h2.id } })
  check("uphold a takedown → still hidden", upH.status === 200 && h2After?.moderationHiddenAt !== null)
  const reH = await appeal(h2.id, "again")
  check("re-appeal → 409 APPEAL_UPHELD", reH.status === 409 && code(reH) === "APPEAL_UPHELD", `${reH.status}`)
  await POST(`/api/admin/listings/${h2.id}`, tB, { action: "unhide", reason: "second look" })
  await hide(h2.id, tB)
  const fresh = await appeal(h2.id, "a new takedown, a new appeal")
  check("a fresh takedown is a fresh right of appeal → 200", fresh.status === 200, `${fresh.status} ${JSON.stringify(fresh.body)}`)

  head("9  the state moved under an open appeal")
  const a5r = await appeal(r5.id)
  // Simulate the state changing outside the owner's locked path (a manual
  // fix, a script): the listing is no longer VALUE_REJECTED.
  await prisma.item.update({ where: { id: r5.id }, data: { status: "OWNED" } })
  const ov5 = await POST(`/api/admin/appeals/${a5r.body?.data?.appeal?.id}`, tB, { decision: "overturn", reason: "fine" })
  check("overturn → 409 STATE_CHANGED", ov5.status === 409 && code(ov5) === "STATE_CHANGED", `${ov5.status} ${JSON.stringify(ov5.body)}`)
  const ap5 = await prisma.listingAppeal.findUnique({ where: { id: a5r.body?.data?.appeal?.id ?? "" } })
  check("appeal still OPEN, nothing audited, owner not notified", ap5?.status === "OPEN" && (await prisma.adminAction.count({ where: { targetType: "LISTING_APPEAL", targetId: ap5?.id ?? "" } })) === 0)
  const up5 = await POST(`/api/admin/appeals/${ap5?.id}`, tB, { decision: "uphold", reason: "moot" })
  check("uphold still works (nothing to move)", up5.status === 200, `${up5.status}`)

  head("10  the decided list")
  const decided = await GET(`/api/admin/appeals?status=decided`, tB)
  const decidedIds = (decided.body?.data?.appeals ?? []).map((a: Body) => a.id)
  check("decided list has r1 (overturned), r2 (upheld), r3, h1, h2; not the open one", [row1?.id, row2?.id, row3?.id].every((i) => decidedIds.includes(i)) && !decidedIds.includes(fresh.body?.data?.appeal?.id), JSON.stringify(decidedIds))
  const openNow = await GET(`/api/admin/appeals`, tB)
  check("open list has exactly the fresh takedown appeal from these fixtures", (openNow.body?.data?.appeals ?? []).filter((a: Body) => a.owner.id === owner.id).map((a: Body) => a.id).join() === fresh.body?.data?.appeal?.id)

  console.log(`\n${pass} pass, ${fail} fail`)
  await cleanup()
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
