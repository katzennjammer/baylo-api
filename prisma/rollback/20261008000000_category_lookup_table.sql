-- REVERSE of prisma/migrations/20261008000000_category_lookup_table.
--
-- Puts `enum Category` back with its 20 labels in their original order,
-- refills Item.category and ItemWantedCategory.category from "categoryId",
-- rebuilds the original primary key and indexes under their original names,
-- and drops the "Category" table. Not a Prisma migration (this folder is not
-- in prisma/migrations); run only by
--   scripts/apply-category-lookup.ts reverse
-- which also deletes this migration's _prisma_migrations row in the same
-- transaction. Afterwards: check out the code from before the change,
-- `prisma generate`, restart the server.
--
-- If a category code was added after the forward migration, the cast in
-- step 3 fails and NOTHING changes: add that label to the enum below first.

-- 1. The enum, exactly as the baseline declared it. Created as
--    "Category_restore" because the table's row type holds the name "Category"
--    until step 5; renamed there (the columns follow, by OID).
CREATE TYPE "Category_restore" AS ENUM (
    'ELECTRONICS', 'CLOTHING', 'BAGS', 'BEAUTY', 'ACCESSORIES', 'FURNITURE',
    'BOOKS', 'GAMING', 'SPORTS', 'BIKES', 'TOYS', 'TOOLS', 'MUSIC', 'ART',
    'COLLECTIBLES', 'PETS', 'PLANTS', 'FOOD', 'SERVICES', 'OTHER'
);

-- 2. The old columns, nullable until filled.
ALTER TABLE "Item" ADD COLUMN "category" "Category_restore";
ALTER TABLE "ItemWantedCategory" ADD COLUMN "category" "Category_restore";

-- 3. Refill from the codes. An unknown code fails the cast here.
UPDATE "Item" SET "category" = "categoryId"::"Category_restore";
UPDATE "ItemWantedCategory" SET "category" = "categoryId"::"Category_restore";

DO $$
DECLARE n BIGINT;
BEGIN
    SELECT count(*) INTO n FROM "Item" WHERE "category" IS NULL OR "category"::text <> "categoryId";
    IF n > 0 THEN RAISE EXCEPTION 'Item refill: % row(s) differ', n; END IF;
    SELECT count(*) INTO n FROM "ItemWantedCategory" WHERE "category" IS NULL OR "category"::text <> "categoryId";
    IF n > 0 THEN RAISE EXCEPTION 'ItemWantedCategory refill: % row(s) differ', n; END IF;
END $$;

ALTER TABLE "Item" ALTER COLUMN "category" SET NOT NULL;
ALTER TABLE "ItemWantedCategory" ALTER COLUMN "category" SET NOT NULL;

-- 4. The original key and indexes, under their original names.
ALTER TABLE "ItemWantedCategory" DROP CONSTRAINT "ItemWantedCategory_pkey";
ALTER TABLE "ItemWantedCategory" ADD CONSTRAINT "ItemWantedCategory_pkey" PRIMARY KEY ("itemId", "category");
CREATE INDEX "ItemWantedCategory_category_idx" ON "ItemWantedCategory"("category");
CREATE INDEX "Item_valuationSource_category_idx" ON "Item"("valuationSource", "category");

-- 5. Drop the new column (its FK and indexes go with it), then the table,
--    and give the enum its name back.
ALTER TABLE "Item" DROP COLUMN "categoryId";
ALTER TABLE "ItemWantedCategory" DROP COLUMN "categoryId";
DROP TABLE "Category";
ALTER TYPE "Category_restore" RENAME TO "Category";
