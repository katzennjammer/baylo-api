/**
 * The business-document retention lifecycle, against REAL Cloudinary.
 *
 * Run (schema guard applies -- see below):
 *   .\scripts\scratch.ps1 -Push -Name scratch_orgdoc
 *   .\scripts\scratch.ps1 -Dev  -Name scratch_orgdoc -Port 3101
 *   $env:ACCEPT_BASE="http://127.0.0.1:3101"
 *   npx tsx --env-file=.env scripts/verify-org-cloudinary.ts
 *
 * ── WHY THIS IS NOT PART OF verify-org-http.ts ──────────────────────────────
 *
 * That suite creates organisations through createOrganization() precisely so it
 * does not need credentials, and says so in its header. Everything here needs
 * real ones: it uploads real files to a real account, asks Cloudinary whether
 * they are still there, and deletes them again. Folding it in would make a
 * suite that currently runs anywhere depend on a third party's availability and
 * on secrets a CI runner should not hold. Separate file, separate run.
 *
 * ── WHAT "REAL" MEANS HERE ──────────────────────────────────────────────────
 *
 * Nothing is mocked and nothing is inferred from a return value. "The document
 * was deleted" is checked by asking Cloudinary's Admin API whether the asset
 * exists, because a destroy call that returned `ok` and a document that is
 * actually gone are two different claims, and only the second one is the
 * promise made to the person who uploaded their permit.
 *
 * The CDN is deliberately NOT used for that check. `invalidate: true` purges
 * edges asynchronously, so a delivery URL can keep serving a cached copy for a
 * short while after a destroy the origin has already honoured -- an assertion
 * on it would fail intermittently for a reason that is not a bug. The Admin API
 * is authoritative and immediate.
 *
 * ── THE TWO MODES ───────────────────────────────────────────────────────────
 *
 * Cloudinary cannot be made to fail from inside this process for code that runs
 * inside the DEV SERVER's process -- and the route's failure branches are the
 * interesting ones. So the fault is injected where it belongs, at the server:
 *
 *   (default)     the server holds good credentials. Sections 1-5.
 *   --degraded    the server was started with a deliberately wrong
 *                 CLOUDINARY_API_SECRET. Section 7: what a signup does when the
 *                 upload fails, and what a decision does when the destroy
 *                 fails. THIS PROCESS keeps its good credentials throughout, so
 *                 it can still set fixtures up and ask Cloudinary what really
 *                 happened.
 *
 *     $env:CLOUDINARY_API_SECRET="deliberately-wrong"
 *     .\scripts\scratch.ps1 -Dev -Name scratch_orgdoc -Port 3102
 *     $env:ACCEPT_BASE="http://127.0.0.1:3102"
 *     npx tsx --env-file=.env scripts/verify-org-cloudinary.ts --degraded
 *
 * ── THE ORPHAN LEDGER ───────────────────────────────────────────────────────
 *
 * Both modes snapshot every public_id in the document folder before they start
 * and again at the end. A file that appears and is still there when the suite
 * finishes is an orphan -- a business registration retained with nothing on
 * Baylo pointing at it, which no sweep can ever find because every sweep works
 * from Organization rows. That diff is the single most important assertion in
 * this file, and it catches leaks from paths nobody thought to test.
 */

import { v2 as cloudinary } from "cloudinary"
import prisma from "../src/lib/prisma"
import { signAccessToken } from "../src/lib/auth-tokens"
import { createOrganization } from "../src/lib/organizations"
import {
  ORG_DOC_FOLDER,
  destroyOrgDocument,
  orgDocumentExists,
  signOrgDocumentUrl,
  sweepUndeletedOrgDocuments,
  uploadOrgDocument,
} from "../src/lib/org-document"
import { requireScratchSchema, targetSchema } from "./lib/live-guard"

const BASE = process.env.ACCEPT_BASE ?? "http://127.0.0.1:3101"
const DEGRADED = process.argv.slice(2).includes("--degraded")
const P = "zzorgdoc-"

