// The 20 Category rows: reference data, not user data (see the Category model).
//
// The migration 20261008000000_category_lookup_table seeds them on any
// database built by migrations (live, drills, rehearsal copies). A schema
// built by `prisma db push` gets none, and then every listing insert fails its
// foreign key, so prisma/seed.ts and scripts/seed-categories.ts (called by
// scripts/scratch.ps1 after every push) put them in from here.
//
// Built from CATEGORY_VALUES (order = sortOrder) and CATEGORY_LABELS, the
// lists the API validates and labels with, so a push-built schema can never
// disagree with the code. scripts/verify-category-table.ts checks that the
// migration's hard-coded rows equal this list too.
import type { PrismaClient } from "@/generated/prisma/client"
import { CATEGORY_VALUES } from "../src/lib/validation"
import { CATEGORY_LABELS } from "../src/lib/v1/taxonomy"

export const CATEGORY_SEED: readonly { id: string; label: string; sortOrder: number }[] =
  CATEGORY_VALUES.map((id, i) => ({ id, label: CATEGORY_LABELS[id], sortOrder: i + 1 }))

/** Idempotent: inserts missing rows, and brings an existing row's label and order in line. */
export async function seedCategories(db: Pick<PrismaClient, "category">): Promise<number> {
  for (const c of CATEGORY_SEED) {
    await db.category.upsert({ where: { id: c.id }, create: c, update: { label: c.label, sortOrder: c.sortOrder } })
  }
  return CATEGORY_SEED.length
}
