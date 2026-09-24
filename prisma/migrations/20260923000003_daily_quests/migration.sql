-- Daily quests, replacing the weekly cycle: "weekStart" becomes "dayStart"
-- (UTC calendar day instead of ISO week), and a new "slot" column lets more
-- than one quest be assigned per tier per period -- 2 Easy + 2 Medium + 1
-- Hard, instead of one of each. See @/lib/quests for the engine.
--
-- Written re-runnable (IF EXISTS / IF NOT EXISTS throughout), matching this
-- repo's migration convention.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'QuestAssignment' AND column_name = 'weekStart'
  ) THEN
    ALTER TABLE "QuestAssignment" RENAME COLUMN "weekStart" TO "dayStart";
  END IF;
END $$;

ALTER TABLE "QuestAssignment" ADD COLUMN IF NOT EXISTS "slot" INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS "QuestAssignment_userId_weekStart_tier_key";
DROP INDEX IF EXISTS "QuestAssignment_userId_weekStart_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "QuestAssignment_userId_dayStart_tier_slot_key"
  ON "QuestAssignment" ("userId", "dayStart", "tier", "slot");
CREATE INDEX IF NOT EXISTS "QuestAssignment_userId_dayStart_idx"
  ON "QuestAssignment" ("userId", "dayStart");
