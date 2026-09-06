import { v2 as cloudinary } from "cloudinary"
import prisma from "@/lib/prisma"

/**
 * The ID photo: where it goes, how a reviewer sees it, and how it leaves.
 *
 * ── WHY THIS IS NOT /api/upload ─────────────────────────────────────────────
 *
 * Every other image on Baylo is a listing photo: public by design, delivered
 * from `res.cloudinary.com` to anyone with the URL, and meant to be. A
 * photographed government ID is the opposite of that in every respect, and the
 * difference is not a folder name — it is the DELIVERY TYPE.
 *
 *   upload         (every listing photo)  fetchable by URL, by anyone, forever
 *   authenticated  (this)                 404s without a signature that expires
 *
 * A "private folder" that is really an `upload`-type asset in a folder called
 * `private/` is not private at all: Cloudinary folders are naming, not access
 * control, and the delivery URL works for whoever has it. So these are uploaded
 * with `type: "authenticated"`, which makes an unsigned request fail at the CDN
 * even if the URL leaks out of a screenshot, a log or a browser history.
 *
 * ── THE LIFECYCLE, WHICH IS THE POINT ───────────────────────────────────────
 *
 *   submit    uploaded here, authenticated, into ID_FOLDER
 *   review    the admin page mints a signed URL good for SIGNED_URL_TTL_S
 *   decide    destroyed. Approve or reject; the image goes either way.
 *
 * There is no branch in which the image survives a decision. That is what makes
 * "we do not keep a folder of scanned IDs" a fact about the system rather than
 * a sentence in a policy.
 */

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

/**
 * The folder. Segregated from `baylo/` so that a bulk operation on listing
 * images — a cleanup script, a transformation backfill, a mistaken "delete
 * everything in this folder" — cannot reach these by accident.
 */
export const ID_FOLDER = "baylo-id-verification"

/**
 * How long a signed review URL lives: five minutes.
 *
 * Long enough for a moderator to open the page, look at the ID and decide.
 * Short enough that a URL pasted into a chat, captured in a screen recording or
 * left in a browser history is dead by the time anyone else tries it. It is
 * re-minted on every page load, so a shorter life costs the reviewer nothing.
 */
export const SIGNED_URL_TTL_S = 5 * 60

export interface UploadedIdImage {
  url: string
  publicId: string
}

/**
 * Uploads one sanitised ID photo and returns both handles.
 *
 * The buffer must ALREADY have been through sanitizeImage() — the caller does
 * that, for the same reason /api/upload does: a phone camera writes GPS
 * coordinates into every photo, and a picture of an ID taken at the kitchen
 * table carries the kitchen table's coordinates. Re-encoding drops them.
 *
 * `overwrite: false` and a random-suffixed public_id: two submissions of the
 * same document must never collide on a name and silently replace one another,
 * because the row that lost would then hold a delete key pointing at somebody
 * else's image.
 */
