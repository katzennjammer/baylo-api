-- Value rejections and listing appeals (18 Sep 2026).
--
-- Authored with `migrate diff --from-config-datasource` against live, then
-- EDITED: the diff also proposed dropping "Achievement", "UserAchievement" and
-- the "AchievementCriterion" enum, which exist in the live database with rows
-- and are not modelled in prisma/schema.prisma (they were never in this
-- repository's history). Those statements were removed by hand. This file is
-- additive only: three new enums, five enum values, one nullable column, one
-- table.
--
-- The schema half lands on main first (SETUP.md); nothing writes any of these
-- values until main can read them.

-- CreateEnum
CREATE TYPE "ValueRejectionReason" AS ENUM ('OVERVALUED_FOR_CONDITION', 'ABOVE_MARKET', 'WRONG_CATEGORY', 'PHOTOS_DO_NOT_SUPPORT_VALUE', 'OTHER');

-- CreateEnum
CREATE TYPE "ListingAppealKind" AS ENUM ('VALUE_REJECTION', 'MODERATION_HIDE');

-- CreateEnum
CREATE TYPE "ListingAppealStatus" AS ENUM ('OPEN', 'UPHELD', 'OVERTURNED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AdminActionKind" ADD VALUE 'LISTING_APPEAL_UPHELD';
ALTER TYPE "AdminActionKind" ADD VALUE 'LISTING_APPEAL_OVERTURNED';

-- AlterEnum
ALTER TYPE "AdminTargetType" ADD VALUE 'LISTING_APPEAL';

-- AlterEnum
ALTER TYPE "ItemStatus" ADD VALUE 'VALUE_REJECTED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'LISTING_HIDDEN';
ALTER TYPE "NotificationType" ADD VALUE 'LISTING_APPEAL_UPHELD';
ALTER TYPE "NotificationType" ADD VALUE 'LISTING_APPEAL_OVERTURNED';

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "valueRejectionReason" "ValueRejectionReason";

-- CreateTable
CREATE TABLE "ListingAppeal" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "kind" "ListingAppealKind" NOT NULL,
    "status" "ListingAppealStatus" NOT NULL DEFAULT 'OPEN',
    "message" VARCHAR(300) NOT NULL,
    "actionId" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingAppeal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ListingAppeal_actionId_key" ON "ListingAppeal"("actionId");

-- CreateIndex
CREATE INDEX "ListingAppeal_status_createdAt_idx" ON "ListingAppeal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ListingAppeal_itemId_idx" ON "ListingAppeal"("itemId");

-- CreateIndex
CREATE INDEX "ListingAppeal_ownerId_idx" ON "ListingAppeal"("ownerId");

-- CreateIndex
CREATE INDEX "ListingAppeal_decidedById_idx" ON "ListingAppeal"("decidedById");

-- AddForeignKey
ALTER TABLE "ListingAppeal" ADD CONSTRAINT "ListingAppeal_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingAppeal" ADD CONSTRAINT "ListingAppeal_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingAppeal" ADD CONSTRAINT "ListingAppeal_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
