-- ════════════════════════════════════════════════════════════════════════════
-- SCHEMA V2, PART 3 OF 3: TRADE                      (design: docs/schema-v2.md)
-- Offer + TradeRequest -> Trade
-- ════════════════════════════════════════════════════════════════════════════
--
-- HIGH RISK, AND SEPARABLE ON PURPOSE. Nothing in parts 1 or 2 depends on this
-- file. If it is not ready at the go/no-go, delete this folder, put the Offer
-- and TradeRequest models back into schema.prisma from git (with SwapCode,
-- Message and Review pointing at TradeRequest), and the rest ships without it.
--
-- ── HOW AN OFFER IS PAIRED WITH THE TRADE IT BECAME ─────────────────────────
-- Nothing ever linked them. The accept route (api/offers/[id]) moves the offer
-- to ACCEPTED and creates the TradeRequest IN THE SAME TRANSACTION, copying
-- sender, receiver and the listing across, so the pair is: same sender, same
-- receiver, Offer.postId = TradeRequest.requestedItemId, offer ACCEPTED, and
-- Offer.updatedAt within 5 s of TradeRequest.createdAt (live maximum 0.24 s).
-- The offered item is NOT part of the key: 22 legacy Leaves-only offers carry
-- an empty item list, and 7 of them did become trades. Each trade takes its
-- closest such offer; the pairing is then asserted to be one-to-one.
--
-- ── WHICH ID A DEAL KEEPS ───────────────────────────────────────────────────
-- A deal with a TradeRequest keeps the TradeRequest's id: Message, Review,
-- SwapCode, AdminAction (TRADE), Notification ("trade", "meetup") and the
-- ledger all point at it. The Offer's id moves to `legacyOfferId`. A deal that
-- never became a trade keeps the Offer's id as `id` and in `legacyOfferId`.
--
-- ── THE LEDGER ──────────────────────────────────────────────────────────────
-- Fee HOLD / RELEASE rows carried `offerId`. Each is rewritten to the Trade the
-- offer became (tradeId = Trade.id WHERE legacyOfferId = offerId) and the
-- column dropped. No amount, user or type changes, so every ledger sum is
-- unchanged; the escrow cross-check is restated over Trade and asserted equal.

-- ── 0. Preconditions ────────────────────────────────────────────────────────
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM "Offer" WHERE json_typeof("offeredItems"::json) <> 'array' OR json_array_length("offeredItems"::json) > 1;
  IF n > 0 THEN RAISE EXCEPTION 'schema v2 trade: % offers name more than one item (or are not a JSON list)', n; END IF;

  SELECT count(*) INTO n FROM "Offer" o
   WHERE json_array_length(o."offeredItems"::json) = 1
     AND NOT EXISTS (SELECT 1 FROM "Item" i WHERE i."id" = o."offeredItems"::json -> 0 ->> 'id');
  IF n > 0 THEN RAISE EXCEPTION 'schema v2 trade: % offers name an item that does not exist', n; END IF;

  SELECT count(*) INTO n FROM "LeafTransaction" WHERE "offerId" IS NOT NULL AND "tradeId" IS NOT NULL;
  IF n > 0 THEN RAISE EXCEPTION 'schema v2 trade: % ledger rows carry both offerId and tradeId', n; END IF;
END $$;

-- ── 1. The pairing ──────────────────────────────────────────────────────────
CREATE TEMP TABLE "v2_offer_trade" ON COMMIT DROP AS
SELECT DISTINCT ON (t."id") t."id" AS "tradeId", o."id" AS "offerId"
  FROM "TradeRequest" t
  JOIN "Offer" o
    ON o."senderId" = t."senderId"
   AND o."receiverId" = t."receiverId"
   AND o."postId" = t."requestedItemId"
   AND o."status" = 'ACCEPTED'
   AND abs(extract(epoch FROM (o."updatedAt" - t."createdAt"))) < 5
 ORDER BY t."id", abs(extract(epoch FROM (o."updatedAt" - t."createdAt"))), o."id";

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) - count(DISTINCT "offerId") INTO n FROM "v2_offer_trade";
  IF n > 0 THEN RAISE EXCEPTION 'schema v2 trade: % offers paired with more than one trade', n; END IF;

  -- A paired offer that named an item must have named THIS trade's item.
  SELECT count(*) INTO n FROM "v2_offer_trade" m
    JOIN "Offer" o ON o."id" = m."offerId" JOIN "TradeRequest" t ON t."id" = m."tradeId"
   WHERE json_array_length(o."offeredItems"::json) = 1 AND (o."offeredItems"::json -> 0 ->> 'id') <> t."offeredItemId";
  IF n > 0 THEN RAISE EXCEPTION 'schema v2 trade: % pairs disagree about the offered item', n; END IF;

  -- The bridge fee was copied to the trade at accept; the two must agree.
  SELECT count(*) INTO n FROM "v2_offer_trade" m
    JOIN "Offer" o ON o."id" = m."offerId" JOIN "TradeRequest" t ON t."id" = m."tradeId"
   WHERE o."bridgeFeeLeaves" IS DISTINCT FROM t."bridgeFeeLeaves";
  IF n > 0 THEN RAISE EXCEPTION 'schema v2 trade: % pairs disagree about the bridge fee', n; END IF;
