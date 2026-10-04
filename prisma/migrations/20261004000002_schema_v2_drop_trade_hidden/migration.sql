-- ════════════════════════════════════════════════════════════════════════════
-- SCHEMA V2: DROP Trade.hiddenBySender / hiddenByReceiver (design: docs/schema-v2.md)
-- ════════════════════════════════════════════════════════════════════════════
--
-- DEPENDS ON PART 3 (TRADE). Hold this back whenever the trade migration is
-- held back.
--
-- Per-party "remove from my list" flags. Only the web dashboard ever set them
-- (PATCH /api/trades/[id] {action: "hide"}); the app never did, and on 4 Oct
-- 2026 no row on live had either one true. The hide action now answers 410.
-- Dropping them also removes the one per-party pair left on Trade (SwapCode
-- already holds per-party state as child rows).
--
-- The precondition refuses if anyone has hidden a trade since, because that
-- hide would silently come undone: decide first, then rerun.

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM "Trade" WHERE "hiddenBySender" OR "hiddenByReceiver";
  IF n > 0 THEN RAISE EXCEPTION 'schema v2 drop hidden: % trades are hidden by a party; dropping the columns would unhide them', n; END IF;
END $$;

ALTER TABLE "Trade" DROP COLUMN "hiddenBySender",
                    DROP COLUMN "hiddenByReceiver";
