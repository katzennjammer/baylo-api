-- "ItemWantedCategorySummary": a read-only VIEW for display. NOT A TABLE.
--
-- One row per listing that has wanted categories: the listing, its owner, and
-- what the owner wants back, as labels ("Electronics, Fashion, Gaming") and
-- as codes, both in Category.sortOrder order, plus the count. Computed from
-- Item + ItemWantedCategory + Category on every read; it stores nothing, so
-- the table count stays 28 and ItemWantedCategory remains the one source.
--
-- No Prisma model: nothing in the app reads it, and Prisma ignores views
-- unless the `views` preview feature is on, so `migrate diff` stays clean.
--
-- SECURITY. security_invoker = true (Postgres 15+; live is 17.6): a reader
-- needs SELECT on the three underlying tables, not just on the view, so even a
-- future accidental grant on the view would not open the data to the API
-- roles. And Supabase's API roles get nothing on the view itself. They exist
-- on every database this project uses; the check keeps the file portable.
--
-- Applied on live only by scripts/apply-wanted-summary-view.ts, never
-- `prisma migrate deploy`. Reverse: prisma/rollback/ (DROP VIEW).

CREATE VIEW "ItemWantedCategorySummary"
WITH (security_invoker = true) AS
SELECT
    i."id"                                              AS "itemId",
    i."title"                                           AS "title",
    i."userId"                                          AS "userId",
    string_agg(c."label", ', ' ORDER BY c."sortOrder")  AS "wantedCategories",
    array_agg(c."id" ORDER BY c."sortOrder")            AS "wantedCategoryIds",
    count(*)::int                                       AS "wantedCount"
FROM "Item" i
JOIN "ItemWantedCategory" w ON w."itemId" = i."id"
JOIN "Category" c           ON c."id" = w."categoryId"
GROUP BY i."id", i."title", i."userId";

COMMENT ON VIEW "ItemWantedCategorySummary" IS
    'Display only: one row per listing with wanted categories (labels and codes in Category.sortOrder order). Not a table; stores nothing.';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE ALL ON "ItemWantedCategorySummary" FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE ALL ON "ItemWantedCategorySummary" FROM authenticated';
    END IF;
END $$;
