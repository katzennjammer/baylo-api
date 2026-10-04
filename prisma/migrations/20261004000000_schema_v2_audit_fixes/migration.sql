-- ════════════════════════════════════════════════════════════════════════════
-- SCHEMA V2, AUDIT FIXES                             (design: docs/schema-v2.md)
-- Small fixes from the read-only audit of 4 Oct 2026. Schema only: no row is
-- written, so no ledger figure can move.
-- ════════════════════════════════════════════════════════════════════════════
--
-- DEPENDS ON PART 1 (CORE) ONLY: ModerationCase is created there. Parts 2 and 3
-- (ledger, trade) may be held back without touching this file.
--
--   1  Two redundant indexes dropped. Each is the leading column of another
--      index on the same table, which serves every query it could:
--        LeafTransaction_userId_idx    <- (userId, createdAt), (userId, eventAt),
--                                         UNIQUE (userId, task, taskRefId)
--        ModerationCase_filedById_idx  <- UNIQUE (filedById, targetType, targetId, openKey)
--   2  ModerationCase.actionId -> AdminAction, RESTRICT. It was unique but a
--      plain string. An audit row is never deleted in the app, so the only
--      thing RESTRICT refuses is a cleanup that removes a decision while an
--      appeal against it still exists -- delete the appeal first.
--   3  Two CHECKs on Item that the write paths already obey:
--        a perishable has a trade window, and nothing else has one;
--        a pickup pin is both coordinates or neither, and an address only
--        comes with a pin. A pin WITHOUT an address stays legal: the API
--        accepts one (pickupAddress is optional in @/lib/validation).

-- ── 0. Preconditions ────────────────────────────────────────────────────────
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM "ModerationCase" c
   WHERE c."actionId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "AdminAction" a WHERE a."id" = c."actionId");
  IF n > 0 THEN RAISE EXCEPTION 'schema v2 audit fixes: % appeals name an AdminAction that does not exist', n; END IF;

  SELECT count(*) INTO n FROM "Item" WHERE "isPerishable" <> ("tradeWithinHours" IS NOT NULL);
  IF n > 0 THEN RAISE EXCEPTION 'schema v2 audit fixes: % items disagree on isPerishable vs tradeWithinHours', n; END IF;

  SELECT count(*) INTO n FROM "Item"
   WHERE ("pickupLat" IS NULL) <> ("pickupLng" IS NULL)
      OR ("pickupAddress" IS NOT NULL AND "pickupLat" IS NULL);
  IF n > 0 THEN RAISE EXCEPTION 'schema v2 audit fixes: % items have a half-set pickup', n; END IF;
END $$;

-- ── 1. Redundant indexes ────────────────────────────────────────────────────
DROP INDEX "LeafTransaction_userId_idx";
DROP INDEX "ModerationCase_filedById_idx";

-- ── 2. The appealed decision ────────────────────────────────────────────────
ALTER TABLE "ModerationCase" ADD CONSTRAINT "ModerationCase_actionId_fkey"
  FOREIGN KEY ("actionId") REFERENCES "AdminAction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 3. Item shape ───────────────────────────────────────────────────────────
ALTER TABLE "Item" ADD CONSTRAINT "Item_perishable_window_check"
  CHECK ("isPerishable" = ("tradeWithinHours" IS NOT NULL));
ALTER TABLE "Item" ADD CONSTRAINT "Item_pickup_shape_check"
  CHECK ((("pickupLat" IS NULL) = ("pickupLng" IS NULL)) AND ("pickupAddress" IS NULL OR "pickupLat" IS NOT NULL));