END $$;

-- ── 2. Trade ────────────────────────────────────────────────────────────────
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "legacyOfferId" TEXT,
    "senderId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "requestedItemId" TEXT NOT NULL,
    "offeredItemId" TEXT,
    "offerStatus" "OfferStatus",
    "status" "TradeStatus",
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tradeCreatedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "hiddenBySender" BOOLEAN NOT NULL DEFAULT false,
    "hiddenByReceiver" BOOLEAN NOT NULL DEFAULT false,
    "safeZoneHubId" TEXT,
    "meetupHubId" TEXT,
    "meetupAt" TIMESTAMP(3),
    "meetupNote" VARCHAR(200),
    "meetupProposedBySender" BOOLEAN,
    "meetupAgreedAt" TIMESTAMP(3),
    "offeredLeaves" INTEGER,
    "bridgeFeeLeaves" INTEGER,
    "bridgeFeePaidBySender" BOOLEAN,
    "offeredBracket" INTEGER,
    "targetBracket" INTEGER,
    "consentAt" TIMESTAMP(3),
    "policyVersion" VARCHAR(32),

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id"),
    -- See the Trade model note.
    CONSTRAINT "Trade_has_a_phase_check" CHECK ("offerStatus" IS NOT NULL OR "status" IS NOT NULL),
    CONSTRAINT "Trade_trade_phase_check" CHECK (("status" IS NULL) = ("tradeCreatedAt" IS NULL)),
    CONSTRAINT "Trade_trade_has_item_check" CHECK ("status" IS NULL OR "offeredItemId" IS NOT NULL)
);

-- 2a. Every TradeRequest, with its offer's half when it had one. Where both
-- sides hold a column (message, offeredLeaves, bridgeFeeLeaves), the TRADE's
-- copy wins: it is what settlement and cancellation read. updatedAt is the
-- later of the two.
INSERT INTO "Trade" ("id", "legacyOfferId", "senderId", "receiverId", "requestedItemId", "offeredItemId",
                     "offerStatus", "status", "message", "createdAt", "tradeCreatedAt", "updatedAt", "completedAt",
                     "hiddenBySender", "hiddenByReceiver", "safeZoneHubId", "meetupHubId", "meetupAt", "meetupNote",
                     "meetupProposedBySender", "meetupAgreedAt", "offeredLeaves", "bridgeFeeLeaves", "bridgeFeePaidBySender",
                     "offeredBracket", "targetBracket", "consentAt", "policyVersion")
SELECT t."id", o."id", t."senderId", t."receiverId", t."requestedItemId", t."offeredItemId",
       o."status", t."status", t."message", coalesce(o."createdAt", t."createdAt"), t."createdAt",
       greatest(t."updatedAt", o."updatedAt"), t."completedAt",
       t."hiddenBySender", t."hiddenByReceiver", t."safeZoneHubId", t."meetupHubId", t."meetupAt", t."meetupNote",
       t."meetupProposedBySender", t."meetupAgreedAt", t."offeredLeaves", t."bridgeFeeLeaves", t."bridgeFeePaidBySender",
       o."offeredBracket", o."targetBracket", o."consentAt", o."policyVersion"
  FROM "TradeRequest" t
  LEFT JOIN "v2_offer_trade" m ON m."tradeId" = t."id"
  LEFT JOIN "Offer" o ON o."id" = m."offerId";

-- 2b. Every offer that never became a trade: still pending, declined,
-- withdrawn, expired, or a legacy Leaves-only offer accepted before accepts
-- created trades.
INSERT INTO "Trade" ("id", "legacyOfferId", "senderId", "receiverId", "requestedItemId", "offeredItemId",
                     "offerStatus", "status", "message", "createdAt", "tradeCreatedAt", "updatedAt",
                     "offeredLeaves", "bridgeFeeLeaves", "offeredBracket", "targetBracket", "consentAt", "policyVersion")
SELECT o."id", o."id", o."senderId", o."receiverId", o."postId", o."offeredItems"::json -> 0 ->> 'id',
       o."status", NULL, o."message", o."createdAt", NULL, o."updatedAt",
       o."offeredLeaves", o."bridgeFeeLeaves", o."offeredBracket", o."targetBracket", o."consentAt", o."policyVersion"
  FROM "Offer" o
 WHERE NOT EXISTS (SELECT 1 FROM "v2_offer_trade" m WHERE m."offerId" = o."id");

