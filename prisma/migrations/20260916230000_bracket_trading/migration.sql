-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AdminActionKind" ADD VALUE 'LISTING_VALUE_APPROVED';
ALTER TYPE "AdminActionKind" ADD VALUE 'LISTING_VALUE_REJECTED';
ALTER TYPE "AdminActionKind" ADD VALUE 'TRADE_REWARD_REVERSED';
ALTER TYPE "AdminActionKind" ADD VALUE 'TRADE_CANCELLED';

-- AlterEnum
ALTER TYPE "AdminTargetType" ADD VALUE 'TRADE';

-- AlterEnum
ALTER TYPE "ItemStatus" ADD VALUE 'PENDING_REVIEW';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LeafTxType" ADD VALUE 'BRIDGE_FEE_HOLD';
ALTER TYPE "LeafTxType" ADD VALUE 'BRIDGE_FEE_RELEASE';
ALTER TYPE "LeafTxType" ADD VALUE 'BRIDGE_FEE_PAID';
ALTER TYPE "LeafTxType" ADD VALUE 'TRADE_REWARD';
ALTER TYPE "LeafTxType" ADD VALUE 'TRADE_REWARD_REVERSAL';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'LISTING_VALUE_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'LISTING_VALUE_REJECTED';

-- AlterEnum
ALTER TYPE "TaskKind" ADD VALUE 'FIRST_TRADE';

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "valueSetByUser" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Offer" ADD COLUMN     "bridgeFeeLeaves" INTEGER,
ADD COLUMN     "consentAt" TIMESTAMP(3),
ADD COLUMN     "offeredBracket" INTEGER,
ADD COLUMN     "policyVersion" VARCHAR(32),
ADD COLUMN     "targetBracket" INTEGER;

-- AlterTable
ALTER TABLE "TradeRequest" ADD COLUMN     "bridgeFeeLeaves" INTEGER;

-- Backfill: the listings whose owner already moved the value off the
-- suggestion under the old +/-25% band (9 rows on 16 Sep 2026) were user-set
-- in every sense that matters to the admin Listings page.
UPDATE "Item" SET "valueSetByUser" = true
WHERE "suggestedLeaves" IS NOT NULL AND "valueLeaves" IS NOT NULL AND "valueLeaves" <> "suggestedLeaves";