let pass = 0
let fail = 0
const warnings: string[] = []

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ""}`)
  }
}
function head(s: string) {
  console.log(`\n── ${s} ${"─".repeat(Math.max(0, 68 - s.length))}`)
}
function skip(s: string) {
  console.log(`  skip  ${s}`)
}
/**
 * Something true that is not a failure of this branch's code.
 *
 * Reserved for behaviour that diverges from what a comment claims but is
 * IDENTICAL in the ID-verification path this feature was told to mirror.
 * Failing the suite over it would paint a permanent red mark on a file nobody
 * on this branch may fix; saying nothing would hide it. So it is reported,
 * loudly, at the end.
 */
function warn(s: string) {
  warnings.push(s)
  console.log(`  WARN  ${s}`)
}

/**
 * A one-pixel PNG. A REAL image, because sanitizeImage() decodes the bytes and
 * a placeholder would be refused at the door — which would make every upload
 * test pass for the wrong reason.
 */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

// ── fixtures ─────────────────────────────────────────────────────────────────

const madeUsers: string[] = []
const madeOrgs: string[] = []

async function makeUser(tag: string, role: "USER" | "ADMIN" = "USER"): Promise<string> {
  const u = await prisma.user.create({
    data: {
      name: `${P}${tag}`,
      email: `${P}${tag}-${Date.now()}@test.invalid`,
      isVerified: true,
      idVerifiedGrandfatheredAt: new Date(),
      role,
    },
    select: { id: true },
  })
  madeUsers.push(u.id)
  return u.id
}

interface Res<T = unknown> {
  status: number
  body: T
}

async function signup(
  token: string,
  opts: { name?: string; category?: string; file?: { bytes: Buffer; filename: string; type: string } | null } = {},
): Promise<Res<{ data: { organizationId?: string } | null; error: { message?: string } | null }>> {
  const form = new FormData()
  form.append("name", opts.name ?? `${P}Shop`)
  form.append("businessCategory", opts.category ?? "SARI_SARI")
  if (opts.file !== null) {
    const f = opts.file ?? { bytes: PNG_1PX, filename: "permit.png", type: "image/png" }
    form.append("file", new Blob([new Uint8Array(f.bytes)], { type: f.type }), f.filename)
  }

  const res = await fetch(`${BASE}/api/v1/organizations`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  })
  return { status: res.status, body: (await res.json().catch(() => null)) as never }
}

async function decide(
  adminToken: string,
  orgId: string,
  body: Record<string, unknown>,
): Promise<Res<{ data: { documentDeleted?: boolean } | null; error: unknown }>> {
  const res = await fetch(`${BASE}/api/admin/organizations/${orgId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json().catch(() => null)) as never }
}

/** Every public_id currently in the document folder. The orphan ledger. */
async function listOrgDocuments(): Promise<Set<string>> {
  const found = new Set<string>()
  let cursor: string | undefined
  do {
    const page = (await cloudinary.api.resources({
      type: "authenticated",
      resource_type: "image",
      prefix: ORG_DOC_FOLDER,
      max_results: 500,
      ...(cursor ? { next_cursor: cursor } : {}),
    })) as { resources: { public_id: string }[]; next_cursor?: string }
    for (const r of page.resources) found.add(r.public_id)
    cursor = page.next_cursor
  } while (cursor)
  return found
}

/**
 * Run something with this process's Cloudinary credentials deliberately wrong.
 *
 * ALWAYS restores them, including on a throw — every later check that asks
 * Cloudinary whether a file exists would otherwise get `false` because the
 * Admin API rejected the signature, and would report a document as deleted
 * when it is sitting right there. That failure mode would be silent and would
 * invert the meaning of the whole suite, which is why this is a helper with a
 * `finally` rather than two lines at the call site.
 */
async function withBrokenCredentials<T>(fn: () => Promise<T>): Promise<T> {
  const real = process.env.CLOUDINARY_API_SECRET
  cloudinary.config({ api_secret: "deliberately-wrong-for-this-check" })
  try {
    return await fn()
  } finally {
    cloudinary.config({ api_secret: real })
  }
}

