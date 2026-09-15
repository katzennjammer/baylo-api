-- POSTGRES BASELINE. The whole schema in one file, and the only migration.
--
-- WHY A NEW BASELINE (2026-09-15)
--   Baylo moved from MariaDB 10.4 (XAMPP) to Postgres (Supabase). The MySQL
--   chain -- 20260906000000_baseline plus ten migrations -- is MySQL DDL
--   (backticks, ENUM columns, DATETIME(3)) and cannot run on Postgres, and
--   migration_lock.toml names exactly one provider, so the two chains cannot
--   coexist. That chain is preserved verbatim under
--   prisma/migrations-archive-mysql/ and in git history.
--
--   Generated with:
--     prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
--
-- WHAT IS DIFFERENT FROM THE MYSQL SCHEMA, ON PURPOSE
--   Twenty-five extra @@index declarations. InnoDB creates an index on every
--   foreign-key column implicitly; Postgres does not, and Prisma on Postgres
--   does not either. Without them a fresh Postgres database would have had 30
--   secondary indexes where the live MySQL database had 55, and every hot join
--   (Item.userId, Message.senderId/receiverId, TradeRequest.senderId/receiverId,
--   ...) would have been a sequential scan. They are declared in schema.prisma
--   under the comment "FK-backing indexes" so the schema stays the source of
--   truth. Counted: 55 CREATE INDEX here, 55 KEY in the last mysqldump.
--
-- NEVER RUN THIS AGAINST A POPULATED DATABASE. Every statement assumes an
-- empty public schema. Data was moved separately (see SETUP.md, "Migrating
-- from MySQL").
--
-- AUTHORING FUTURE MIGRATIONS AGAINST SUPABASE: `prisma migrate dev` needs a
-- shadow database it can CREATE, which the Supabase role cannot. Author with
--   prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script
-- (or --from-url against the live database), read it, save it under a new
-- timestamped directory, and apply with `prisma migrate deploy`.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TaskKind" AS ENUM ('VERIFY_ACCOUNT', 'COMPLETE_PROFILE', 'FIRST_LISTING', 'VERIFIED_SWAP', 'SAFEZONE_MEETUP');

-- CreateEnum
CREATE TYPE "Category" AS ENUM ('ELECTRONICS', 'CLOTHING', 'BAGS', 'BEAUTY', 'ACCESSORIES', 'FURNITURE', 'BOOKS', 'GAMING', 'SPORTS', 'BIKES', 'TOYS', 'TOOLS', 'MUSIC', 'ART', 'COLLECTIBLES', 'PETS', 'PLANTS', 'FOOD', 'SERVICES', 'OTHER');

-- CreateEnum
CREATE TYPE "Condition" AS ENUM ('NEW', 'LIKE_NEW', 'GOOD', 'FAIR', 'POOR');

-- CreateEnum
CREATE TYPE "ItemStatus" AS ENUM ('AVAILABLE', 'IN_TRADE', 'TRADED', 'OWNED', 'REMOVED');

-- CreateEnum
CREATE TYPE "TradeStatus" AS ENUM ('PENDING', 'ACCEPTED', 'CONFIRMING', 'REJECTED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('TRADE_REQUEST', 'TRADE_ACCEPTED', 'TRADE_REJECTED', 'TRADE_COMPLETED', 'TRADE_CANCELLED', 'NEW_MESSAGE', 'NEW_REVIEW', 'FOLLOW_REQUEST', 'FOLLOW_ACCEPTED', 'REPORT_RESOLVED', 'ID_VERIFICATION_APPROVED', 'ID_VERIFICATION_REJECTED', 'OFFER_EXPIRED', 'MEETUP_PROPOSED', 'MEETUP_AGREED');

-- CreateEnum
CREATE TYPE "FollowStatus" AS ENUM ('PENDING', 'ACCEPTED');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED');

-- CreateEnum
CREATE TYPE "LeafTxType" AS ENUM ('TRADE_SPEND', 'TRADE_RECEIVE', 'TASK_REWARD', 'SIGNUP_GRANT', 'CONTRACT_PAY', 'CONTRACT_COLLECT');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('PENDING_ACCEPT', 'ACTIVE', 'FULFILLED', 'DEFAULTED', 'DECLINED');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'MODERATOR', 'ADMIN', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "ReportTargetType" AS ENUM ('LISTING', 'USER', 'MESSAGE');

-- CreateEnum
CREATE TYPE "ReportCategory" AS ENUM ('SPAM', 'PROHIBITED_ITEM', 'SCAM_OR_FRAUD', 'HARASSMENT', 'COUNTERFEIT', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'REVIEWING', 'ACTIONED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "IdType" AS ENUM ('NATIONAL_ID', 'DRIVERS_LICENCE', 'PASSPORT', 'UMID', 'PHILHEALTH', 'POSTAL_ID', 'VOTERS_ID');

-- CreateEnum
CREATE TYPE "IdVerificationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "IdRejectionReason" AS ENUM ('BLURRY_PHOTO', 'NAME_MISMATCH', 'EXPIRED_ID', 'WRONG_DOCUMENT_TYPE', 'NOT_GOVERNMENT_ID');

-- CreateEnum
CREATE TYPE "AdminActionKind" AS ENUM ('REPORT_REVIEWING', 'REPORT_DISMISSED', 'REPORT_ACTIONED', 'LISTING_HIDDEN', 'LISTING_UNHIDDEN', 'USER_SUSPENDED', 'USER_UNSUSPENDED', 'HUB_CREATED', 'HUB_UPDATED', 'HUB_DEACTIVATED', 'HUB_REACTIVATED', 'ID_VERIFICATION_APPROVED', 'ID_VERIFICATION_REJECTED', 'ROLE_CHANGED', 'OFFER_EXPIRED');

-- CreateEnum
CREATE TYPE "AdminTargetType" AS ENUM ('REPORT', 'LISTING', 'USER', 'HUB', 'ID_VERIFICATION');

-- CreateEnum
CREATE TYPE "SafeZoneType" AS ENUM ('MALL', 'BARANGAY_HALL', 'POLICE_STATION', 'PUBLIC_PLAZA', 'TRANSPORT_HUB');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "signupGrantClaimed" BOOLEAN NOT NULL DEFAULT false,
    "dateOfBirth" DATE,
    "avatar" TEXT,
    "bio" TEXT,
    "location" TEXT,
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalTrades" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "premiumUntil" TIMESTAMP(3),
    "leaves" INTEGER NOT NULL DEFAULT 0,
    "lifetimeLeaves" INTEGER NOT NULL DEFAULT 0,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "suspendedAt" TIMESTAMP(3),
    "suspendedUntil" TIMESTAMP(3),
    "idVerifiedGrandfatheredAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Follow" (
    "id" TEXT NOT NULL,
    "status" "FollowStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "followerId" TEXT NOT NULL,
    "followeeId" TEXT NOT NULL,

    CONSTRAINT "Follow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailVerificationToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Item" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "images" TEXT NOT NULL,
    "category" "Category" NOT NULL,
    "condition" "Condition" NOT NULL,
    "valueLeaves" INTEGER,
    "suggestedLeaves" INTEGER,
    "valuationSource" VARCHAR(32),
    "revaluationCount" INTEGER NOT NULL DEFAULT 0,
    "status" "ItemStatus" NOT NULL DEFAULT 'AVAILABLE',
    "wantedItems" TEXT,
    "pickupLat" DOUBLE PRECISION,
    "pickupLng" DOUBLE PRECISION,
    "pickupAddress" TEXT,
    "moderationHiddenAt" TIMESTAMP(3),
    "imageHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemImageHash" (
    "itemId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "hash" VARCHAR(64) NOT NULL,

    CONSTRAINT "ItemImageHash_pkey" PRIMARY KEY ("itemId","position")
);

-- CreateTable
CREATE TABLE "TradeRequest" (
    "id" TEXT NOT NULL,
    "status" "TradeStatus" NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hiddenBySender" BOOLEAN NOT NULL DEFAULT false,
    "hiddenByReceiver" BOOLEAN NOT NULL DEFAULT false,
    "safeZoneHubId" TEXT,
    "meetupHubId" TEXT,
    "meetupAt" TIMESTAMP(3),
    "meetupNote" VARCHAR(200),
    "meetupProposedBySender" BOOLEAN,
    "meetupAgreedAt" TIMESTAMP(3),
    "senderId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "offeredItemId" TEXT NOT NULL,
    "requestedItemId" TEXT NOT NULL,
    "offeredLeaves" INTEGER,

    CONSTRAINT "TradeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "senderId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "tradeId" TEXT,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "message" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "link" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entityType" TEXT,
    "entityId" TEXT,
    "userId" TEXT NOT NULL,
    "actorId" TEXT,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewerId" TEXT NOT NULL,
    "revieweeId" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskCompletion" (
    "id" TEXT NOT NULL,
    "task" "TaskKind" NOT NULL,
    "refId" TEXT NOT NULL DEFAULT '',
    "leaves" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,

    CONSTRAINT "TaskCompletion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SwapConfirmationCode" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "codeSealed" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SwapConfirmationCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostLike" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostLike_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostComment" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommentLike" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommentLike_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "offeredItems" TEXT NOT NULL,
    "offeredLeaves" INTEGER,
    "message" TEXT,
    "status" "OfferStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeafTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "LeafTxType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "offerId" TEXT,
    "tradeId" TEXT,
    "contractId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeafTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeferredContract" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT,
    "offerId" TEXT,
    "debtorId" TEXT NOT NULL,
    "creditorId" TEXT NOT NULL,
    "amountLeaves" INTEGER NOT NULL,
    "amountPaidLeaves" INTEGER NOT NULL DEFAULT 0,
    "deadline" TIMESTAMP(3) NOT NULL,
    "status" "ContractStatus" NOT NULL DEFAULT 'PENDING_ACCEPT',
    "extensionUsed" BOOLEAN NOT NULL DEFAULT false,
    "extensionRequestedAt" TIMESTAMP(3),
    "extensionRequestedDeadline" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "defaultedAt" TIMESTAMP(3),

    CONSTRAINT "DeferredContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "targetType" "ReportTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "category" "ReportCategory" NOT NULL,
    "notes" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "openKey" VARCHAR(4),
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Block" (
    "id" TEXT NOT NULL,
    "blockerId" TEXT NOT NULL,
    "blockedId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Block_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdVerification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "idType" "IdType" NOT NULL,
    "idNumberHash" VARCHAR(64) NOT NULL,
    "claimKey" VARCHAR(64),
    "status" "IdVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" "IdRejectionReason",
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptCount" INTEGER NOT NULL,
    "imageUrl" TEXT,
    "imagePublicId" VARCHAR(255),
    "imageDeletedAt" TIMESTAMP(3),
    "imageDeleteFailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAction" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" "AdminActionKind" NOT NULL,
    "targetType" "AdminTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "reportId" TEXT,
    "reason" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SafeZoneHub" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "type" "SafeZoneType" NOT NULL,
    "address" VARCHAR(300) NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "city" VARCHAR(80) NOT NULL,
    "landmark" VARCHAR(200) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SafeZoneHub_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemSafeZone" (
    "itemId" TEXT NOT NULL,
    "hubId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItemSafeZone_pkey" PRIMARY KEY ("itemId","hubId")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_deletedAt_idx" ON "User"("deletedAt");

-- CreateIndex
CREATE INDEX "User_suspendedAt_idx" ON "User"("suspendedAt");

-- CreateIndex
CREATE INDEX "Follow_followeeId_idx" ON "Follow"("followeeId");

-- CreateIndex
CREATE UNIQUE INDEX "Follow_followerId_followeeId_key" ON "Follow"("followerId", "followeeId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_token_key" ON "PasswordResetToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "EmailVerificationToken_tokenHash_key" ON "EmailVerificationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "EmailVerificationToken_userId_idx" ON "EmailVerificationToken"("userId");

-- CreateIndex
CREATE INDEX "Item_status_moderationHiddenAt_idx" ON "Item"("status", "moderationHiddenAt");

-- CreateIndex
CREATE INDEX "Item_valuationSource_category_idx" ON "Item"("valuationSource", "category");

-- CreateIndex
CREATE INDEX "Item_userId_idx" ON "Item"("userId");

-- CreateIndex
CREATE INDEX "TradeRequest_senderId_idx" ON "TradeRequest"("senderId");

-- CreateIndex
CREATE INDEX "TradeRequest_receiverId_idx" ON "TradeRequest"("receiverId");

-- CreateIndex
CREATE INDEX "TradeRequest_offeredItemId_idx" ON "TradeRequest"("offeredItemId");

-- CreateIndex
CREATE INDEX "TradeRequest_requestedItemId_idx" ON "TradeRequest"("requestedItemId");

-- CreateIndex
CREATE INDEX "TradeRequest_safeZoneHubId_idx" ON "TradeRequest"("safeZoneHubId");

-- CreateIndex
CREATE INDEX "TradeRequest_meetupHubId_idx" ON "TradeRequest"("meetupHubId");

-- CreateIndex
CREATE INDEX "Message_senderId_idx" ON "Message"("senderId");

-- CreateIndex
CREATE INDEX "Message_receiverId_idx" ON "Message"("receiverId");

-- CreateIndex
CREATE INDEX "Message_tradeId_idx" ON "Message"("tradeId");

-- CreateIndex
CREATE INDEX "Notification_userId_idx" ON "Notification"("userId");

-- CreateIndex
CREATE INDEX "Notification_actorId_idx" ON "Notification"("actorId");

-- CreateIndex
CREATE INDEX "Review_reviewerId_idx" ON "Review"("reviewerId");

-- CreateIndex
CREATE INDEX "Review_revieweeId_idx" ON "Review"("revieweeId");

-- CreateIndex
CREATE UNIQUE INDEX "Review_tradeId_reviewerId_key" ON "Review"("tradeId", "reviewerId");

-- CreateIndex
CREATE INDEX "TaskCompletion_userId_idx" ON "TaskCompletion"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskCompletion_userId_task_refId_key" ON "TaskCompletion"("userId", "task", "refId");

-- CreateIndex
CREATE INDEX "SwapConfirmationCode_userId_idx" ON "SwapConfirmationCode"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SwapConfirmationCode_tradeId_userId_key" ON "SwapConfirmationCode"("tradeId", "userId");

-- CreateIndex
CREATE INDEX "PostLike_userId_idx" ON "PostLike"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PostLike_postId_userId_key" ON "PostLike"("postId", "userId");

-- CreateIndex
CREATE INDEX "PostComment_postId_idx" ON "PostComment"("postId");

-- CreateIndex
CREATE INDEX "PostComment_userId_idx" ON "PostComment"("userId");

-- CreateIndex
CREATE INDEX "PostComment_parentId_idx" ON "PostComment"("parentId");

-- CreateIndex
CREATE INDEX "CommentLike_userId_idx" ON "CommentLike"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CommentLike_commentId_userId_key" ON "CommentLike"("commentId", "userId");

-- CreateIndex
CREATE INDEX "Offer_postId_idx" ON "Offer"("postId");

-- CreateIndex
CREATE INDEX "Offer_senderId_idx" ON "Offer"("senderId");

-- CreateIndex
CREATE INDEX "Offer_receiverId_idx" ON "Offer"("receiverId");

-- CreateIndex
CREATE INDEX "LeafTransaction_userId_idx" ON "LeafTransaction"("userId");

-- CreateIndex
CREATE INDEX "LeafTransaction_userId_createdAt_idx" ON "LeafTransaction"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "LeafTransaction_userId_eventAt_idx" ON "LeafTransaction"("userId", "eventAt");

-- CreateIndex
CREATE INDEX "DeferredContract_debtorId_status_idx" ON "DeferredContract"("debtorId", "status");

-- CreateIndex
CREATE INDEX "DeferredContract_creditorId_status_idx" ON "DeferredContract"("creditorId", "status");

-- CreateIndex
CREATE INDEX "DeferredContract_status_deadline_idx" ON "DeferredContract"("status", "deadline");

-- CreateIndex
CREATE INDEX "DeferredContract_tradeId_idx" ON "DeferredContract"("tradeId");

-- CreateIndex
CREATE INDEX "DeferredContract_offerId_idx" ON "DeferredContract"("offerId");

-- CreateIndex
CREATE INDEX "Report_status_createdAt_idx" ON "Report"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Report_targetType_targetId_idx" ON "Report"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "Report_reporterId_idx" ON "Report"("reporterId");

-- CreateIndex
CREATE INDEX "Report_resolvedById_idx" ON "Report"("resolvedById");

-- CreateIndex
CREATE UNIQUE INDEX "Report_reporterId_targetType_targetId_openKey_key" ON "Report"("reporterId", "targetType", "targetId", "openKey");

-- CreateIndex
CREATE INDEX "Block_blockedId_idx" ON "Block"("blockedId");

-- CreateIndex
CREATE UNIQUE INDEX "Block_blockerId_blockedId_key" ON "Block"("blockerId", "blockedId");

-- CreateIndex
CREATE INDEX "IdVerification_userId_submittedAt_idx" ON "IdVerification"("userId", "submittedAt");

-- CreateIndex
CREATE INDEX "IdVerification_status_submittedAt_idx" ON "IdVerification"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "IdVerification_status_imagePublicId_idx" ON "IdVerification"("status", "imagePublicId");

-- CreateIndex
CREATE INDEX "IdVerification_reviewedById_idx" ON "IdVerification"("reviewedById");

-- CreateIndex
CREATE UNIQUE INDEX "IdVerification_claimKey_key" ON "IdVerification"("claimKey");

-- CreateIndex
CREATE INDEX "AdminAction_actorId_createdAt_idx" ON "AdminAction"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAction_targetType_targetId_idx" ON "AdminAction"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AdminAction_createdAt_idx" ON "AdminAction"("createdAt");

-- CreateIndex
CREATE INDEX "AdminAction_reportId_idx" ON "AdminAction"("reportId");

-- CreateIndex
CREATE INDEX "SafeZoneHub_isActive_city_idx" ON "SafeZoneHub"("isActive", "city");

-- CreateIndex
CREATE INDEX "ItemSafeZone_hubId_idx" ON "ItemSafeZone"("hubId");

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_followeeId_fkey" FOREIGN KEY ("followeeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailVerificationToken" ADD CONSTRAINT "EmailVerificationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemImageHash" ADD CONSTRAINT "ItemImageHash_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeRequest" ADD CONSTRAINT "TradeRequest_safeZoneHubId_fkey" FOREIGN KEY ("safeZoneHubId") REFERENCES "SafeZoneHub"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeRequest" ADD CONSTRAINT "TradeRequest_meetupHubId_fkey" FOREIGN KEY ("meetupHubId") REFERENCES "SafeZoneHub"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeRequest" ADD CONSTRAINT "TradeRequest_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeRequest" ADD CONSTRAINT "TradeRequest_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeRequest" ADD CONSTRAINT "TradeRequest_offeredItemId_fkey" FOREIGN KEY ("offeredItemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeRequest" ADD CONSTRAINT "TradeRequest_requestedItemId_fkey" FOREIGN KEY ("requestedItemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "TradeRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_revieweeId_fkey" FOREIGN KEY ("revieweeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "TradeRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskCompletion" ADD CONSTRAINT "TaskCompletion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SwapConfirmationCode" ADD CONSTRAINT "SwapConfirmationCode_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "TradeRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SwapConfirmationCode" ADD CONSTRAINT "SwapConfirmationCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostLike" ADD CONSTRAINT "PostLike_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostLike" ADD CONSTRAINT "PostLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostComment" ADD CONSTRAINT "PostComment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostComment" ADD CONSTRAINT "PostComment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostComment" ADD CONSTRAINT "PostComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "PostComment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentLike" ADD CONSTRAINT "CommentLike_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "PostComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentLike" ADD CONSTRAINT "CommentLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeafTransaction" ADD CONSTRAINT "LeafTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeferredContract" ADD CONSTRAINT "DeferredContract_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "TradeRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeferredContract" ADD CONSTRAINT "DeferredContract_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeferredContract" ADD CONSTRAINT "DeferredContract_debtorId_fkey" FOREIGN KEY ("debtorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeferredContract" ADD CONSTRAINT "DeferredContract_creditorId_fkey" FOREIGN KEY ("creditorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Block" ADD CONSTRAINT "Block_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Block" ADD CONSTRAINT "Block_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdVerification" ADD CONSTRAINT "IdVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdVerification" ADD CONSTRAINT "IdVerification_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAction" ADD CONSTRAINT "AdminAction_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAction" ADD CONSTRAINT "AdminAction_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemSafeZone" ADD CONSTRAINT "ItemSafeZone_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemSafeZone" ADD CONSTRAINT "ItemSafeZone_hubId_fkey" FOREIGN KEY ("hubId") REFERENCES "SafeZoneHub"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

