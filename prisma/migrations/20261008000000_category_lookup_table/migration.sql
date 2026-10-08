-- Category lookup table: `enum Category` becomes the table "Category", and
-- Item.category / ItemWantedCategory.category become "categoryId" foreign keys.
--
-- HAND-WRITTEN. `prisma migrate diff` generates DROP COLUMN "category" + ADD
-- COLUMN "categoryId" TEXT NOT NULL for this change, which loses every value
-- (and fails outright on a table with rows). This file instead copies the
-- value across, checks it, and only then drops the old column. The objects it
-- ends with are exactly the ones that diff names, so `migrate diff` against
-- prisma/schema.prisma is empty afterwards.
--
-- ONE TRANSACTION. Run on live only by scripts/apply-category-lookup.ts
-- (through scripts/lib/migration-runner.ts), never `prisma migrate deploy`.
-- Any failed check below raises, and the whole transaction rolls back.
-- Reverse: prisma/rollback/20261008000000_category_lookup_table.sql.
--
-- Row counts cannot change here: nothing is inserted into or deleted from
-- Item or ItemWantedCategory. The checks are per row, which is stronger.

-- 0. Move the enum out of the way. A table brings a row type of its own name,
--    so CREATE TABLE "Category" fails with 'type "Category" already exists'
--    while the enum is called that (found in the scratch rehearsal, 8 Oct).
--    Renaming keeps the type's OID, so both columns keep working; it is
--    dropped in step 7.
ALTER TYPE "Category" RENAME TO "Category_old";

-- 1. The lookup table, seeded from the enum: code, display label (equal to
--    CATEGORY_LABELS in src/lib/v1/taxonomy.ts), and the enum's own order.
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" SMALLINT NOT NULL,
    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Category_label_key" ON "Category"("label");
CREATE UNIQUE INDEX "Category_sortOrder_key" ON "Category"("sortOrder");

INSERT INTO "Category" ("id", "label", "sortOrder") VALUES
    ('ELECTRONICS', 'Electronics', 1),
    ('CLOTHING', 'Fashion', 2),
    ('BAGS', 'Bags', 3),
    ('BEAUTY', 'Beauty', 4),
    ('ACCESSORIES', 'Accessories', 5),
    ('FURNITURE', 'Home & Garden', 6),
    ('BOOKS', 'Books & Media', 7),
    ('GAMING', 'Gaming', 8),
    ('SPORTS', 'Sports', 9),
    ('BIKES', 'Bikes', 10),
    ('TOYS', 'Kids & Toys', 11),
    ('TOOLS', 'Tools & DIY', 12),
    ('MUSIC', 'Music', 13),
    ('ART', 'Art & Crafts', 14),
    ('COLLECTIBLES', 'Collectibles', 15),
    ('PETS', 'Pets', 16),
    ('PLANTS', 'Plants', 17),
    ('FOOD', 'Food', 18),
    ('SERVICES', 'Services', 19),
    ('OTHER', 'Miscellaneous', 20);

-- The seed must be the enum, exactly: same labels, same order, nothing more.
DO $$
DECLARE missing TEXT; extra TEXT; misordered TEXT;
BEGIN
    SELECT string_agg(e::text, ', ') INTO missing
      FROM unnest(enum_range(NULL::"Category_old")) AS u(e)
     WHERE e::text NOT IN (SELECT "id" FROM "Category");
    SELECT string_agg("id", ', ') INTO extra
      FROM "Category"
     WHERE "id" NOT IN (SELECT e::text FROM unnest(enum_range(NULL::"Category_old")) AS u(e));
    SELECT string_agg(c."id", ', ') INTO misordered
      FROM "Category" c
      JOIN (SELECT e::text AS code, ord
              FROM unnest(enum_range(NULL::"Category_old")) WITH ORDINALITY AS u(e, ord)) o ON o.code = c."id"
     WHERE o.ord <> c."sortOrder";
    IF missing IS NOT NULL OR extra IS NOT NULL OR misordered IS NOT NULL THEN
        RAISE EXCEPTION 'Category seed differs from the enum: missing [%], extra [%], misordered [%]',
            coalesce(missing, ''), coalesce(extra, ''), coalesce(misordered, '');
    END IF;
END $$;

-- 2. The new columns, nullable until they are filled.
ALTER TABLE "Item" ADD COLUMN "categoryId" TEXT;
ALTER TABLE "ItemWantedCategory" ADD COLUMN "categoryId" TEXT;

-- 3. Backfill: the code is the enum label, unchanged.
UPDATE "Item" SET "categoryId" = "category"::text;
UPDATE "ItemWantedCategory" SET "categoryId" = "category"::text;

-- 4. Verify, row by row, before anything is dropped.
DO $$
DECLARE n BIGINT;
BEGIN
    SELECT count(*) INTO n FROM "Item"
     WHERE "categoryId" IS NULL OR "categoryId" <> "category"::text;
    IF n > 0 THEN RAISE EXCEPTION 'Item backfill: % row(s) differ from category', n; END IF;

    SELECT count(*) INTO n FROM "ItemWantedCategory"
     WHERE "categoryId" IS NULL OR "categoryId" <> "category"::text;
    IF n > 0 THEN RAISE EXCEPTION 'ItemWantedCategory backfill: % row(s) differ from category', n; END IF;

    SELECT count(*) INTO n FROM "Item" i
     WHERE NOT EXISTS (SELECT 1 FROM "Category" c WHERE c."id" = i."categoryId");
    IF n > 0 THEN RAISE EXCEPTION 'Item: % row(s) with no Category', n; END IF;

    SELECT count(*) INTO n FROM "ItemWantedCategory" w
     WHERE NOT EXISTS (SELECT 1 FROM "Category" c WHERE c."id" = w."categoryId");
    IF n > 0 THEN RAISE EXCEPTION 'ItemWantedCategory: % row(s) with no Category', n; END IF;
END $$;

-- 5. NOT NULL and the foreign keys (Prisma's defaults for a required relation).
ALTER TABLE "Item" ALTER COLUMN "categoryId" SET NOT NULL;
ALTER TABLE "ItemWantedCategory" ALTER COLUMN "categoryId" SET NOT NULL;
ALTER TABLE "Item" ADD CONSTRAINT "Item_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ItemWantedCategory" ADD CONSTRAINT "ItemWantedCategory_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6. Re-key onto the new column, then drop the old one.
ALTER TABLE "ItemWantedCategory" DROP CONSTRAINT "ItemWantedCategory_pkey";
ALTER TABLE "ItemWantedCategory" ADD CONSTRAINT "ItemWantedCategory_pkey" PRIMARY KEY ("itemId", "categoryId");
DROP INDEX "ItemWantedCategory_category_idx";
DROP INDEX "Item_valuationSource_category_idx";
CREATE INDEX "ItemWantedCategory_categoryId_idx" ON "ItemWantedCategory"("categoryId");
CREATE INDEX "Item_valuationSource_categoryId_idx" ON "Item"("valuationSource", "categoryId");
CREATE INDEX "Item_categoryId_idx" ON "Item"("categoryId");
ALTER TABLE "Item" DROP COLUMN "category";
ALTER TABLE "ItemWantedCategory" DROP COLUMN "category";

-- 7. The enum (renamed in step 0). No CASCADE: if anything still used it,
--    this fails and the whole migration rolls back.
DROP TYPE "Category_old";
