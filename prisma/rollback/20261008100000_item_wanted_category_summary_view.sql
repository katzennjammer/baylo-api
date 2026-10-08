-- REVERSE of prisma/migrations/20261008100000_item_wanted_category_summary_view.
--
-- The view stores nothing, so dropping it loses nothing. Run only by
--   scripts/apply-wanted-summary-view.ts reverse
-- which also deletes the migration's _prisma_migrations row in the same
-- transaction. No CASCADE: nothing may depend on a display view, and if
-- something does, this fails and changes nothing.
DROP VIEW "ItemWantedCategorySummary";
