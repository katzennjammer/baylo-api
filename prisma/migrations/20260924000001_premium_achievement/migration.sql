-- Premium perk #4: a badge for being (or having ever been) a Premium
-- subscriber. Adds one enum value, same pattern as the three migrations
-- before it that append to "AchievementCriterion" -- its own statement,
-- since ALTER TYPE ... ADD VALUE cannot run inside a transaction block on
-- some Postgres versions, and IF NOT EXISTS makes it safe to re-run.

ALTER TYPE "AchievementCriterion" ADD VALUE IF NOT EXISTS 'PREMIUM_SUBSCRIBER';
