-- TradeRequest.completedAt: when settlement committed.
--
-- Nullable and additive, so it is safe to deploy from a branch: a checkout
-- whose client does not model the column simply never selects it. No
-- backfill -- trades completed before this column existed stay NULL, and the
-- only reader (the daily trade quests in @/lib/quests) looks at today alone.
ALTER TABLE "TradeRequest" ADD COLUMN "completedAt" TIMESTAMP(3);