export async function uploadIdImage(buffer: Buffer): Promise<UploadedIdImage> {
  return new Promise<UploadedIdImage>((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(
        {
          folder: ID_FOLDER,
          resource_type: "image",
          // THE LINE THAT MAKES IT PRIVATE. Without it this is an ordinary
          // public asset in a folder with a serious-sounding name.
          type: "authenticated",
          // Belt and braces on top of the sanitiser: Cloudinary is told not to
          // retain metadata on its side either.
          image_metadata: false,
          // Cloudinary's own moderation and derived-asset machinery is off.
          // Every derivative is a second copy of a government ID that would
          // need destroying too, and eager transformations would create them
          // without anything in this codebase knowing their public_ids.
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

/**
 * A short-lived signed URL a reviewer can actually open.
 *
 * `sign_url: true` with `type: "authenticated"` produces a URL carrying an
 * expiring signature; without both, Cloudinary serves a 404 and the review page
 * shows a broken image with no explanation of why.
 *
 * Minted per page load and never stored. A signed URL in a database column
 * would be a stored credential to a government ID with a five-minute life and
 * an unbounded blast radius the moment somebody raised the TTL.
 */
export function signIdImageUrl(publicId: string): string {
  return cloudinary.url(publicId, {
    type: "authenticated",
    resource_type: "image",
    secure: true,
    sign_url: true,
    expires_at: Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_S,
    // Capped rather than original size. A reviewer needs to read a number off a
    // card, not to hold a print-resolution scan of it in a browser cache.
    transformation: [{ width: 1600, crop: "limit", quality: "auto:good" }],
  })
}

/**
 * Destroys one ID image. Returns whether Cloudinary confirmed it.
 *
 * NEVER THROWS, and that is the contract the decision path depends on: a
 * moderator's approve must not fail because Cloudinary is having a bad
 * afternoon. The failure is returned, recorded on the row, and swept later.
 *
 * `invalidate: true` purges the CDN edges as well as the origin. Without it a
 * cached derivative can outlive the destroy at an edge node, which for this
 * particular asset is the whole failure being avoided.
 */
export async function destroyIdImage(publicId: string): Promise<boolean> {
  try {
    const res = (await cloudinary.uploader.destroy(publicId, {
      type: "authenticated",
      resource_type: "image",
      invalidate: true,
    })) as { result?: string }

    // "not found" counts as success. The asset is not there, which is the
    // outcome being asked for — treating it as a failure would put the row in a
    // retry loop that can never succeed.
    return res.result === "ok" || res.result === "not found"
  } catch (err) {
    console.error(
      "[id-verification] Cloudinary destroy failed:",
      err instanceof Error ? err.message : "unknown error",
    )
    return false
  }
}

/**
 * Asks Cloudinary whether an asset still exists. For the acceptance harness.
 *
 * Not used by the application — nothing in a request path should need to ask.
 * It exists so "approving deletes the image" can be DEMONSTRATED rather than
 * asserted, which is what the spec asked for.
 */
export async function idImageExists(publicId: string): Promise<boolean> {
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
 * The retry sweep: decided rows whose image is still up there.
 *
 * WHY A SWEEP AND NOT A QUEUE. The spec is explicit that a Cloudinary failure
 * must not block a decision, which means the destroy happens after the decision
 * commits and can therefore be lost — to a network blip, or to the process
 * dying between the two. The set of lost destroys is not something that needs
 * tracking in a side table: it is exactly `status != PENDING AND imagePublicId
 * IS NOT NULL`, which the row already says and an index already answers.
 *
 * Runs lazily on the admin queue's page load, in the same spirit as
 * sweepLapsedContracts(): there is no cron on this deployment, and the person
 * most likely to open that page is the person who just made the decision that
 * failed. Bounded per call so one bad afternoon cannot turn a page load into a
 * hundred sequential API calls.
 *
 * NEVER THROWS. A sweep that can fail a page render is a sweep that gets
 * removed from the page.
 */
export async function sweepUndeletedIdImages(limit = 20): Promise<{ swept: number; failed: number }> {
  let swept = 0
  let failed = 0
  try {
    const stale = await prisma.idVerification.findMany({
      where: { status: { in: ["APPROVED", "REJECTED"] }, imagePublicId: { not: null } },
      select: { id: true, imagePublicId: true },
      orderBy: { reviewedAt: "asc" },
      take: limit,
    })

    for (const row of stale) {
      if (!row.imagePublicId) continue
      const gone = await destroyIdImage(row.imagePublicId)
      if (gone) {
        await prisma.idVerification.update({
          where: { id: row.id },
          data: { imagePublicId: null, imageDeletedAt: new Date(), imageDeleteFailedAt: null },
        })
        swept++
      } else {
        await prisma.idVerification.update({
          where: { id: row.id },
          data: { imageDeleteFailedAt: new Date() },
        })
        failed++
      }
    }
  } catch (err) {
    console.error(
      "[id-verification] image sweep failed:",
      err instanceof Error ? err.message : "unknown error",
    )
  }
  return { swept, failed }
}