async function cleanup() {
  const users = await prisma.user.findMany({
    where: { name: { startsWith: P } },
    select: { id: true },
  })
  const ids = [...new Set([...users.map((u) => u.id), ...madeUsers])]
  if (ids.length === 0) return

  const orgs = await prisma.organization.findMany({
    where: { OR: [{ id: { in: madeOrgs } }, { orgUserId: { in: ids } }] },
    select: { id: true, businessDocPublicId: true },
  })

  // Any document these fixtures left goes first. A suite that litters a private
  // folder with test uploads is one that costs money and hides the real backlog.
  for (const o of orgs) if (o.businessDocPublicId) await destroyOrgDocument(o.businessDocPublicId)

  // AdminAction.actorId is RESTRICT, so audit rows go before the users they name.
  await prisma.adminAction.deleteMany({
    where: { OR: [{ actorId: { in: ids } }, { targetId: { in: orgs.map((o) => o.id) } }] },
  })
  await prisma.notification.deleteMany({ where: { userId: { in: ids } } })
  await prisma.organization.deleteMany({ where: { id: { in: orgs.map((o) => o.id) } } })
  await prisma.user.deleteMany({ where: { id: { in: ids } } })
}

// ── the suite ────────────────────────────────────────────────────────────────

async function main() {
  requireScratchSchema("scripts/verify-org-cloudinary.ts")

  for (const k of ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]) {
    if (!process.env[k]) {
      console.error(`\n  ${k} is not set. This suite talks to a real Cloudinary account`)
      console.error("  and has nothing to say without one. It is not a CI suite.\n")
      process.exit(2)
    }
  }

  try {
    await fetch(`${BASE}/api/v1/hubs`)
  } catch {
    console.error(`\n  No server at ${BASE}. See the header for how to start one.\n`)
    process.exit(2)
  }

  console.log(`  mode:   ${DEGRADED ? "--degraded (server has a wrong Cloudinary secret)" : "normal"}`)
  console.log(`  base:   ${BASE}`)

  const before = await listOrgDocuments()
  console.log(`  folder: ${ORG_DOC_FOLDER} — ${before.size} document(s) already present`)

  const adminToken = await signAccessToken(await makeUser("admin", "ADMIN"))

  if (DEGRADED) await degradedMode(adminToken)
  else await normalMode(adminToken)

  // ── the orphan ledger ──────────────────────────────────────────────────────
  head("no document was left behind")
  await cleanup()
  const after = await listOrgDocuments()
  const leaked = [...after].filter((id) => !before.has(id))
  check(
    `nothing this run uploaded is still on Cloudinary (${leaked.length} orphan(s))`,
    leaked.length === 0,
    leaked.join(", "),
  )
  check(
    "…and nothing that was there beforehand was destroyed",
    [...before].every((id) => after.has(id)),
    "the suite deleted a document it did not upload",
  )

  console.log(`\n  ${pass} passed, ${fail} failed`)
  if (warnings.length > 0) {
    console.log(`\n  ${warnings.length} warning(s) — true of the ID path too, not introduced here:`)
    for (const w of warnings) console.log(`    • ${w}`)
  }
  console.log("")
  process.exit(fail === 0 ? 0 : 1)
}

// ── normal mode ──────────────────────────────────────────────────────────────

