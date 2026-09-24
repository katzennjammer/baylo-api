-- Weekly quests -> daily quests, one day after the feature first shipped.
-- Nothing has read GET /api/v1/quests from a real client yet (no mobile UI
-- exists for it), so this rewrites the brand-new QuestAssignment table's
-- shape rather than migrating rows forward -- there is no user-facing history
-- to preserve.
--
--   1. "weekStart" -> "periodStart". The column now marks a UTC calendar DAY,
--      not a Monday-anchored week, and keeping the old name would mislead
--      the next person to read this table.
--   2. The unique key moves from (userId, weekStart, tier) to
--      (userId, periodStart, quest). Easy and Medium each place TWO quests a
--      day now, so tier alone no longer identifies one row.
--
-- Existing QuestAssignment rows (all scratch/test data) are dropped rather
-- than migrated -- there is nothing in them worth preserving, and inventing
-- five quests' worth of history for a table nothing has read yet would be
-- more code than the table's actual users represent.

TRUNCATE TABLE "QuestAssignment";

ALTER TABLE "QuestAssignment" RENAME COLUMN "weekStart" TO "periodStart";

DROP INDEX IF EXISTS "QuestAssignment_userId_weekStart_tier_key";
DROP INDEX IF EXISTS "QuestAssignment_userId_weekStart_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "QuestAssignment_userId_periodStart_quest_key"
  ON "QuestAssignment" ("userId", "periodStart", "quest");
CREATE INDEX IF NOT EXISTS "QuestAssignment_userId_periodStart_idx"
  ON "QuestAssignment" ("userId", "periodStart");
