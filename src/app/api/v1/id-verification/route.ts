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
  publicIdVerification,
  toDbIdType,
  type IdTypeWire,
} from "@/lib/id-verification"
import { destroyIdImage, uploadIdImage } from "@/lib/id-verification-image"

export const dynamic = "force-dynamic"

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

  // ── Upload, then write the row ─────────────────────────────────────────────

  let image: { url: string; publicId: string }
  try {
    image = await uploadIdImage(sanitized.buffer)
  } catch (err) {
    console.error(
      "[id-verification] upload failed:",
      err instanceof Error ? err.message : "unknown error",
    )
    return invalid("We could not store that photo. Try again in a moment.")
  }

  const attemptCount = state.attemptsUsed + 1
  const autoApprove = devAutoApprove()
  const now = new Date()

  let created: { id: string }
  try {
    created = await prisma.idVerification.create({
      data: {
        userId,
        idType: toDbIdType(idType),
        idNumberHash,
        // The claim, written in the SAME statement as the status. Never on its
        // own — see the note on the column.
        claimKey: idNumberHash,
        status: autoApprove ? "APPROVED" : "PENDING",
        attemptCount,
        submittedAt: now,
        // On the auto-approve path the row is decided the instant it is
        // created, so it never carries a URL a reviewer could open. The
        // publicId stays, because the image still has to be destroyed below.
        imageUrl: autoApprove ? null : image.url,
        imagePublicId: image.publicId,
        ...(autoApprove ? { reviewedById: userId, reviewedAt: now } : {}),
      },
      select: { id: true },
    })
  } catch (err) {
    // The unique index on claimKey is what actually enforces one-ID-one-account;
    // the pre-check above is a courtesy. Losing here means another account
    // claimed the same number in the milliseconds since that check.
    await destroyIdImage(image.publicId)
    const code = (err as { code?: string })?.code
    if (code === "P2002") {
      return conflict(
        "That ID number is already registered. Each government ID can verify one account.",
        { rule: "ID_ALREADY_REGISTERED" },
      )
    }
    throw err
  }

  if (autoApprove) {
    // The development escape hatch, and it leaves the same trail a real
    // decision does. The audit row names the submitter as the actor and says
    // what it was, so a row approved this way can never be mistaken for one a
    // moderator looked at. If this ever appears in a production audit log, the
    // log is telling you the env var reached production.
    await writeAudit(prisma, {
      actorId: userId,
      action: "ID_VERIFICATION_APPROVED",
      targetType: "ID_VERIFICATION",
      targetId: created.id,
      reason: "Development auto-approval (ID_VERIFICATION_DEV_AUTO_APPROVE=1). Nobody reviewed this ID.",
      detail: { devAutoApprove: true, idType, attemptCount },
    })
    // Destroyed here for the same reason a real decision destroys it: the row
    // is decided, so the image has no remaining purpose.
    if (await destroyIdImage(image.publicId)) {
      await prisma.idVerification.update({
        where: { id: created.id },
        data: { imagePublicId: null, imageDeletedAt: new Date() },
      })
    } else {
      await prisma.idVerification.update({
        where: { id: created.id },
        data: { imageDeleteFailedAt: new Date() },
      })
    }
  }

  const after = await loadIdVerificationState(userId)
  return ok(
    {
      submissionId: created.id,
      ...publicIdVerification(after),
    },
    { autoApproved: autoApprove },
  )
}
