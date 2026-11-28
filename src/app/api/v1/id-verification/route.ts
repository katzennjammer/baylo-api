import { NextRequest } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { enforceRateLimit } from "@/lib/rate-limit-config"
import { sanitizeImage } from "@/lib/image-sanitize"
import { writeAudit } from "@/lib/moderation"
import { ok, unauthenticated, invalid, conflict, forbidden } from "@/lib/v1/envelope"
import {
  ID_TYPES,
  ID_TYPE_LABEL,
  MAX_ID_NUMBER_LENGTH,
  MAX_ID_SUBMISSIONS,
  MIN_ID_NUMBER_LENGTH,
  REJECTION_LABEL,
  REJECTION_REASONS,
  devAutoApprove,
  hashIdNumber,
  loadIdVerificationState,
  normaliseIdNumber,
  nearIdNumberHashes,
  REJECTION_FIX,
  toWireRejectionReason,
  type RejectionReasonWire,
  publicIdVerification,
  toDbIdType,
  type IdTypeWire,
} from "@/lib/id-verification"
import { destroyIdImage, uploadIdImage } from "@/lib/id-verification-image"
import { autoCheckEnabled, runIdAutoCheck } from "@/lib/id-auto-verify"
import type { AutoCheckResult } from "@/lib/id-auto-check"

export const dynamic = "force-dynamic"
// The automatic ID check reads the photo with OCR (about 1–3 s, longer on a
// cold start); its own limit is 30 s.
export const maxDuration = 60

/**
 * /api/v1/id-verification — submit a government ID, and read where yours stands.
 *
 * The user-facing half of the gate described in @/lib/id-verification. The
 * admin half is /api/admin/id-verification/[id].
 *
 * MULTIPART, NOT JSON, AND NOT A TWO-STEP UPLOAD. Every other image in this app
 * goes through POST /api/upload first and arrives here as a URL, and that shape
 * is wrong for this one in a way that matters: /api/upload writes PUBLIC assets
 * to the `baylo` folder, so an ID routed through it would be world-readable at
 * a guessable URL for the whole time it sat in the review queue — and would
 * stay readable if the submission was then abandoned and no row was ever
 * created to point at it. The file arrives in this request, goes straight to an
 * `authenticated`-type Cloudinary asset, and its public_id is written to the
 * row in the same handler. There is no window in which an uploaded ID exists
 * with nothing tracking it.
 *
 * The UPLOAD LIMITS are still the shared ones — enforceRateLimit("upload"), the
 * 10 MB ceiling, and sanitizeImage() for the metadata strip. Same budget, same
 * decoder, different destination.
 */

const MAX_IMAGE_BYTES = 10 * 1024 * 1024

// ── GET: where do I stand? ───────────────────────────────────────────────────

/**
 * The state, plus everything the submission screen needs to render itself.
 *
 * The vocabulary travels WITH the state rather than being compiled into the
 * client. A shipped mobile build that hard-codes the seven ID types is a build
 * that has to be replaced through the Play Store the day an eighth is accepted
 * or a seventh is withdrawn; served here, that is a server deploy.
 */
export async function GET() {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()

  const state = await loadIdVerificationState(session.user.id)

  return ok({
    ...publicIdVerification(state),
    idTypes: ID_TYPES.map((t) => ({ value: t, label: ID_TYPE_LABEL[t] })),
    rejectionReasons: REJECTION_REASONS.map((r) => ({ value: r, label: REJECTION_LABEL[r] })),
    limits: {
      maxAttempts: MAX_ID_SUBMISSIONS,
      maxImageBytes: MAX_IMAGE_BYTES,
      minIdNumberLength: MIN_ID_NUMBER_LENGTH,
      maxIdNumberLength: MAX_ID_NUMBER_LENGTH,
    },
  })
}

// ── POST: submit ─────────────────────────────────────────────────────────────

