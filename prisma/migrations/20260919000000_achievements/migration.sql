-- Achievements: model the two live tables in the schema, and extend them.
--
-- ── WHY THIS MIGRATION IS ADDITIVE AND NOT A `migrate diff` ──────────────────
--
-- "Achievement" and "UserAchievement" already EXIST in the live database with
-- rows. They were pushed there directly, by a pass nobody has fully accounted
-- for, and appear in no prior migration in this repository. They are modelled
-- in prisma/schema.prisma as of this change (that was the whole point), but
-- `prisma migrate diff --from-config-datasource` against the OLD schema kept
-- proposing to DROP them, and every hand-authored migration before this one had
-- to strip that out (see 20260918000000_value_rejection_appeals).
--
-- So this file does NOT contain a diff. It is hand-written to be idempotent and
-- ADDITIVE: CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS. Running it on
-- a database that already has the tables adds only the three new columns; on a
-- database that does not, it builds them from scratch. It never drops a column,
-- a table, or a row.
--
-- The three new columns this feature needs that the live tables lacked:
--
--   imageUrl          uploaded badge art (public Cloudinary URL). `icon` stays
--                     as an emoji/text fallback.
--   homeDisplayOrder  the single featured slot on the home feed. The display
--                     route already probed information_schema for this column;
--                     it is real now.
--   sortOrder         admin ordering for the shelf.
--
-- The "AchievementCriterion" enum already exists in the live database. It is
-- recreated only if absent, and only with the eight values the code uses.

-- ── The criterion enum ──────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AchievementCriterion') THEN
    CREATE TYPE "AchievementCriterion" AS ENUM (
      -- The four the live database already had (this is a no-op against a
      -- database that has the type; it matters only for a fresh one).
      'VERIFIED_ACCOUNT',
      'ID_VERIFIED',
      'FIRST_LISTING',
      'COMPLETED_TRADES',
      -- Added by 20260919000001_achievement_criterion_values on a live DB,
      -- listed here so a from-scratch database gets the complete set.
      'PROFILE_COMPLETE',
      'LIFETIME_LEAVES',
      'SAFEZONE_MEETUPS',
      'REPORTS_FILED'
    );
  END IF;
END $$;

-- ── Achievement (the definition an admin creates) ───────────────────────────
CREATE TABLE IF NOT EXISTS "Achievement" (
  "id"          TEXT NOT NULL,
  "key"         TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "icon"        TEXT NOT NULL DEFAULT '🏆',
  "criterion"   "AchievementCriterion" NOT NULL,
  "threshold"   INTEGER NOT NULL DEFAULT 1,
  "isActive"    BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Achievement_pkey" PRIMARY KEY ("id")
);

-- Additive: the three columns this feature introduces.
ALTER TABLE "Achievement" ADD COLUMN IF NOT EXISTS "imageUrl"          TEXT;
ALTER TABLE "Achievement" ADD COLUMN IF NOT EXISTS "sortOrder"         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Achievement" ADD COLUMN IF NOT EXISTS "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Unique key and the shelf index, only if absent.
CREATE UNIQUE INDEX IF NOT EXISTS "Achievement_key" ON "Achievement" ("key");
CREATE INDEX IF NOT EXISTS "Achievement_isActive_sortOrder_idx" ON "Achievement" ("isActive", "sortOrder");

-- ── UserAchievement (a user's earned copy) ──────────────────
CREATE TABLE IF NOT EXISTS "UserAchievement" (
  "id"            TEXT NOT NULL,
  "userId"        TEXT NOT NULL,
  "achievementId" TEXT NOT NULL,
  "unlockedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "displayOrder"  INTEGER,
  CONSTRAINT "UserAchievement_pkey" PRIMARY KEY ("id")
);

-- Additive: the featured-home slot.
ALTER TABLE "UserAchievement" ADD COLUMN IF NOT EXISTS "homeDisplayOrder" INTEGER;

-- One earned copy per (user, achievement) -- the claim constraint the criteria
-- engine inserts against with skipDuplicates.
CREATE UNIQUE INDEX IF NOT EXISTS "UserAchievement_userId_achievementId_key"
  ON "UserAchievement" ("userId", "achievementId");
CREATE INDEX IF NOT EXISTS "UserAchievement_userId_displayOrder_idx"
  ON "UserAchievement" ("userId", "displayOrder");
CREATE INDEX IF NOT EXISTS "UserAchievement_achievementId_idx"
  ON "UserAchievement" ("achievementId");

-- Foreign keys, added only if they do not already exist. ON DELETE CASCADE from
-- both sides: an earned row is meaningless without its user or its definition.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UserAchievement_userId_fkey'
  ) THEN
    ALTER TABLE "UserAchievement"
      ADD CONSTRAINT "UserAchievement_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UserAchievement_achievementId_fkey'
  ) THEN
    ALTER TABLE "UserAchievement"
      ADD CONSTRAINT "UserAchievement_achievementId_fkey"
      FOREIGN KEY ("achievementId") REFERENCES "Achievement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
