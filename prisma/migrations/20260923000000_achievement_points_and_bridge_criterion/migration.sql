-- Two additive changes for the swan badge set:
--
--   1. A new "AchievementCriterion" value, BRIDGE_COMPLETED, for the first
--      completed trade that carried a bridge fee (see progressFor() in
--      @/lib/achievements). ALTER TYPE ... ADD VALUE cannot run inside a
--      transaction block on some Postgres versions, so it is its own
--      statement, same as 20260919000001_achievement_criterion_values.
--      IF NOT EXISTS makes it safe to re-run.
--
--   2. Achievement.points -- a plain stored number, defaulted to 0 so every
--      existing row is valid without a backfill.
--
-- Nothing here renames or drops a column or a value: real Achievement rows
-- reference the existing criteria, and this only adds to the set.

ALTER TYPE "AchievementCriterion" ADD VALUE IF NOT EXISTS 'BRIDGE_COMPLETED';

ALTER TABLE "Achievement" ADD COLUMN IF NOT EXISTS "points" INTEGER NOT NULL DEFAULT 0;
