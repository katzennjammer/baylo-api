/**
 * The similar-photo check on stored embeddings (29 Nov 2026). Server-only.
 *
 * The tiered policy the panel asked for, using @/lib/image-embedding:
 *   ANOTHER trader's photo, confidence ≥ 95%   → blocked at posting, with the %
 *   ANOTHER trader's photo, 80–95%             → allowed; the poster is told
 *                                                "X% similar to another
 *                                                listing" and the listing
 *                                                carries the same note
 *   the poster's OWN active listing, cosine ≥ 0.70
 *                                              → "is this the same item as your
 *                                                listing X?" (a warning; a shop
 *                                                can sell two identical items)
 *
 * Embeddings are stored per photo (ItemImage.embedding) once a listing is
 * posted (embedItemPhotos, run after the response) or by
 * scripts/backfill-photo-embeddings.ts. A full scan is fine at Baylo's size
 * (hundreds of photos, 384 numbers each); at tens of thousands this belongs
 * in pgvector.
 */

import prisma from "@/lib/prisma"
import { fetchAllowedImage } from "@/lib/safe-image-url"
import { NOTE_CONFIDENCE, SAME_ITEM_OWN_COSINE, cosine, embedImage, reuseConfidence } from "@/lib/image-embedding"

/** A listing the owner is still offering: the ones a second copy would duplicate. */
const ACTIVE = ["AVAILABLE", "IN_TRADE", "PENDING_REVIEW"]

export interface SimilarMatches {
  /** Closest photo of ANOTHER account's listing (any status, as the hash check). */
  other: { itemId: string; cosine: number; confidence: number } | null
  /** Closest photo of the poster's own ACTIVE listing at or above SAME_ITEM_OWN_COSINE. */
  ownSameItem: { itemId: string; title: string; cosine: number } | null
}

export async function findSimilarPhotos(embedding: readonly number[], ownerId: string, excludeItemId?: string): Promise<SimilarMatches> {
  const rows = await prisma.itemImage.findMany({
    where: { embedding: { isEmpty: false }, ...(excludeItemId ? { itemId: { not: excludeItemId } } : {}) },
    select: { itemId: true, embedding: true, item: { select: { userId: true, status: true, title: true } } },
  })
  let other: SimilarMatches["other"] = null
  let own: SimilarMatches["ownSameItem"] = null
  for (const r of rows) {
    const c = cosine(embedding, r.embedding)
    if (r.item.userId === ownerId) {
      if (ACTIVE.includes(r.item.status as string) && c >= SAME_ITEM_OWN_COSINE && (!own || c > own.cosine)) {
        own = { itemId: r.itemId, title: r.item.title, cosine: c }
      }
    } else if (!other || c > other.cosine) {
      other = { itemId: r.itemId, cosine: c, confidence: reuseConfidence(c) }
    }
  }
  return { other, ownSameItem: own }
}

/**
 * Embeds a listing's photos that have no embedding yet, then records the
 * listing's "% similar to another listing" note (≥ 80%, else NULL).
 * Never throws: it runs after the response, and a photo that cannot be read
 * simply stays out of the pool until the backfill retries it.
 */
export async function embedItemPhotos(itemId: string): Promise<void> {
  try {
    const item = await prisma.item.findUnique({
      where: { id: itemId },
      select: { userId: true, images: { select: { position: true, url: true, embedding: true } } },
    })
    if (!item) return
    const vectors: number[][] = []
    for (const img of item.images) {
      let v = img.embedding
      if (!v.length) {
        try {
          const e = await embedImage(await fetchAllowedImage(img.url))
          if (!e) return // model unavailable: nothing to do
          v = e
          await prisma.itemImage.update({ where: { itemId_position: { itemId, position: img.position } }, data: { embedding: v } })
        } catch {
          continue
        }
      }
      vectors.push(v)
    }
    let best = 0
    for (const v of vectors) {
      const m = await findSimilarPhotos(v, item.userId, itemId)
      if (m.other && m.other.confidence > best) best = m.other.confidence
    }
    await prisma.item.update({
      where: { id: itemId },
      data: { similarPhotoPct: best >= NOTE_CONFIDENCE ? Math.min(99, Math.round(best * 100)) : null },
    })
  } catch (err) {
    console.error("[photo-similarity] embedItemPhotos failed for", itemId, err instanceof Error ? err.message : err)
  }
}
