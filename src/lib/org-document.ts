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
    const result = await cloudinary.uploader.destroy(publicId, {
      type: "authenticated",
      resource_type: "image",
      // Purges the CDN edges too. Without it a cached copy can outlive the
      // destroy at an edge node, which is the whole failure being avoided.
      invalidate: true,
    })
    return result?.result === "ok" || result?.result === "not found"
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
 */
export async function sweepUndeletedOrgDocuments(limit = 20): Promise<{ swept: number; failed: number }> {
  const stranded = await prisma.organization.findMany({
    where: {
      verificationStatus: { in: ["VERIFIED", "REJECTED"] },
      businessDocPublicId: { not: null },
    },
    select: { id: true, businessDocPublicId: true },
    orderBy: { reviewedAt: "asc" },
    take: limit,
  })

  let swept = 0
  let failed = 0
  for (const row of stranded) {
    const gone = await destroyOrgDocument(row.businessDocPublicId!)
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
  return { swept, failed }
}
