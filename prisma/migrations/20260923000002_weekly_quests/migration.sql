-- Weekly quests: a new "QuestAssignment" table plus two new enums
-- ("QuestTier", "QuestKind") and one new LeafTxType value ("QUEST_REWARD").
-- See @/lib/quests for the engine and GET /api/v1/quests for the route.
--
-- Brand new feature, brand new table: unlike the achievements migration
-- before this one, there is no pre-existing live table to reconcile against.
-- Still written CREATE TYPE/TABLE/INDEX IF NOT EXISTS and ADD VALUE IF NOT
-- EXISTS throughout, matching this repo's convention for re-runnability.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'QuestTier') THEN
    CREATE TYPE "QuestTier" AS ENUM ('EASY', 'MEDIUM', 'HARD');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'QuestKind') THEN
    CREATE TYPE "QuestKind" AS ENUM (
      'SEND_OFFER', 'FOLLOW_TRADER', 'LEAVE_REVIEW',
      'LIST_ITEM', 'RECEIVE_OFFER',
      'COMPLETE_TRADE', 'COMPLETE_BRIDGE_TRADE', 'COMPLETE_SAFEZONE_TRADE'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "QuestAssignment" (
  "id"           TEXT NOT NULL,
  "weekStart"    TIMESTAMP(3) NOT NULL,
  "tier"         "QuestTier" NOT NULL,
  "quest"        "QuestKind" NOT NULL,
  "rewardLeaves" INTEGER NOT NULL,
  "completedAt"  TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userId"       TEXT NOT NULL,
  CONSTRAINT "QuestAssignment_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'QuestAssignment_userId_fkey'
  ) THEN
    ALTER TABLE "QuestAssignment"
      ADD CONSTRAINT "QuestAssignment_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "QuestAssignment_userId_weekStart_tier_key"
  ON "QuestAssignment" ("userId", "weekStart", "tier");
CREATE INDEX IF NOT EXISTS "QuestAssignment_userId_weekStart_idx"
  ON "QuestAssignment" ("userId", "weekStart");

ALTER TYPE "LeafTxType" ADD VALUE IF NOT EXISTS 'QUEST_REWARD';
