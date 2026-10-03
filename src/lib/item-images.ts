// A listing's photos, schema v2.
//
// Until v2 a listing's photos were a JSON array of URLs in a TEXT column
// (`Item.images`) and their perceptual hashes lived in a second table keyed by
// the index into that array (ItemImageHash). They are now one table, ItemImage
// (itemId, position, url, hash), and this module is the one place that knows
// its shape:
//
//   READ   select `images: ITEM_IMAGES` -- ALWAYS this fragment, never
//          `images: true`. A relation comes back in no particular order, and
//          position 0 is the cover photo every card draws.
//   WIRE   imageUrls(rows) is the `string[]` every API response has always
//          sent; imagesJson(rows) is the old JSON string, for the few web
//          components that still take one. Response shapes do not change.
//   WRITE  itemImagesCreate() for a new listing; replaceItemImages() and
//          setItemImageHashes() for an edit.
import type { Prisma } from "@/generated/prisma/client"
import type { ImageHashRow } from "@/lib/image-hashes"

/** The ordered photo rows, for `select`/`include`: `{ images: ITEM_IMAGES }`. */
export const ITEM_IMAGES = {
  select: { url: true, hash: true, position: true },
  orderBy: { position: "asc" },
} as const satisfies Prisma.Item$imagesArgs

export type ImageRow = { url: string; hash?: string | null; position?: number }

/** The photo URLs in order -- the `images: string[]` the API has always returned. */
export function imageUrls(rows: readonly ImageRow[] | null | undefined): string[] {
  return (rows ?? []).map((r) => r.url)
}

/** The cover photo, or null for a listing with none. */
export function firstImageUrl(rows: readonly ImageRow[] | null | undefined): string | null {
  return rows?.[0]?.url ?? null
}

/** The old `Item.images` JSON string, for web components that still take one. */
export function imagesJson(rows: readonly ImageRow[] | null | undefined): string {
  return JSON.stringify(imageUrls(rows))
}

/** The cover photo's hash -- what `Item.imageHash` used to hold. */
export function leadHash(rows: readonly ImageRow[] | null | undefined): string | null {
  return rows?.find((r) => r.position === 0)?.hash ?? rows?.[0]?.hash ?? null
}

/**
 * The rows for a new listing: one per URL, each with its hash when the client
 * sent one for that position. A hash for a position with no photo is dropped --
 * there is no photo for it to describe.
 */
export function imageRowsFor(urls: readonly string[], hashes: readonly ImageHashRow[] = []): { position: number; url: string; hash: string | null }[] {
  const byPos = new Map(hashes.map((h) => [h.position, h.hash]))
  return urls.map((url, position) => ({ position, url, hash: byPos.get(position) ?? null }))
}

/** Nested-write fragment for `item.create({ data: { images: ... } })`. */
export function itemImagesCreate(urls: readonly string[], hashes: readonly ImageHashRow[] = []) {
  return { create: imageRowsFor(urls, hashes) }
}

type ImageDb = Pick<Prisma.TransactionClient, "itemImage">

/** Replace a listing's photos (and their hashes) wholesale. */
export async function replaceItemImages(db: ImageDb, itemId: string, urls: readonly string[], hashes: readonly ImageHashRow[] = []): Promise<void> {
  await db.itemImage.deleteMany({ where: { itemId } })
  const rows = imageRowsFor(urls, hashes)
  if (rows.length) await db.itemImage.createMany({ data: rows.map((r) => ({ itemId, ...r })) })
}

/**
 * Set the hashes on a listing's EXISTING photos, leaving the URLs alone: every
 * position gets the hash the client sent for it, or NULL when it sent none --
 * the same "the client's list is the whole truth" rule the old
 * delete-then-recreate of ItemImageHash applied.
 */
export async function setItemImageHashes(db: ImageDb, itemId: string, hashes: readonly ImageHashRow[]): Promise<void> {
  await db.itemImage.updateMany({ where: { itemId }, data: { hash: null } })
  for (const h of hashes) {
    await db.itemImage.updateMany({ where: { itemId, position: h.position }, data: { hash: h.hash } })
  }
}

/** Either form a photo list can arrive in: ItemImage rows, or a legacy JSON string. */
export type ImagesLike = string | readonly ImageRow[] | null | undefined

/**
 * The URLs, whichever form they came in. A JSON string is parsed defensively --
 * a malformed value yields [] rather than throwing, so one bad value cannot
 * take down a whole page (the rule every old local parser followed).
 */
export function toImageUrls(v: ImagesLike): string[] {
  if (!v) return []
  if (typeof v !== "string") return imageUrls(v)
  try {
    const parsed: unknown = JSON.parse(v)
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === "string") : []
  } catch {
    return []
  }
}
