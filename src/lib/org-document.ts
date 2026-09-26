import { v2 as cloudinary } from "cloudinary"
import prisma from "@/lib/prisma"

/**
 * The business document: where it goes, how a reviewer sees it, and how it
 * leaves.
 *
 * ── THE SAME RULES AS A GOVERNMENT ID, AND FOR THE SAME REASON ──────────────
 *
 * A DTI or SEC registration, or a barangay permit, carries a real person's
 * name and usually their home or business address. It is personal information
 * under RA 10173 in exactly the way an ID photo is, so it gets exactly the same
 * treatment @/lib/id-verification-image documents at length:
 *
 *   type: "authenticated"   an unsigned request 404s at the CDN, so a URL that
 *                           leaks into a screenshot or a log is already dead.
 *                           A "private folder" of `upload`-type assets is not
 *                           private — folders are naming, not access control.
 *   a signed review URL     minted per page load, five-minute life, never
 *                           stored. A stored signed URL is a stored credential.
 *   destroyed on decision   approve or reject, the document goes either way.
 *
 * ── WHY IT IS A SEPARATE MODULE AND NOT A PARAMETER ─────────────────────────
 *
 * It would be one function with a folder argument, and the folder is the thing
 * that must not be got wrong. ID_FOLDER is segregated from `baylo/` precisely
 * so a bulk operation on listing images cannot reach government IDs by
 * accident; a shared helper taking the folder as a parameter reintroduces that
 * by one bad call site. Two modules, two constants, no argument to pass
 * wrongly — and this one's sweep queries a different table, so the shared part
 * would have been the four lines of upload options anyway.
 */

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

/** Segregated from both `baylo/` and the ID folder. See the note above. */
export const ORG_DOC_FOLDER = "baylo-org-documents"

/** Five minutes, re-minted per page load. Same reasoning as SIGNED_URL_TTL_S. */
export const ORG_DOC_URL_TTL_S = 5 * 60

export interface UploadedOrgDocument {
  url: string
  publicId: string
}

/** Whatever the Cloudinary SDK threw, as a sentence worth logging. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  const message = (err as { message?: unknown } | null)?.message
  if (typeof message === "string" && message.length > 0) return message
  return "unknown error"
}

/**
 * Upload one sanitised business document.
 *
 * The buffer must ALREADY have been through sanitizeImage(). A permit
 * photographed at the shop carries the shop's GPS coordinates in EXIF, and
 * re-encoding is what drops them.
 */
export async function uploadOrgDocument(buffer: Buffer): Promise<UploadedOrgDocument> {
  return new Promise<UploadedOrgDocument>((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(
        {
          folder: ORG_DOC_FOLDER,
          resource_type: "image",
          // THE LINE THAT MAKES IT PRIVATE.
          type: "authenticated",
          image_metadata: false,
          // No derivatives. Each one would be a second copy of a document that
          // also needs destroying, with a public_id nothing here would know.
          eager: [],
          overwrite: false,
          unique_filename: true,
        },
        (error, result) => {
          if (error || !result) reject(error ?? new Error("Cloudinary returned no result"))
          else resolve({ url: result.secure_url, publicId: result.public_id })
        },
      )
      .end(buffer)
  })
}

/** A short-lived signed URL a reviewer can open. Never stored. */
export function signOrgDocumentUrl(publicId: string): string {
  return cloudinary.url(publicId, {
    type: "authenticated",
    resource_type: "image",
    secure: true,
    sign_url: true,
    expires_at: Math.floor(Date.now() / 1000) + ORG_DOC_URL_TTL_S,
    // A permit is a page of small print, so this is larger than the ID cap —
    // a reviewer has to read a registration number off it.
    transformation: [{ width: 2000, crop: "limit", quality: "auto:good" }],
  })
}

/**
 * Destroy one business document. Returns whether Cloudinary confirmed it.
 *
 * NEVER THROWS. A moderator's decision must not fail because Cloudinary is
 * having a bad afternoon; the failure is returned, recorded on the row, and
 * swept later.
 */
export async function destroyOrgDocument(publicId: string): Promise<boolean> {
  try {
    const result = (await cloudinary.uploader.destroy(publicId, {
      type: "authenticated",
      resource_type: "image",
      // Purges the CDN edges too. Without it a cached copy can outlive the
      // destroy at an edge node, which is the whole failure being avoided.
      invalidate: true,
    })) as { result?: string }

    // "not found" counts as success. The asset is not there, which is the
    // outcome being asked for — treating it as a failure would put the row in
    // a retry loop that can never succeed.
    return result.result === "ok" || result.result === "not found"
  } catch (err) {
    // LOGGED, not swallowed. This is the failure the sweep exists to retry,
    // and a retention path whose only failure mode is silence is one where
    // "the documents are still up there" is discovered by looking at
    // Cloudinary's bill. destroyIdImage() logs for the same reason.
    //
    // The SDK rejects with a plain `{ message, http_code }`, not an Error, so
    // the usual `instanceof Error` line prints "unknown error" for every real
    // failure — which is the one case the log exists for. Verified against the
    // live API: a bad signature arrives this way.
    console.error("[organizations] Cloudinary destroy failed:", describeError(err))
    return false
  }
}

/**
 * Asks Cloudinary whether a document still exists. For the acceptance harness.
 *
 * Not used by the application — nothing in a request path should need to ask.
 * It exists so "deciding destroys the document" can be DEMONSTRATED rather than
 * asserted, which is the only honest way to check a claim about a third party's
 * servers. Mirrors idImageExists().
 */
export async function orgDocumentExists(publicId: string): Promise<boolean> {
  try {
    await cloudinary.api.resource(publicId, {
      type: "authenticated",
      resource_type: "image",
    })
    return true
  } catch {
    return false
  }
}

/**
 * Retry the destroys that failed. Mirrors sweepUndeletedIdImages().
 *
 * The queryable set is exactly "decided, but the public id is still there" —
 * which is what the @@index([verificationStatus, businessDocPublicId]) on
 * Organization exists for, and why businessDocPublicId is nulled only once
 * Cloudinary confirms rather than inside the decision transaction.
 *
 * NEVER THROWS, and that is not decoration: this runs on the admin queue's
 * render (/admin/organizations), so an exception here is a 500 on the page a
 * moderator opened to work the backlog — and the failure it would be raised by
 * is "a document could not be deleted", which is precisely the condition the
 * page must stay up in order to fix. destroyOrgDocument() already contains its
 * own failures; this catch is for the Prisma calls around it.
 */
export async function sweepUndeletedOrgDocuments(limit = 20): Promise<{ swept: number; failed: number }> {
  let swept = 0
  let failed = 0
  try {
    const stranded = await prisma.organization.findMany({
      where: {
        verificationStatus: { in: ["VERIFIED", "REJECTED"] },
        businessDocPublicId: { not: null },
      },
      select: { id: true, businessDocPublicId: true },
      orderBy: { reviewedAt: "asc" },
      take: limit,
    })

    for (const row of stranded) {
      if (!row.businessDocPublicId) continue
      const gone = await destroyOrgDocument(row.businessDocPublicId)
      if (gone) {
        await prisma.organization.update({
          where: { id: row.id },
          data: { businessDocPublicId: null, docDeletedAt: new Date(), docDeleteFailedAt: null },
        })
        swept++
      } else {
        await prisma.organization.update({
          where: { id: row.id },
          data: { docDeleteFailedAt: new Date() },
        })
        failed++
      }
    }
  } catch (err) {
    console.error("[organizations] document sweep failed:", describeError(err))
  }
  return { swept, failed }
}