/**
 * POST /api/v1/id-verification — one submission.
 *
 * THE ORDER OF THE CHECKS IS THE DESIGN. Everything that can refuse the request
 * runs BEFORE the image is uploaded, so a refused submission never puts a
 * photograph of a government ID onto a third party's servers:
 *
 *   401  no session
 *   429  the shared upload budget
 *   409  already verified — nothing to do
 *   409  a submission is already pending
 *   403  three attempts used                      (the lifetime cap)
 *   400  bad idType / ID number / missing file / too large / not an image
 *   409  that ID number is live on another account (the uniqueness rule)
 *   ---- only now is anything uploaded ----
 *   409  lost the race for the ID number          (the unique index)
 *
 * The last one is the same refusal as the seventh, reached a different way. The
 * pre-check is a courtesy that gives a good error without an upload; the unique
 * index is what actually enforces it, because two accounts can pass the
 * pre-check in the same millisecond and only one row can win. An upload made in
 * a lost race is destroyed before the response is written — the one place in
 * this file where an image exists without a row, and it lives for milliseconds.
 */
export async function POST(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const userId = session.user.id

  // Before formData(). The body is buffered into memory by that call, so a
  // limit applied afterwards has already paid the cost it was meant to avoid —
  // the same note /api/upload carries, and the same shared budget.
  // Returned verbatim, in the limiter's own bare shape rather than the v1
  // envelope — the same thing /api/v1/blocks, /reports, /like and /comments do.
  // The Retry-After header is the part clients actually use, and it survives.
  const limited = enforceRateLimit("upload", userId)
  if (limited) return limited

  const state = await loadIdVerificationState(userId)

  if (state.verified) {
    return conflict(
      state.grandfathered
        ? "This account was verified when ID checks launched. There is nothing to submit."
        : "Your ID is already approved.",
      { idVerification: publicIdVerification(state) },
    )
  }

  if (state.status === "pending") {
    return conflict(
      "You already have an ID under review. We usually get to it within a day.",
      { idVerification: publicIdVerification(state) },
    )
  }

  // The lifetime cap. A COUNT(*) over durable rows, not the in-memory limiter:
  // three attempts means three, across restarts and across weeks.
  if (state.attemptsRemaining <= 0) {
    return forbidden(
      `You have used all ${MAX_ID_SUBMISSIONS} ID submissions on this account. Contact support to continue.`,
      { rule: "ID_VERIFICATION_ATTEMPTS_EXHAUSTED", idVerification: publicIdVerification(state) },
    )
  }

  // ── The body ───────────────────────────────────────────────────────────────

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return invalid("Send this as multipart/form-data with idType, idNumber and file.")
  }

  const idTypeRaw = String(form.get("idType") ?? "")
  if (!(ID_TYPES as readonly string[]).includes(idTypeRaw)) {
    return invalid(`"${idTypeRaw}" is not an ID type we accept.`)
  }
  const idType = idTypeRaw as IdTypeWire

  const idNumberRaw = String(form.get("idNumber") ?? "")
  const normalised = normaliseIdNumber(idNumberRaw)
  if (normalised.length < MIN_ID_NUMBER_LENGTH || normalised.length > MAX_ID_NUMBER_LENGTH) {
    return invalid(
      `Enter the number printed on the ID — between ${MIN_ID_NUMBER_LENGTH} and ${MAX_ID_NUMBER_LENGTH} letters and digits.`,
    )
  }

  const file = form.get("file")
  if (!(file instanceof File)) return invalid("Attach a photo of the ID.")
  if (file.size > MAX_IMAGE_BYTES) return invalid("The photo must be under 10 MB.")

  // The client's declared MIME type is not consulted. sanitizeImage() decodes
  // the actual bytes — that is the content check — and re-encodes them WITHOUT
  // metadata. On this route that strip is doing more work than usual: a photo
  // of an ID is taken at home, and a phone camera writes the coordinates of
  // wherever it was taken into the file.
  let sanitized: { buffer: Buffer }
  try {
    sanitized = await sanitizeImage(Buffer.from(await file.arrayBuffer()))
  } catch {
    return invalid("That file is not an image we can read. Send a JPEG or PNG photo.")
  }

  // ── The uniqueness rule, checked before anything is uploaded ───────────────
  //
  // THE PLAINTEXT NUMBER STOPS HERE. It exists in the request body and in this
  // variable, and from this line on only the digest travels: not into the row,
  // not into the response, not into a log line.
  const idNumberHash = hashIdNumber(idNumberRaw)

  const claimed = await prisma.idVerification.findUnique({
    where: { claimKey: idNumberHash },
    select: { userId: true, status: true },
  })
  if (claimed) {
    // Deliberately the SAME message whether the live claim belongs to a
    // stranger or to this user's own earlier row. Saying "that ID is already
    // registered to another account" would turn this endpoint into an oracle
    // that answers "is this ID number on Baylo?" for any number somebody cares
    // to type — which is exactly the lookup a person holding a stolen wallet
    // would want.
    return conflict(
      "That ID number is already registered. Each government ID can verify one account.",
      { rule: "ID_ALREADY_REGISTERED" },
    )
  }

  // ── The automatic check (29 Nov 2026) ──────────────────────────────────────
  //
  // The system decides, not an admin (@/lib/id-auto-check):
  //   approved by the check                   → APPROVED, now
  //   refused, with tries left                → REJECTED with the reason, now
  //                                             (the user retakes or fixes it)
  //   not approved on the LAST try, the check
  //   failed to run, or ID_AUTO_CHECK=0       → PENDING, for an admin
  // The last-try rule is the agreed last resort: a misread must never lock a
  // real person out, so their final attempt is seen by a person.
  //
  // A decided submission's photo is never uploaded at all: it is read here, in
  // memory, and dropped. Only a PENDING one is stored for the admin to see.

  const attemptCount = state.attemptsUsed + 1
  const lastAttempt = attemptCount >= MAX_ID_SUBMISSIONS
  const devApprove = devAutoApprove()

  let auto: AutoCheckResult | null = null
  let autoError: string | null = null
  if (!devApprove && autoCheckEnabled()) {
    const account = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, dateOfBirth: true } })
    const run = await runIdAutoCheck(sanitized.buffer, {
      selectedType: toDbIdType(idType),
      typedNumber: idNumberRaw,
      accountName: account?.name ?? "",
      accountDob: account?.dateOfBirth ?? null,
    })
    if (run.ok) auto = run.result
    else autoError = run.error
  }

  // A number accepted with one character read differently could be a card
  // already registered with one digit typed wrong (see nearIdNumberHashes).
  if (auto?.decision === "APPROVED" && (auto.detail.numberEdits ?? 0) > 0) {
    const near = await prisma.idVerification.findFirst({
      where: { claimKey: { in: nearIdNumberHashes(idNumberRaw) } },
      select: { id: true },
    })
    if (near) {
      return conflict(
        "That ID number is already registered. Each government ID can verify one account.",
        { rule: "ID_ALREADY_REGISTERED" },
      )
    }
  }

  const status: "APPROVED" | "REJECTED" | "PENDING" = devApprove || auto?.decision === "APPROVED"
    ? "APPROVED"
    : auto && !lastAttempt
      ? "REJECTED"
      : "PENDING"
  const reason = status === "REJECTED" ? (auto?.reason ?? "BLURRY_PHOTO") : null
  const decided = status !== "PENDING"
  const now = new Date()

  // ── Upload (only for an admin), then write the row ─────────────────────────

  let image: { url: string; publicId: string } | null = null
  if (!decided) {
    try {
      image = await uploadIdImage(sanitized.buffer)
    } catch (err) {
      console.error(
        "[id-verification] upload failed:",
        err instanceof Error ? err.message : "unknown error",
      )
      return invalid("We could not store that photo. Try again in a moment.")
    }
  }

  let created: { id: string }
  try {
    created = await prisma.idVerification.create({
      data: {
        userId,
        idType: toDbIdType(idType),
        idNumberHash,
        // The claim, written in the SAME statement as the status. Never on its
        // own — see the note on the column. A refusal frees it at once, as an
        // admin's refusal does, so the same ID can be sent again.
        claimKey: status === "REJECTED" ? null : idNumberHash,
        status,
        rejectionReason: reason,
        attemptCount,
        submittedAt: now,
        imageUrl: image?.url ?? null,
        imagePublicId: image?.publicId ?? null,
        ...(decided ? { reviewedAt: now } : {}),
        ...(devApprove ? { reviewedById: userId } : {}),
        autoDecision: auto ? auto.decision : autoError ? "ERROR" : null,
        autoConfidence: auto?.confidence ?? null,
        autoChecks: auto
          ? { reason: auto.reason, checks: auto.checks, detail: auto.detail }
          : autoError
            ? { error: autoError.slice(0, 200) }
            : undefined,
        autoCheckedAt: auto || autoError ? now : null,
      },
      select: { id: true },
    })
  } catch (err) {
    // The unique index on claimKey is what actually enforces one-ID-one-account;
    // the pre-check above is a courtesy. Losing here means another account
    // claimed the same number in the milliseconds since that check.
    if (image) await destroyIdImage(image.publicId)
    const code = (err as { code?: string })?.code
    if (code === "P2002") {
      return conflict(
        "That ID number is already registered. Each government ID can verify one account.",
        { rule: "ID_ALREADY_REGISTERED" },
      )
    }
    throw err
  }

  if (decided) {
    // The same trail an admin's decision leaves: an audit row and a
    // notification, in one transaction. The audit's actor is the submitter
    // (there is no person behind the decision) and its reason says so, so a
    // system decision can never be mistaken for one a moderator made.
    const remaining = Math.max(0, MAX_ID_SUBMISSIONS - attemptCount)
    const wireReason = reason ? toWireRejectionReason(reason) : null
    await prisma.$transaction(async (tx) => {
      await writeAudit(tx, {
        actorId: userId,
        action: status === "APPROVED" ? "ID_VERIFICATION_APPROVED" : "ID_VERIFICATION_REJECTED",
        targetType: "ID_VERIFICATION",
        targetId: created.id,
        reason: devApprove
          ? "Development auto-approval (ID_VERIFICATION_DEV_AUTO_APPROVE=1). Nobody reviewed this ID."
          : `Decided by the automatic ID check (system), not by a person. ${status === "APPROVED" ? "Approved" : `Refused: ${REJECTION_LABEL[wireReason as RejectionReasonWire]}`}, confidence ${auto?.confidence ?? "n/a"}.`,
        detail: devApprove
          ? { devAutoApprove: true, idType, attemptCount }
          : { system: "id-auto-check", idType, attemptCount, decision: status, rejectionReason: wireReason, confidence: auto?.confidence, checks: auto?.checks },
      })
      await tx.notification.create({
        data: {
          userId,
          type: status === "APPROVED" ? "ID_VERIFICATION_APPROVED" : "ID_VERIFICATION_REJECTED",
          message: status === "APPROVED"
            ? "Your ID was approved. You can post items and propose deferred agreements now."
            : `${REJECTION_FIX[wireReason as RejectionReasonWire]} You have ${remaining} of ${MAX_ID_SUBMISSIONS} attempts left.`,
          link: "/dashboard",
          entityType: "id_verification",
          entityId: created.id,
        },
      })
    })
  }

  const after = await loadIdVerificationState(userId)
  return ok(
    {
      submissionId: created.id,
      ...publicIdVerification(after),
    },
    {
      autoApproved: status === "APPROVED",
      // Who decided: "system" (the automatic check), or "admin" (still
      // pending: last attempt, or the check could not run).
      decidedBy: decided ? "system" : "admin",
    },
  )
}
