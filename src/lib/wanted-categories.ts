// What a listing's owner will take in return, schema v2.
//
// Was the enum array `Item.lookingForCategories`; is now ItemWantedCategory
// rows (itemId, category). The API still sends `lookingForCategories:
// Category[]`, built here, so no client changes. Since 8 Oct 2026 `category`
// is the code column "categoryId", a foreign key to the Category table.
//
//   READ   select `wantedCategories: WANTED_CATEGORIES`, then wantedList(rows).
//   WRITE  wantedCategoriesCreate() for a new listing,
//          replaceWantedCategories() for an edit.
// No rows is the steady state -- see the ItemWantedCategory model note.
import type { Prisma } from "@/generated/prisma/client"
import type { Category } from "@/lib/v1/taxonomy"

/**
 * For `select`/`include`: `{ wantedCategories: WANTED_CATEGORIES }`. Sorted, so
 * output is stable. By Category.sortOrder, NOT by the code: the enum this
 * replaced sorted in declaration order (ELECTRONICS, CLOTHING, ...), and
 * sorting the text would quietly reorder every `lookingFor` list.
 */
export const WANTED_CATEGORIES = {
  select: { category: true },
  orderBy: { categoryRef: { sortOrder: "asc" } },
} as const satisfies Prisma.Item$wantedCategoriesArgs

/** The `lookingForCategories` array the API has always returned. */
export function wantedList(rows: readonly { category: string }[] | null | undefined): string[] {
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
