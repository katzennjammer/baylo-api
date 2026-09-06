// Acceptance harness for government ID verification.
//
// Drives the REAL routes over HTTP, per the house convention, and reads the
// database directly only to build fixtures and to check what the routes wrote.
// Cloudinary is asked directly whether the image is gone, because "approving
// deletes the image" is an assertion about a third party's servers and the only
// honest way to check it is to ask them.
//
// Covers, in the order the spec lists them:
//   1  an unverified user gets 403 + ID_VERIFICATION_REQUIRED on POST /api/items
//   2  the SAME user can still browse, message and ACCEPT a trade
//   3  proposing a DPA is gated; accepting one is not
//   4  submitting the same ID number on a second account is refused
//   5  approving deletes the image from Cloudinary -- confirmed with Cloudinary
//   6  rejecting frees the ID, permits a resubmission, and the 4th is refused
//   7  an AdminAction row is written for every decision
//   8  a grandfathered account posts without submitting anything
//   9  a non-staff caller gets 403 from the decision route
//  10  account deletion frees the hash; suspension does not
//  11  SUM(User.leaves) == SUM(LeafTransaction.amount) is untouched throughout
//
// Run (from baylo/, with a dev server on BASE):
//   npx tsx --env-file=.env scripts/verify-id-verification.ts
import prisma from "../src/lib/prisma"
import { signAccessToken } from "../src/lib/auth-tokens"
import { hashIdNumber } from "../src/lib/id-verification"
import { idImageExists, uploadIdImage } from "../src/lib/id-verification-image"