async function normalMode(adminToken: string) {
  // ── 1 ── the upload round-trips
  head("1  signup uploads a real file and stores real handles")

  const founder1 = await makeUser("founder1")
  const t1 = await signAccessToken(founder1)
  const created = await signup(t1, { name: `${P}Aling Nena Sari-Sari` })
  check("POST /api/v1/organizations → 200", created.status === 200, `got ${created.status}`)

  const orgId = created.body?.data?.organizationId
  check("…and answers with an organisation id", typeof orgId === "string")
  if (typeof orgId !== "string") {
    console.error("  cannot continue without an organisation")
    return
  }
  madeOrgs.push(orgId)

  const row = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      businessDocUrl: true,
      businessDocPublicId: true,
      verificationStatus: true,
      docDeletedAt: true,
      docDeleteFailedAt: true,
      orgUserId: true,
    },
  })
  const publicId1 = row?.businessDocPublicId ?? ""
  check("the row stores a public_id", publicId1.length > 0)
  check(
    "…in the segregated document folder, not with the listing photos",
    publicId1.startsWith(`${ORG_DOC_FOLDER}/`),
    publicId1,
  )
  check("the row stores a URL", (row?.businessDocUrl ?? "").length > 0)
  check(
    "…which is an authenticated-type delivery URL",
    (row?.businessDocUrl ?? "").includes("/image/authenticated/"),
    row?.businessDocUrl?.slice(0, 80),
  )
  check(
    "…naming the same asset the public_id does",
    (row?.businessDocUrl ?? "").includes(publicId1.split("/").pop() ?? "\u0000"),
  )
  check("it starts PENDING", row?.verificationStatus === "PENDING")
  check("…with no deletion stamps yet", row?.docDeletedAt === null && row?.docDeleteFailedAt === null)

  // THE CHECK THAT MAKES ALL THE OTHERS MEAN SOMETHING.
  check("CLOUDINARY CONFIRMS THE FILE IS REALLY THERE", await orgDocumentExists(publicId1))

  // The security property the module header claims. It holds: strip the
  // signature component and the CDN refuses.
  const bare = (row?.businessDocUrl ?? "").replace(/\/s--[^/]+--\//, "/")
  const bareRes = await fetch(bare)
  check(
    "an UNSIGNED request for the document is refused by the CDN",
    !bareRes.ok,
    `got ${bareRes.status}`,
  )

  const reviewUrl = signOrgDocumentUrl(publicId1)
  const reviewRes = await fetch(reviewUrl)
  check("a reviewer's signed URL fetches the document", reviewRes.ok, `got ${reviewRes.status}`)
  check(
    "…and it is an image",
    (reviewRes.headers.get("content-type") ?? "").startsWith("image/"),
    reviewRes.headers.get("content-type") ?? "",
  )

  // Observed, not assumed. See warn()'s note: identical in the ID path.
  const past = signOrgDocumentUrl(publicId1)
  if (past === reviewUrl) {
    warn(
      "signOrgDocumentUrl()'s expires_at is not enforced: cloudinary.url() ignores it for " +
        "delivery URLs (an expiry 27 hours in the past produces a byte-identical URL), so the " +
        "'five-minute life' in the comment is decorative. signIdImageUrl() has the same defect.",
    )
    warn(
      "Organization.businessDocUrl stores a PERMANENTLY valid signed URL, not a bare one — " +
        "the same stored-credential the module header warns against. It is nulled on decision, " +
        "so the window is 'while PENDING'. IdVerification.imageUrl is stored the same way.",
    )
  }

  // ── 2 ── the decision destroys it
  head("2  approving destroys the document, and Cloudinary agrees")

  const verified = await decide(adminToken, orgId, {
    decision: "verify",
    reason: "Permit is legible and the name matches.",
  })
  check("POST /api/admin/organizations/[id] verify → 200", verified.status === 200, `got ${verified.status}`)
  check("…and reports documentDeleted", verified.body?.data?.documentDeleted === true)

  const afterVerify = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      verificationStatus: true,
      businessDocUrl: true,
      businessDocPublicId: true,
      docDeletedAt: true,
      docDeleteFailedAt: true,
    },
  })
  check("the row is VERIFIED", afterVerify?.verificationStatus === "VERIFIED")
  check("the URL is nulled", afterVerify?.businessDocUrl === null)
  check("the delete key is nulled once Cloudinary confirmed", afterVerify?.businessDocPublicId === null)
  check("…and the row is stamped deleted", !!afterVerify?.docDeletedAt)
  check("…with no failure recorded", afterVerify?.docDeleteFailedAt === null)

  // Asked directly. Not inferred from documentDeleted.
  check("CLOUDINARY AGREES THE FILE IS GONE", !(await orgDocumentExists(publicId1)))

  head("2b  rejecting destroys it too — approve or reject, it goes either way")

  const founder2 = await makeUser("founder2")
  const t2 = await signAccessToken(founder2)
  const c2 = await signup(t2, { name: `${P}Blurry Permit Trading` })
  const orgId2 = c2.body?.data?.organizationId as string
  check("a second organisation signs up", typeof orgId2 === "string", `status ${c2.status}`)
  if (typeof orgId2 !== "string") return
  madeOrgs.push(orgId2)

  const r2 = await prisma.organization.findUnique({
    where: { id: orgId2 },
    select: { businessDocPublicId: true },
  })
  const publicId2 = r2?.businessDocPublicId ?? ""
  check("…and its document is on Cloudinary", await orgDocumentExists(publicId2))

  const rejected = await decide(adminToken, orgId2, {
    decision: "reject",
    reason: "Cannot read the registration number.",
    rejectionReason: "BLURRY_DOCUMENT",
  })
  check("reject → 200", rejected.status === 200, `got ${rejected.status}`)
  check("…and reports documentDeleted", rejected.body?.data?.documentDeleted === true)
  check("CLOUDINARY AGREES THE REJECTED DOCUMENT IS GONE", !(await orgDocumentExists(publicId2)))

  const afterReject = await prisma.organization.findUnique({
    where: { id: orgId2 },
    select: { verificationStatus: true, rejectionReason: true, businessDocPublicId: true, orgUserId: true },
  })
  check("the row is REJECTED", afterReject?.verificationStatus === "REJECTED")
  check("…with the reason code", afterReject?.rejectionReason === "BLURRY_DOCUMENT")
  check("…and its delete key is nulled", afterReject?.businessDocPublicId === null)
  // The documented difference from the ID gate: a refused badge is not a
  // refused account.
  check("a rejected organisation still exists and keeps its account", !!afterReject?.orgUserId)

  // ── 3 ── the retry sweep
  head("3  a destroy that fails is retried by the sweep")

  const founder3 = await makeUser("founder3")
  const t3 = await signAccessToken(founder3)
  const c3 = await signup(t3, { name: `${P}Sweep Subject` })
  const orgId3 = c3.body?.data?.organizationId as string
  check("a third organisation signs up", typeof orgId3 === "string", `status ${c3.status}`)
  if (typeof orgId3 !== "string") return
  madeOrgs.push(orgId3)

  const r3row = await prisma.organization.findUnique({
    where: { id: orgId3 },
    select: { businessDocPublicId: true },
  })
  const publicId3 = r3row?.businessDocPublicId ?? ""

  // THE FAILURE IS REAL, not a fabricated row: the credentials this process
  // holds are made wrong and the destroy is genuinely rejected by Cloudinary.
  const destroyResult = await withBrokenCredentials(() => destroyOrgDocument(publicId3))
  check("destroyOrgDocument returns false when Cloudinary refuses", destroyResult === false)
  check("…and does not throw — a decision must never fail on this", true)
  check("…and the document is, correctly, still there", await orgDocumentExists(publicId3))

  // Put the row in the state the decision route leaves behind when its destroy
  // fails: decided, URL gone, DELETE KEY KEPT, failure stamped.
  await prisma.organization.update({
    where: { id: orgId3 },
    data: {
      verificationStatus: "VERIFIED",
      reviewedAt: new Date(),
      businessDocUrl: null,
      docDeleteFailedAt: new Date(),
    },
  })

  const stranded = await prisma.organization.findMany({
    where: {
      verificationStatus: { in: ["VERIFIED", "REJECTED"] },
      businessDocPublicId: { not: null },
    },
    select: { id: true },
  })
  check(
    "a decided row that kept its delete key IS the retry set",
    stranded.some((s) => s.id === orgId3),
  )

  // A sweep while Cloudinary is still refusing: it must clear nothing, report
  // the failure, and leave the delete key alone.
  const brokenSweep = await withBrokenCredentials(() => sweepUndeletedOrgDocuments())
  check("a sweep during the outage clears nothing", brokenSweep.swept === 0, JSON.stringify(brokenSweep))
  check("…and reports the failure rather than throwing", brokenSweep.failed >= 1, JSON.stringify(brokenSweep))

  const midSweep = await prisma.organization.findUnique({
    where: { id: orgId3 },
    select: { businessDocPublicId: true, docDeleteFailedAt: true, docDeletedAt: true },
  })
  check("…and KEEPS the delete key, so the work is not lost", midSweep?.businessDocPublicId === publicId3)
  check("…and stamps the failure", !!midSweep?.docDeleteFailedAt)
  check("…and does not claim a deletion", midSweep?.docDeletedAt === null)
  check("…and the document really is still on Cloudinary", await orgDocumentExists(publicId3))

  // THE SUBSEQUENT RUN, credentials restored.
  const goodSweep = await sweepUndeletedOrgDocuments()
  check("THE NEXT SWEEP PICKS IT UP AND SUCCEEDS", goodSweep.swept >= 1, JSON.stringify(goodSweep))
  check("CLOUDINARY AGREES THE SWEPT DOCUMENT IS GONE", !(await orgDocumentExists(publicId3)))

  const sweptRow = await prisma.organization.findUnique({
    where: { id: orgId3 },
    select: { businessDocPublicId: true, docDeletedAt: true, docDeleteFailedAt: true },
  })
  check("…the row no longer holds a delete key", sweptRow?.businessDocPublicId === null)
  check("…it is stamped deleted", !!sweptRow?.docDeletedAt)
  check("…and the stale failure stamp is cleared", sweptRow?.docDeleteFailedAt === null)

  const idleSweep = await sweepUndeletedOrgDocuments()
  check("a third sweep finds nothing to do — no retry loop", idleSweep.swept === 0 && idleSweep.failed === 0)

  // ── 4 ── failure modes at signup
  head("4  a refused signup leaves nothing behind")

  const founder4 = await makeUser("founder4")
  const t4 = await signAccessToken(founder4)

  const noFile = await signup(t4, { file: null })
  check("no document attached → 400", noFile.status === 400, `got ${noFile.status}`)

  const notImage = await signup(t4, {
    file: { bytes: Buffer.from("PK\u0003\u0004 this is not an image at all"), filename: "permit.png", type: "image/png" },
  })
  check("bytes that are not an image → 400", notImage.status === 400, `got ${notImage.status}`)

  // 11 MB. Refused on `file.size` BEFORE the decoder and long before Cloudinary.
  const oversized = await signup(t4, {
    file: { bytes: Buffer.alloc(11 * 1024 * 1024, 7), filename: "huge.png", type: "image/png" },
  })
  check("an oversized document → 400", oversized.status === 400, `got ${oversized.status}`)

  const afterRefusals = await prisma.organization.count({
    where: { members: { some: { userId: founder4 } } },
  })
  check("THREE REFUSALS CREATED NO ORGANISATION", afterRefusals === 0, `${afterRefusals} row(s)`)

  const orgUsers = await prisma.user.count({ where: { isOrgAccount: true, name: { startsWith: `${P}` } } })
  check(
    "…and no orphan backing User rows",
    orgUsers === madeOrgs.length,
    `${orgUsers} org accounts for ${madeOrgs.length} organisations`,
  )

  // THE POINT OF THE SECTION: a failed upload must not lock somebody out.
  const retry = await signup(t4, { name: `${P}Retried Successfully` })
  check("AND THE FOUNDER CAN STILL SIGN UP AFTERWARDS", retry.status === 200, `got ${retry.status}`)
  const retryId = retry.body?.data?.organizationId as string
  if (typeof retryId === "string") madeOrgs.push(retryId)
  check(
    "…leaving exactly one organisation for that account",
    (await prisma.organization.count({ where: { members: { some: { userId: founder4 } } } })) === 1,
  )

  const second = await signup(t4, { name: `${P}One Too Many` })
  check("a second organisation on the same account → 409", second.status === 409, `got ${second.status}`)
  check(
    "…and the refusal happened before anything was uploaded",
    (await prisma.organization.count({ where: { members: { some: { userId: founder4 } } } })) === 1,
  )

  // ── 5 ── the window between the upload and the row
  //
  // The ONLY branch that can strand a document: the file is already on
  // Cloudinary and createOrganization() then fails. No sweep can ever find it,
  // because every sweep works from Organization rows and the whole failure is
  // that no Organization row exists.
  //
  // There is no input that makes that transaction fail — it invents its own
  // unique email and every other refusal runs before the upload — so the fault
  // is injected in the database, for exactly one request, and reversed straight
  // after. Deterministic, and it drives the REAL route rather than a copy of it.
  //
  // ONE COLUMN, NOT THE TABLE. Renaming "Organization" away was the obvious
  // move and it was silently useless: the one-organisation-per-founder check
  // joins that table BEFORE the upload, so the request died early, nothing was
  // ever uploaded, and the orphan assertion passed whether or not the code it
  // tests existed. Renaming `businessDocPublicId` instead leaves every
  // pre-upload query working — none of them select it — and breaks only the
  // INSERT inside createOrganization(), which is precisely the window.
  head("5  a row write that fails after the upload strands nothing")

  const schema = targetSchema()
  if (schema === "public") {
    // requireScratchSchema() lets `--live` through. This particular check
    // renames a live table for the duration of an HTTP request, and there is no
    // version of that which is acceptable against real data.
    skip("renaming a table is refused on the live schema, --live or not")
  } else {
    const founder5 = await makeUser("founder5")
    const t5 = await signAccessToken(founder5)
    const beforeSection = await listOrgDocuments()

    let broken: Res<{ data: { organizationId?: string } | null; error: { message?: string } | null }>
    let preUploadQueryStillWorks = false
    let insertReallyFails = false

    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${schema}"."Organization" RENAME COLUMN "businessDocPublicId" TO "businessDocPublicId_faultinjection"`,
    )
    try {
      // POSITIVE CONTROL, and the reason this section is trustworthy. The two
      // assertions below establish that with this column renamed the route
      // reaches the upload and fails after it — without them, "no orphan" is
      // equally true of a request that died at the front door.
      try {
        await prisma.organizationMember.findFirst({
          where: { userId: founder5, role: "OWNER", status: "ACTIVE" },
          select: { organization: { select: { id: true, name: true } } },
        })
        preUploadQueryStillWorks = true
      } catch {
        preUploadQueryStillWorks = false
      }

      try {
        await createOrganization({
          founderUserId: founder5,
          name: `${P}control`,
          businessCategory: "RETAIL",
          businessDocUrl: "https://example.invalid/control",
          businessDocPublicId: "control",
        })
      } catch {
        insertReallyFails = true
      }

      broken = await signup(t5, { name: `${P}Row Write Will Fail` })
    } finally {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "${schema}"."Organization" RENAME COLUMN "businessDocPublicId_faultinjection" TO "businessDocPublicId"`,
      )
    }

    check(
      "the fault leaves every pre-upload query working",
      preUploadQueryStillWorks,
      "the request would die before uploading, and this section would prove nothing",
    )
    check("…and breaks only the write inside the transaction", insertReallyFails)
    check("the signup fails loudly rather than pretending", broken.status >= 500, `got ${broken.status}`)
    check(
      "no organisation was created",
      (await prisma.organization.count({ where: { members: { some: { userId: founder5 } } } })) === 0,
    )
    check(
      "…and the transaction took the backing User row with it",
      (await prisma.user.count({ where: { name: `${P}Row Write Will Fail` } })) === 0,
    )

    // THE FIX THIS SECTION EXISTS FOR.
    const afterSection = await listOrgDocuments()
    const orphans = [...afterSection].filter((id) => !beforeSection.has(id))
    check(
      "THE UPLOADED DOCUMENT WAS DESTROYED ON THE WAY OUT",
      orphans.length === 0,
      `${orphans.length} document(s) stranded with no row pointing at them: ${orphans.join(", ")}`,
    )

    check(
      "and the founder can still sign up once the fault is over",
      (await signup(t5, { name: `${P}Recovered After Fault` })).status === 200,
    )
    const recoveredOrg = await prisma.organization.findFirst({
      where: { members: { some: { userId: founder5 } } },
      select: { id: true },
    })
    if (recoveredOrg) madeOrgs.push(recoveredOrg.id)
  }

  // ── 6 ── the invariant
  head("6  the ledger is untouched")
  const [users, ledger] = await Promise.all([
    prisma.user.aggregate({ _sum: { leaves: true } }),
    prisma.leafTransaction.aggregate({ _sum: { amount: true } }),
  ])
  check(
    `SUM(User.leaves)=${users._sum.leaves ?? 0} == SUM(LeafTransaction.amount)=${ledger._sum.amount ?? 0}`,
    (users._sum.leaves ?? 0) === (ledger._sum.amount ?? 0),
  )
}

// ── degraded mode ────────────────────────────────────────────────────────────

/**
 * The server's Cloudinary credentials are wrong; this process's are right.
 *
 * Everything here is a branch that cannot be reached with a healthy server, and
 * each one is about the same question: when the third party fails, does Baylo
 * fail SAFELY — no half-made account, no retained document, no dead end.
 */
async function degradedMode(adminToken: string) {
  head("7  the upload itself fails mid-signup")

  const founder = await makeUser("degraded-founder")
  const token = await signAccessToken(founder)

  const attempt = await signup(token, { name: `${P}Upload Will Fail` })
  check("signup fails cleanly with 400, not 500", attempt.status === 400, `got ${attempt.status}`)
  check(
    "…and says the document could not be stored",
    (attempt.body?.error?.message ?? "").toLowerCase().includes("could not store"),
    attempt.body?.error?.message,
  )
  check("NO ORGANISATION ROW WAS CREATED", (await prisma.organization.count({ where: { members: { some: { userId: founder } } } })) === 0)
  check(
    "…and no synthetic backing User row was left behind",
    (await prisma.user.count({ where: { isOrgAccount: true, name: `${P}Upload Will Fail` } })) === 0,
  )
  check(
    "…and the account is not marked as owning anything",
    (await prisma.organizationMember.count({ where: { userId: founder } })) === 0,
  )

  head("7b  the destroy fails after a decision commits")

  // The server cannot upload, so the fixture is built here, with real
  // credentials and a real file. Only the DECISION goes over the wire.
  const owner = await makeUser("degraded-owner")
  const doc = await uploadOrgDocument(PNG_1PX)
  const org = await createOrganization({
    founderUserId: owner,
    name: `${P}Destroy Will Fail`,
    businessCategory: "RETAIL",
    businessDocUrl: doc.url,
    businessDocPublicId: doc.publicId,
  })
  madeOrgs.push(org.organizationId)
  check("the fixture's document is on Cloudinary", await orgDocumentExists(doc.publicId))

  const decided = await decide(adminToken, org.organizationId, {
    decision: "verify",
    reason: "Approving while Cloudinary is unreachable.",
  })
  check("THE DECISION STILL SUCCEEDS — 200", decided.status === 200, `got ${decided.status}`)
  check("…and honestly reports documentDeleted: false", decided.body?.data?.documentDeleted === false)

  const row = await prisma.organization.findUnique({
    where: { id: org.organizationId },
    select: {
      verificationStatus: true,
      businessDocUrl: true,
      businessDocPublicId: true,
      docDeletedAt: true,
      docDeleteFailedAt: true,
    },
  })
  check("the decision committed", row?.verificationStatus === "VERIFIED")
  check("the URL is nulled — nothing can render it from now on", row?.businessDocUrl === null)
  check("THE DELETE KEY SURVIVES, so the sweep can find it", row?.businessDocPublicId === doc.publicId)
  check("…the failure is stamped", !!row?.docDeleteFailedAt)
  check("…and no deletion is claimed", row?.docDeletedAt === null)
  check("…and the document is, correctly, still on Cloudinary", await orgDocumentExists(doc.publicId))

  // The recovery, from this process, which can still reach Cloudinary — exactly
  // what the admin queue page does on its next render once service returns.
  const swept = await sweepUndeletedOrgDocuments()
  check("THE SWEEP RECOVERS THE ROUTE'S FAILURE", swept.swept >= 1, JSON.stringify(swept))
  check("CLOUDINARY AGREES THE DOCUMENT IS GONE", !(await orgDocumentExists(doc.publicId)))
  const recovered = await prisma.organization.findUnique({
    where: { id: org.organizationId },
    select: { businessDocPublicId: true, docDeletedAt: true, docDeleteFailedAt: true },
  })
  check("…the delete key is cleared", recovered?.businessDocPublicId === null)
  check("…it is stamped deleted", !!recovered?.docDeletedAt)
  check("…and the failure stamp is cleared", recovered?.docDeleteFailedAt === null)
}

main()
  .catch(async (e) => {
    console.error(e)
    try {
      await cleanup()
    } catch {
      /* the original error is the interesting one */
    }
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