DO $$
DECLARE trades int; offers int; paired int; got int; n int;
BEGIN
  SELECT count(*) INTO trades FROM "TradeRequest";
  SELECT count(*) INTO offers FROM "Offer";
  SELECT count(*) INTO paired FROM "v2_offer_trade";
  SELECT count(*) INTO got FROM "Trade";
  IF got <> trades + offers - paired THEN
    RAISE EXCEPTION 'schema v2 trade: Trade has % rows, expected % (% trades + % offers - % paired)', got, trades + offers - paired, trades, offers, paired;
  END IF;
  SELECT count(*) INTO n FROM "Offer" o WHERE NOT EXISTS (SELECT 1 FROM "Trade" t WHERE t."legacyOfferId" = o."id");
  IF n > 0 THEN RAISE EXCEPTION 'schema v2 trade: % offers did not land in Trade', n; END IF;
END $$;

-- ── 3. The ledger's offer references become trade references ────────────────
UPDATE "LeafTransaction" l
   SET "tradeId" = t."id"
  FROM "Trade" t
 WHERE l."offerId" IS NOT NULL AND t."legacyOfferId" = l."offerId";

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM "LeafTransaction" WHERE "offerId" IS NOT NULL AND "tradeId" IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'schema v2 trade: % ledger rows point at an offer that is not in Trade', n; END IF;
  SELECT count(*) INTO n FROM "LeafTransaction" l WHERE l."tradeId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Trade" t WHERE t."id" = l."tradeId");
  IF n > 0 THEN RAISE EXCEPTION 'schema v2 trade: % ledger rows point at a trade that is not in Trade', n; END IF;
END $$;

-- The escrow cross-check, before and after, must agree: fees held on PENDING
-- proposer-pays offers plus fees on live trades.
DO $$
DECLARE before_held bigint; after_held bigint;
BEGIN
  SELECT coalesce((SELECT sum("bridgeFeeLeaves") FROM "Offer"
                    WHERE "status" = 'PENDING' AND "bridgeFeeLeaves" IS NOT NULL
                      AND "offeredBracket" IS NOT NULL AND "targetBracket" IS NOT NULL AND "offeredBracket" < "targetBracket"), 0)
       + coalesce((SELECT sum("bridgeFeeLeaves") FROM "TradeRequest" WHERE "status" IN ('PENDING', 'ACCEPTED', 'CONFIRMING')), 0)
    INTO before_held;
  SELECT coalesce((SELECT sum("bridgeFeeLeaves") FROM "Trade"
                    WHERE "status" IS NULL AND "offerStatus" = 'PENDING' AND "bridgeFeeLeaves" IS NOT NULL
                      AND "offeredBracket" IS NOT NULL AND "targetBracket" IS NOT NULL AND "offeredBracket" < "targetBracket"), 0)
       + coalesce((SELECT sum("bridgeFeeLeaves") FROM "Trade" WHERE "status" IN ('PENDING', 'ACCEPTED', 'CONFIRMING')), 0)
    INTO after_held;
  IF before_held <> after_held THEN RAISE EXCEPTION 'schema v2 trade: escrow held on rows was %, is now %', before_held, after_held; END IF;
END $$;

ALTER TABLE "LeafTransaction" DROP COLUMN "offerId";

-- ── 4. Repoint everything that referenced TradeRequest ──────────────────────
ALTER TABLE "Message" DROP CONSTRAINT "Message_tradeId_fkey";
ALTER TABLE "Review" DROP CONSTRAINT "Review_tradeId_fkey";
ALTER TABLE "SwapCode" DROP CONSTRAINT "SwapCode_tradeId_fkey";

DROP TABLE "TradeRequest";
DROP TABLE "Offer";

CREATE UNIQUE INDEX "Trade_legacyOfferId_key" ON "Trade"("legacyOfferId");
CREATE INDEX "Trade_senderId_idx" ON "Trade"("senderId");
CREATE INDEX "Trade_receiverId_idx" ON "Trade"("receiverId");
CREATE INDEX "Trade_offeredItemId_idx" ON "Trade"("offeredItemId");
CREATE INDEX "Trade_requestedItemId_idx" ON "Trade"("requestedItemId");
CREATE INDEX "Trade_safeZoneHubId_idx" ON "Trade"("safeZoneHubId");
CREATE INDEX "Trade_meetupHubId_idx" ON "Trade"("meetupHubId");
CREATE INDEX "Trade_offerStatus_createdAt_idx" ON "Trade"("offerStatus", "createdAt");
CREATE INDEX "Trade_status_idx" ON "Trade"("status");

ALTER TABLE "Trade" ADD CONSTRAINT "Trade_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_requestedItemId_fkey" FOREIGN KEY ("requestedItemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_offeredItemId_fkey" FOREIGN KEY ("offeredItemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_safeZoneHubId_fkey" FOREIGN KEY ("safeZoneHubId") REFERENCES "SafeZoneHub"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_meetupHubId_fkey" FOREIGN KEY ("meetupHubId") REFERENCES "SafeZoneHub"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Message" ADD CONSTRAINT "Message_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Review" ADD CONSTRAINT "Review_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SwapCode" ADD CONSTRAINT "SwapCode_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE CASCADE ON UPDATE CASCADE;