const BASE = process.env.ACCEPT_BASE ?? "http://127.0.0.1:3100"
const P = "zzidv-"

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`) }
}
function head(s: string) { console.log(`\n── ${s} ${"─".repeat(Math.max(0, 68 - s.length))}`) }

interface Res<T = unknown> { status: number; body: T }

async function call<T = unknown>(
  method: string, path: string, token: string | null, body?: unknown,
): Promise<Res<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: (await res.json().catch(() => null)) as T }
}
const GET = <T = unknown>(p: string, t: string | null) => call<T>("GET", p, t)
const POST = <T = unknown>(p: string, t: string | null, b?: unknown) => call<T>("POST", p, t, b ?? {})

/**
 * A one-pixel PNG, as multipart, against the real submission endpoint.
 *
 * A REAL IMAGE AND NOT A STUB, because sanitizeImage() decodes the bytes and a
 * placeholder would be refused at the door — which would make every submission
 * test pass for the wrong reason.
 */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

async function submit(
  token: string, idType: string, idNumber: string,
): Promise<Res<{ data: unknown; error: { code: string; message: string } | null; meta: Record<string, unknown> }>> {
  const form = new FormData()
  form.append("idType", idType)
  form.append("idNumber", idNumber)
  form.append("file", new Blob([new Uint8Array(PNG_1PX)], { type: "image/png" }), "id.png")

  const res = await fetch(`${BASE}/api/v1/id-verification`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

/** SUM(User.leaves) == SUM(LeafTransaction.amount). Global, every row. */
async function invariant(label: string) {
  const [users, ledger] = await Promise.all([
    prisma.user.aggregate({ _sum: { leaves: true } }),
    prisma.leafTransaction.aggregate({ _sum: { amount: true } }),
  ])
  const u = users._sum.leaves ?? 0
  const l = ledger._sum.amount ?? 0
  check(`INVARIANT ${label}: SUM(User.leaves)=${u} == SUM(LeafTransaction.amount)=${l}`, u === l)
}

async function cleanup() {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: P } },
    select: { id: true },
  })
  const ids = users.map((u) => u.id)
  if (ids.length === 0) return

  // Any ID image these fixtures left on Cloudinary goes first — a test run that
  // litters a private folder with test uploads is a test run that costs money
  // and hides the real backlog on the admin page.
  const stale = await prisma.idVerification.findMany({
    where: { userId: { in: ids }, imagePublicId: { not: null } },
    select: { imagePublicId: true },
  })
  const { destroyIdImage } = await import("../src/lib/id-verification-image")
  for (const s of stale) if (s.imagePublicId) await destroyIdImage(s.imagePublicId)

  // Order matters: AdminAction.actorId is RESTRICT, so audit rows go before the
  // users they name.
  await prisma.adminAction.deleteMany({
    where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
  })
  const subs = await prisma.idVerification.findMany({
    where: { userId: { in: ids } }, select: { id: true },
  })
  await prisma.adminAction.deleteMany({ where: { targetId: { in: subs.map((s) => s.id) } } })
  await prisma.idVerification.deleteMany({ where: { userId: { in: ids } } })
  await prisma.deferredContract.deleteMany({
    where: { OR: [{ debtorId: { in: ids } }, { creditorId: { in: ids } }] },
  })
  await prisma.leafTransaction.deleteMany({ where: { userId: { in: ids } } })
  await prisma.notification.deleteMany({
    where: { OR: [{ userId: { in: ids } }, { actorId: { in: ids } }] },
  })
  await prisma.message.deleteMany({
    where: { OR: [{ senderId: { in: ids } }, { receiverId: { in: ids } }] },
  })
  await prisma.tradeRequest.deleteMany({
    where: { OR: [{ senderId: { in: ids } }, { receiverId: { in: ids } }] },
  })
  await prisma.offer.deleteMany({
    where: { OR: [{ senderId: { in: ids } }, { receiverId: { in: ids } }] },
  })
  await prisma.taskCompletion.deleteMany({ where: { userId: { in: ids } } })
  await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } })
  await prisma.emailVerificationToken.deleteMany({ where: { userId: { in: ids } } })
  await prisma.itemImageHash.deleteMany({ where: { item: { userId: { in: ids } } } })
  await prisma.item.deleteMany({ where: { userId: { in: ids } } })
  await prisma.user.deleteMany({ where: { id: { in: ids } } })
}

async function makeUser(
  tag: string,
  opts: { role?: "USER" | "MODERATOR" | "ADMIN"; grandfathered?: boolean } = {},
) {
  return prisma.user.create({
    data: {
      name: `${P}${tag}`,
      email: `${P}${tag}@test.local`,
      isVerified: true,
      role: opts.role ?? "USER",
      leaves: 0,
      lifetimeLeaves: 0,
      idVerifiedGrandfatheredAt: opts.grandfathered ? new Date() : null,
    },
    select: { id: true, name: true, email: true },
  })
}

async function makeItem(userId: string, title: string) {
  return prisma.item.create({
    data: {
      title, description: `${title} description`, images: "[]",
      category: "BOOKS", condition: "GOOD", valueLeaves: 100,
      status: "AVAILABLE", userId,
    },
    select: { id: true, title: true },
  })
}

const NEW_LISTING = {
  title: `${P}listing`,
  description: "a book",
  category: "BOOKS",
  condition: "GOOD",
  valueLeaves: 100,
  images: [],
}

async function main() {
  console.log(`ID verification acceptance — ${BASE}`)
  await cleanup()
  await invariant("at start")

  // ── fixtures ──
  const unverified = await makeUser("unverified")
  const other = await makeUser("other", { grandfathered: true })
  const grandfathered = await makeUser("grandfathered", { grandfathered: true })
  const rival = await makeUser("rival")
  const mod = await makeUser("mod", { role: "MODERATOR", grandfathered: true })

  const tUnverified = await signAccessToken(unverified.id)
  const tOther = await signAccessToken(other.id)
  const tGrandfathered = await signAccessToken(grandfathered.id)
  const tRival = await signAccessToken(rival.id)
  const tMod = await signAccessToken(mod.id)

  // ── 1 ── the gate itself
  head("1  posting is gated")
  const post1 = await POST<{ error: string; code: string }>("/api/items", tUnverified, NEW_LISTING)
  check("POST /api/items → 403", post1.status === 403, `got ${post1.status}`)
  check(
    "…with code ID_VERIFICATION_REQUIRED",
    post1.body?.code === "ID_VERIFICATION_REQUIRED",
    JSON.stringify(post1.body)?.slice(0, 160),
  )

  head("8  a grandfathered account posts with nothing submitted")
  const postG = await POST<{ id: string }>("/api/items", tGrandfathered, NEW_LISTING)
  // 201 Created — that is what the route answers on success.
  check("grandfathered POST /api/items → 201", postG.status === 201, `got ${postG.status}`)
  const gSubs = await prisma.idVerification.count({ where: { userId: grandfathered.id } })
  check("…and submitted no ID at all", gSubs === 0, `${gSubs} rows`)

  // ── 2 ── what is NOT gated
  head("2  everything else stays open to the same unverified user")
  const browse = await GET("/api/v1/browse?limit=5", tUnverified)
  check("GET /api/v1/browse → 200", browse.status === 200, `got ${browse.status}`)
  const home = await GET("/api/v1/home", tUnverified)
  check("GET /api/v1/home → 200", home.status === 200, `got ${home.status}`)
  const convos = await GET("/api/v1/messages/conversations", tUnverified)
  check("GET conversations → 200", convos.status === 200, `got ${convos.status}`)

  const theirItem = await makeItem(other.id, `${P}their-item`)
  const myItem = await makeItem(unverified.id, `${P}my-item`)
  const msg = await POST("/api/messages", tUnverified, {
    receiverId: other.id,
    content: "hello, is this still available?",
  })
  check("messaging → 2xx", msg.status >= 200 && msg.status < 300, `got ${msg.status}`)

  const like = await POST(`/api/v1/items/${theirItem.id}/like`, tUnverified)
  check("liking → 2xx", like.status >= 200 && like.status < 300, `got ${like.status}`)

  const comment = await POST(`/api/v1/items/${theirItem.id}/comments`, tUnverified, {
    content: "nice",
  })
  check("commenting → 2xx", comment.status >= 200 && comment.status < 300, `got ${comment.status}`)

  // ACCEPTING a trade. The other (verified) party proposes; the unverified user
  // accepts. This is the one the spec is most explicit about.
  const trade = await prisma.tradeRequest.create({
    data: {
      senderId: other.id,
      receiverId: unverified.id,
      offeredItemId: theirItem.id,
      requestedItemId: myItem.id,
      status: "PENDING",
      message: "swap?",
    },
    select: { id: true },
  })
  // PATCH /api/trades — the trade id is in the BODY, not the path; the path
  // form (/api/trades/[id]) is the cancel/hide route and takes an `action`.
  const accept = await call("PATCH", "/api/trades", tUnverified, {
    tradeId: trade.id,
    status: "ACCEPTED",
  })
  check(
    "ACCEPTING a trade while unverified → 2xx",
    accept.status >= 200 && accept.status < 300,
    `got ${accept.status} ${JSON.stringify(accept.body)?.slice(0, 140)}`,
  )

  // ── 3 ── proposing a DPA is gated
  head("3  proposing a DPA is gated (accepting is not)")
  const propose = await POST<{ error: { code: string }; meta: { rule?: string } }>(
    "/api/v1/contracts",
    tUnverified,
    { tradeId: trade.id, amountLeaves: 50, deadline: new Date(Date.now() + 7 * 86400_000).toISOString() },
  )
  check("POST /api/v1/contracts → 403", propose.status === 403, `got ${propose.status}`)
  check(
    "…with meta.rule ID_VERIFICATION_REQUIRED",
    propose.body?.meta?.rule === "ID_VERIFICATION_REQUIRED",
    JSON.stringify(propose.body?.meta)?.slice(0, 160),
  )

  // ── 4 ── one ID, one account
  head("4  the same ID number on a second account is refused")
  const ID_A = "S01-2345-6789"
  const s1 = await submit(tUnverified, "drivers_licence", ID_A)
  check("first submission → 200", s1.status === 200, `got ${s1.status} ${JSON.stringify(s1.body)?.slice(0, 200)}`)

  const s2 = await submit(tRival, "drivers_licence", ID_A)
  check("same number, second account → 409", s2.status === 409, `got ${s2.status}`)
  check(
    "…with rule ID_ALREADY_REGISTERED",
    (s2.body?.meta as { rule?: string })?.rule === "ID_ALREADY_REGISTERED",
    JSON.stringify(s2.body?.meta),
  )
  // And normalisation holds: punctuation must not be a way around it.
  const s2b = await submit(tRival, "drivers_licence", "s0123456789")
  check("…and punctuation is not a way around it", s2b.status === 409, `got ${s2b.status}`)

  // The digest, not the number, is what landed in the row.
  const row1 = await prisma.idVerification.findFirst({
    where: { userId: unverified.id },
    select: { id: true, idNumberHash: true, claimKey: true, imagePublicId: true, status: true },
  })
  check("the row stores the SHA-256 digest", row1?.idNumberHash === hashIdNumber(ID_A))
  check("…and claims it while PENDING", row1?.claimKey === hashIdNumber(ID_A))

  // ── 9 ── the decision route is staff-only
  head("9  a non-staff caller cannot decide")
  const notStaff = await POST(`/api/admin/id-verification/${row1!.id}`, tRival, {
    action: "approve", idNumber: ID_A,
  })
  check("non-staff decision → 403", notStaff.status === 403, `got ${notStaff.status}`)

  // The reviewer's number check.
  const wrongNumber = await POST(`/api/admin/id-verification/${row1!.id}`, tMod, {
    action: "approve", idNumber: "TOTALLY-DIFFERENT-1",
  })
  check("approving with the wrong number → 409", wrongNumber.status === 409, `got ${wrongNumber.status}`)

  // ── 5 ── approving destroys the image
  head("5  approving deletes the image from Cloudinary")
  const publicIdBefore = row1!.imagePublicId!
  check("the submission has a Cloudinary asset", !!publicIdBefore)
  const existedBefore = await idImageExists(publicIdBefore)
  check(`Cloudinary HAS it before the decision (${publicIdBefore})`, existedBefore)

  const approved = await POST<{ data: { imageDeleted: boolean } }>(
    `/api/admin/id-verification/${row1!.id}`,
    tMod,
    { action: "approve", idNumber: "s01 2345 6789" },
  )
  check("approve → 200", approved.status === 200, `got ${approved.status} ${JSON.stringify(approved.body)?.slice(0, 200)}`)

  const existsAfter = await idImageExists(publicIdBefore)
  check(`Cloudinary NO LONGER has it (${publicIdBefore})`, !existsAfter)

  const row1After = await prisma.idVerification.findUnique({
    where: { id: row1!.id },
    select: { status: true, imageUrl: true, imagePublicId: true, imageDeletedAt: true, claimKey: true },
  })
  check("row is APPROVED", row1After?.status === "APPROVED")
  check("imageUrl is null", row1After?.imageUrl === null)
  check("imagePublicId is null", row1After?.imagePublicId === null)
  check("imageDeletedAt is stamped", !!row1After?.imageDeletedAt)
  check("an APPROVED hash KEEPS its claim", row1After?.claimKey === hashIdNumber(ID_A))

  // The gate now opens.
  const post2 = await POST<{ id: string }>("/api/items", tUnverified, NEW_LISTING)
  check("the same user can now POST /api/items", post2.status === 201, `got ${post2.status}`)

  // ── 7 ── the audit row
  head("7  every decision writes an AdminAction")
  const auditApprove = await prisma.adminAction.findFirst({
    where: { targetType: "ID_VERIFICATION", targetId: row1!.id, action: "ID_VERIFICATION_APPROVED" },
    select: { actorId: true, reason: true, detail: true },
  })
  check("approval wrote an audit row", !!auditApprove)
  check("…naming the moderator", auditApprove?.actorId === mod.id)
  check("…with a non-empty reason", (auditApprove?.reason ?? "").length > 0, auditApprove?.reason)

  // The submitter was told.
  const noteApprove = await prisma.notification.findFirst({
    where: { userId: unverified.id, type: "ID_VERIFICATION_APPROVED" },
    select: { id: true },
  })
  check("…and the submitter was notified", !!noteApprove)

  // ── 6 ── rejection: reason, free hash, resubmission, and the 4th refusal
  head("6  rejection frees the ID, permits a retry, and caps at three")
  const ID_B = "P9876543"
  const r1 = await submit(tRival, "passport", ID_B)
  check("rival's first submission → 200", r1.status === 200, `got ${r1.status}`)
  const rRow1 = await prisma.idVerification.findFirst({
    where: { userId: rival.id }, orderBy: { submittedAt: "desc" },
    select: { id: true, imagePublicId: true },
  })
  const rejected1 = await POST(`/api/admin/id-verification/${rRow1!.id}`, tMod, {
    action: "reject", reason: "blurry_photo",
  })
  check("reject → 200", rejected1.status === 200, `got ${rejected1.status}`)
  const rRow1After = await prisma.idVerification.findUnique({
    where: { id: rRow1!.id },
    select: { status: true, rejectionReason: true, claimKey: true, imagePublicId: true },
  })
  check("row is REJECTED", rRow1After?.status === "REJECTED")
  check("…with the specific reason", rRow1After?.rejectionReason === "BLURRY_PHOTO")
  check("a REJECTED hash FREES its claim", rRow1After?.claimKey === null)
  check("…and its image is gone", rRow1After?.imagePublicId === null)

  const auditReject = await prisma.adminAction.findFirst({
    where: { targetType: "ID_VERIFICATION", targetId: rRow1!.id, action: "ID_VERIFICATION_REJECTED" },
    select: { reason: true },
  })
  check("rejection wrote an audit row", !!auditReject)

  // The user is told WHAT to fix, not merely "no".
  const noteReject = await prisma.notification.findFirst({
    where: { userId: rival.id, type: "ID_VERIFICATION_REJECTED" },
    select: { message: true },
  })
  check(
    "…and the notification says how to fix it",
    (noteReject?.message ?? "").toLowerCase().includes("retake"),
    noteReject?.message?.slice(0, 120),
  )

  // Resubmission with the SAME number now works — the claim was freed.
  const r2 = await submit(tRival, "passport", ID_B)
  check("resubmitting the same ID after rejection → 200", r2.status === 200, `got ${r2.status} ${JSON.stringify(r2.body)?.slice(0, 200)}`)
  const rRow2 = await prisma.idVerification.findFirst({
    where: { userId: rival.id, status: "PENDING" }, select: { id: true },
  })
  await POST(`/api/admin/id-verification/${rRow2!.id}`, tMod, {
    action: "reject", reason: "expired_id",
  })

  const r3 = await submit(tRival, "passport", ID_B)
  check("third submission → 200", r3.status === 200, `got ${r3.status}`)
  const rRow3 = await prisma.idVerification.findFirst({
    where: { userId: rival.id, status: "PENDING" }, select: { id: true },
  })
  await POST(`/api/admin/id-verification/${rRow3!.id}`, tMod, {
    action: "reject", reason: "not_government_id",
  })

  const r4 = await submit(tRival, "passport", ID_B)
  check("FOURTH submission → 403", r4.status === 403, `got ${r4.status}`)
  check(
    "…with rule ID_VERIFICATION_ATTEMPTS_EXHAUSTED",
    (r4.body?.meta as { rule?: string })?.rule === "ID_VERIFICATION_ATTEMPTS_EXHAUSTED",
    JSON.stringify(r4.body?.meta),
  )
  const rivalCount = await prisma.idVerification.count({ where: { userId: rival.id } })
  check("exactly three rows exist for that account", rivalCount === 3, `${rivalCount}`)

  const state = await GET<{ data: { status: string; attemptsRemaining: number } }>(
    "/api/v1/id-verification", tRival,
  )
  check("their state reads 'exhausted'", state.body?.data?.status === "exhausted", JSON.stringify(state.body?.data)?.slice(0, 160))

  // ── 10 ── suspension keeps the claim; deletion frees it
  head("10  suspension keeps the hash; deletion frees it")
  await prisma.user.update({
    where: { id: unverified.id },
    data: { suspendedAt: new Date(), suspendedUntil: null },
  })
  const stillClaimed = await prisma.idVerification.findUnique({
    where: { claimKey: hashIdNumber(ID_A) }, select: { id: true },
  })
  check("a SUSPENDED user's approved hash is still claimed", !!stillClaimed)
  await prisma.user.update({
    where: { id: unverified.id },
    data: { suspendedAt: null, suspendedUntil: null },
  })

  // Deletion goes through the real path so the summary and the row removal are
  // both exercised.
  const { deleteAccount } = await import("../src/app/api/user/delete-account")
  const del = await deleteAccount(unverified.id, undefined)
  check("deleteAccount succeeded", del.ok, del.ok ? "" : del.error)
  const freed = await prisma.idVerification.findUnique({
    where: { claimKey: hashIdNumber(ID_A) }, select: { id: true },
  })
  check("a DELETED user's hash is freed", freed === null)
  if (del.ok) {
    check("…and the summary says how many rows went", del.summary.idSubmissionsRemoved >= 1,
      String(del.summary.idSubmissionsRemoved))
  }

  // The audit rows survive the deletion of the submissions they describe.
  const auditSurvives = await prisma.adminAction.findFirst({
    where: { targetType: "ID_VERIFICATION", targetId: row1!.id },
    select: { id: true },
  })
  check("the audit row outlives the submission it describes", !!auditSurvives)

  // ── the sweep ──
  head("the retry sweep")
  // A decided row whose image was never destroyed is what the sweep exists for.
  // Manufacture one by uploading an image and pointing a REJECTED row at it.
  const orphan = await uploadIdImage(PNG_1PX)
  const sweepRow = await prisma.idVerification.create({
    data: {
      userId: other.id,
      idType: "UMID",
      idNumberHash: hashIdNumber("SWEEP-TEST-0001"),
      claimKey: null,
      status: "REJECTED",
      rejectionReason: "BLURRY_PHOTO",
      attemptCount: 1,
      imagePublicId: orphan.publicId,
      imageDeleteFailedAt: new Date(),
      reviewedAt: new Date(),
    },
    select: { id: true },
  })
  const { sweepUndeletedIdImages } = await import("../src/lib/id-verification-image")
  const swept = await sweepUndeletedIdImages()
  check(`sweep cleared ${swept.swept} (failed ${swept.failed})`, swept.swept >= 1)
  check("…and Cloudinary agrees the file is gone", !(await idImageExists(orphan.publicId)))
  const sweptRow = await prisma.idVerification.findUnique({
    where: { id: sweepRow.id }, select: { imagePublicId: true, imageDeletedAt: true },
  })
  check("…and the row no longer holds a delete key", sweptRow?.imagePublicId === null)
  check("…and is stamped", !!sweptRow?.imageDeletedAt)

  // ── 11 ──
  head("11  the Leaf invariant")
  await invariant("at end")

  await cleanup()

  console.log(`\n${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
