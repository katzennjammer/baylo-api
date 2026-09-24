-- Featured boosts: an owner pays Leaves to put a listing in Home's Featured
-- section for a fixed window.
--
-- ADDITIVE ONLY. Three columns on Item, each defaulted or nullable, so every
-- existing row reads as "never boosted" the moment this lands. One index. One
-- new enum value.
--
-- THE ENUM VALUE MUST REACH `main` BEFORE ANY CODE WRITES IT, for the reason
-- 20260923000000_organizations_and_perishables gives: Prisma refuses to read a
-- row whose enum column holds a value the generated client does not model, so
-- the first FEATURE_BOOST ledger row written from a branch would 500 every
-- `main` checkout on the whole LeafTransaction table -- which is every balance
-- screen. See SETUP.md and scripts/check-new-enum-rows.ts.
--
-- HAND-AUTHORED, NOT `migrate diff` OUTPUT, for the same reason as the last
-- two: the generated script carries unrelated drift.

ALTER TYPE "LeafTxType" ADD VALUE 'FEATURE_BOOST';

ALTER TABLE "Item" ADD COLUMN "isFeatured" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Item" ADD COLUMN "featuredUntil" TIMESTAMP(3);
ALTER TABLE "Item" ADD COLUMN "featuredAt" TIMESTAMP(3);

CREATE INDEX "Item_isFeatured_category_featuredAt_idx" ON "Item"("isFeatured", "category", "featuredAt");
