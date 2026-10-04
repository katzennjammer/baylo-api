-- ════════════════════════════════════════════════════════════════════════════
-- SCHEMA V2: BACKFILL Trade.completedAt                (design: docs/schema-v2.md)
-- ════════════════════════════════════════════════════════════════════════════
--
-- DEPENDS ON PART 3 (TRADE): the Trade table is created there. Hold this back
-- whenever the trade migration is held back.
--
-- completedAt was added on 25 Sep 2026 (20260925000000_trade_completed_at)
-- with no backfill, so every trade completed before then is COMPLETED with a
-- NULL completedAt: 12 rows in the 3 Oct backup. This fills those rows, and
-- ONLY those: the WHERE clause never touches a value settlement wrote.
--
-- THE SOURCE, in order:
--   1  the earliest ledger row that PAID something for this trade's
--      settlement (TASK_REWARD, TRADE_REWARD, TRADE_SPEND/RECEIVE,
--      BRIDGE_FEE_PAID; amount <> 0). A denied 0-Leaf task row is excluded:
--      it is stamped with the 24 Aug 2026 migration time, not the swap.
--   2  otherwise the trade's own updatedAt (3 of 12 rows on 3 Oct).
-- Both are approximations of "when settlement committed"; on the June/July
-- rows the ledger value is itself the trade's updatedAt, copied by the
-- August task backfill. Every value lands at or after tradeCreatedAt
-- (asserted below), and all are weeks old, so the daily trade quests -- the
-- only reader -- are unaffected.

UPDATE "Trade" t SET "completedAt" = COALESCE((
  SELECT min(l."eventAt") FROM "LeafTransaction" l
   WHERE l."tradeId" = t."id" AND l."amount" <> 0
     AND l."type" IN ('TASK_REWARD','TRADE_REWARD','TRADE_SPEND','TRADE_RECEIVE','BRIDGE_FEE_PAID')
), t."updatedAt")
WHERE t."status" = 'COMPLETED' AND t."completedAt" IS NULL;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM "Trade" WHERE "status" = 'COMPLETED' AND "completedAt" IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'schema v2 completedAt backfill: % COMPLETED trades still have no completedAt', n; END IF;

  SELECT count(*) INTO n FROM "Trade" WHERE "completedAt" < "tradeCreatedAt";
  IF n > 0 THEN RAISE EXCEPTION 'schema v2 completedAt backfill: % trades completed before they were created', n; END IF;
END $$;
