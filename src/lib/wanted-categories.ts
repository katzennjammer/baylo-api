// What a listing's owner will take in return, schema v2.
//
// Was the enum array `Item.lookingForCategories`; is now ItemWantedCategory
// rows (itemId, category). The API still sends `lookingForCategories:
// Category[]`, built here, so no client changes.
//
//   READ   select `wantedCategories: WANTED_CATEGORIES`, then wantedList(rows).
//   WRITE  wantedCategoriesCreate() for a new listing,
//          replaceWantedCategories() for an edit.
// No rows is the steady state -- see the ItemWantedCategory model note.
import type { Category, Prisma } from "@/generated/prisma/client"

/** For `select`/`include`: `{ wantedCategories: WANTED_CATEGORIES }`. Sorted, so output is stable. */
export const WANTED_CATEGORIES = {
  select: { category: true },
  orderBy: { category: "asc" },
} as const satisfies Prisma.Item$wantedCategoriesArgs

/** The `lookingForCategories` array the API has always returned. */
export function wantedList(rows: readonly { category: Category }[] | null | undefined): Category[] {
  return (rows ?? []).map((r) => r.category)
}

/** Nested-write fragment for `item.create`. Repeats collapse: the PK would refuse them. */
export function wantedCategoriesCreate(categories: readonly Category[]) {
  return { create: [...new Set(categories)].map((category) => ({ category })) }
}

/** Replace a listing's wanted categories wholesale. An empty list clears them. */
export async function replaceWantedCategories(
  db: Pick<Prisma.TransactionClient, "itemWantedCategory">,
  itemId: string,
  categories: readonly Category[],
): Promise<void> {
  await db.itemWantedCategory.deleteMany({ where: { itemId } })
  const unique = [...new Set(categories)]
  if (unique.length) await db.itemWantedCategory.createMany({ data: unique.map((category) => ({ itemId, category })) })
}
