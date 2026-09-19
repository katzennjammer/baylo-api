-- Append the criteria this feature adds to the LIVE "AchievementCriterion" enum.
--
-- The live enum already contained VERIFIED_ACCOUNT, ID_VERIFIED, FIRST_LISTING
-- and COMPLETED_TRADES (and there are Achievement rows using them), so the
-- migration that created the tables could not define the type -- CREATE TYPE
-- IF NOT EXISTS was a no-op against a database that already had it. This
-- migration ADDS the four extra criteria, and does nothing if they are already
-- present.
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block on some
-- Postgres versions, so each is its own statement. IF NOT EXISTS makes each one
-- safe to re-run. Nothing is renamed or dropped: the four original values must
-- keep working, because real rows reference them.

ALTER TYPE "AchievementCriterion" ADD VALUE IF NOT EXISTS 'PROFILE_COMPLETE';
ALTER TYPE "AchievementCriterion" ADD VALUE IF NOT EXISTS 'LIFETIME_LEAVES';
ALTER TYPE "AchievementCriterion" ADD VALUE IF NOT EXISTS 'SAFEZONE_MEETUPS';
ALTER TYPE "AchievementCriterion" ADD VALUE IF NOT EXISTS 'REPORTS_FILED';
