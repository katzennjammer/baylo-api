-- BASELINE. This is the whole schema in one file, and the only migration.
--
-- WHY THE CHAIN WAS SQUASHED (2026-09-06)
--   The old 19-migration chain could not build a database from empty. `init`
--   created six tables; the very next migration, pasa_leaves_non_monetary,
--   altered `User.points`, `Offer` and `WalletTransaction` -- none of which any
--   migration ever created. Nine of the schema's 25 tables (Follow, Offer,
--   LeafTransaction, PostLike, PostComment, CommentLike, TaskCompletion,
--   PasswordResetToken, SwapConfirmationCode) had only ever reached a database
--   through `prisma db push`, so `migrate deploy` on a fresh clone died on the
--   second migration every time. The chain also carried one-off data repairs
--   pinned to row ids from one developer's laptop, which would never have been
--   meaningful anywhere else.
--
--   Generated with:
--     prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
--
--   The pre-squash chain is preserved in git history and archived under
--   prisma/migrations-archive-pre-baseline/ if you ever need to read it.
--
-- EXISTING DATABASES were baselined, not rebuilt: their _prisma_migrations rows
-- were replaced with a single row for this migration via
--   prisma migrate resolve --applied 20260906000000_baseline
-- which records it as applied WITHOUT executing any of the SQL below. Nothing
-- here has ever run against a populated Baylo database, and nothing here is
-- safe to run against one -- every statement assumes an empty schema.
--
-- SIX INDEXES were added to schema.prisma while writing this file (User
-- deletedAt / suspendedAt, Item status+moderationHiddenAt / valuationSource+
-- category, AdminAction reportId, Report resolvedById). All six existed in the
-- production database, created by raw CREATE INDEX in the old chain, but had
-- never been declared in the schema -- so a schema-generated baseline silently
-- dropped them. They are declared now; the schema is the source of truth again.
--
-- COLLATION is spelled out on all 25 tables (utf8mb4_unicode_ci) rather than
-- inherited. A database whose default is utf8mb4_general_ci -- which is what
-- XAMPP gives you -- would otherwise produce tables whose foreign keys fail
-- with errno 150 against the unicode_ci columns they point at.

-- CreateTable
CREATE TABLE `User` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `password` VARCHAR(191) NULL,
    `isVerified` BOOLEAN NOT NULL DEFAULT false,
    `signupGrantClaimed` BOOLEAN NOT NULL DEFAULT false,
    `dateOfBirth` DATE NULL,
    `avatar` VARCHAR(191) NULL,
    `bio` TEXT NULL,
    `location` VARCHAR(191) NULL,
    `rating` DOUBLE NOT NULL DEFAULT 0,
    `totalTrades` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,
    `leaves` INTEGER NOT NULL DEFAULT 0,
    `lifetimeLeaves` INTEGER NOT NULL DEFAULT 0,
    `role` ENUM('USER', 'MODERATOR', 'ADMIN') NOT NULL DEFAULT 'USER',
    `suspendedAt` DATETIME(3) NULL,
    `suspendedUntil` DATETIME(3) NULL,
    `idVerifiedGrandfatheredAt` DATETIME(3) NULL,

    UNIQUE INDEX `User_email_key`(`email`),
    INDEX `User_deletedAt_idx`(`deletedAt`),
    INDEX `User_suspendedAt_idx`(`suspendedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Follow` (
    `id` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'ACCEPTED') NOT NULL DEFAULT 'PENDING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `followerId` VARCHAR(191) NOT NULL,
    `followeeId` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `Follow_followerId_followeeId_key`(`followerId`, `followeeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RefreshToken` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `familyId` VARCHAR(191) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revokedAt` DATETIME(3) NULL,

    UNIQUE INDEX `RefreshToken_tokenHash_key`(`tokenHash`),
    INDEX `RefreshToken_userId_idx`(`userId`),
    INDEX `RefreshToken_familyId_idx`(`familyId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PasswordResetToken` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `token` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PasswordResetToken_token_key`(`token`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmailVerificationToken` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `EmailVerificationToken_tokenHash_key`(`tokenHash`),
    INDEX `EmailVerificationToken_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Item` (
    `id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` TEXT NOT NULL,
    `images` TEXT NOT NULL,
    `category` ENUM('ELECTRONICS', 'CLOTHING', 'BAGS', 'BEAUTY', 'ACCESSORIES', 'FURNITURE', 'BOOKS', 'GAMING', 'SPORTS', 'BIKES', 'TOYS', 'TOOLS', 'MUSIC', 'ART', 'COLLECTIBLES', 'PETS', 'PLANTS', 'FOOD', 'SERVICES', 'OTHER') NOT NULL,
    `condition` ENUM('NEW', 'LIKE_NEW', 'GOOD', 'FAIR', 'POOR') NOT NULL,
    `valueLeaves` INTEGER NULL,
    `suggestedLeaves` INTEGER NULL,
    `valuationSource` VARCHAR(32) NULL,
    `revaluationCount` INTEGER NOT NULL DEFAULT 0,
    `status` ENUM('AVAILABLE', 'IN_TRADE', 'TRADED', 'OWNED', 'REMOVED') NOT NULL DEFAULT 'AVAILABLE',
    `wantedItems` TEXT NULL,
    `pickupLat` DOUBLE NULL,
    `pickupLng` DOUBLE NULL,
    `pickupAddress` TEXT NULL,
    `moderationHiddenAt` DATETIME(3) NULL,
    `imageHash` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,

    INDEX `Item_status_moderationHiddenAt_idx`(`status`, `moderationHiddenAt`),
    INDEX `Item_valuationSource_category_idx`(`valuationSource`, `category`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ItemImageHash` (
    `itemId` VARCHAR(191) NOT NULL,
    `position` INTEGER NOT NULL,
    `hash` VARCHAR(64) NOT NULL,

    PRIMARY KEY (`itemId`, `position`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TradeRequest` (
    `id` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'ACCEPTED', 'CONFIRMING', 'REJECTED', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `message` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `hiddenBySender` BOOLEAN NOT NULL DEFAULT false,
    `hiddenByReceiver` BOOLEAN NOT NULL DEFAULT false,
    `safeZoneHubId` VARCHAR(191) NULL,
    `senderId` VARCHAR(191) NOT NULL,
    `receiverId` VARCHAR(191) NOT NULL,
    `offeredItemId` VARCHAR(191) NOT NULL,
    `requestedItemId` VARCHAR(191) NOT NULL,
    `offeredLeaves` INTEGER NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Message` (
    `id` VARCHAR(191) NOT NULL,
    `content` TEXT NOT NULL,
    `read` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `senderId` VARCHAR(191) NOT NULL,
    `receiverId` VARCHAR(191) NOT NULL,
    `tradeId` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Notification` (
    `id` VARCHAR(191) NOT NULL,
    `type` ENUM('TRADE_REQUEST', 'TRADE_ACCEPTED', 'TRADE_REJECTED', 'TRADE_COMPLETED', 'TRADE_CANCELLED', 'NEW_MESSAGE', 'NEW_REVIEW', 'FOLLOW_REQUEST', 'FOLLOW_ACCEPTED', 'REPORT_RESOLVED', 'ID_VERIFICATION_APPROVED', 'ID_VERIFICATION_REJECTED') NOT NULL,
    `message` VARCHAR(191) NOT NULL,
    `read` BOOLEAN NOT NULL DEFAULT false,
    `link` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `entityType` VARCHAR(191) NULL,
    `entityId` VARCHAR(191) NULL,
    `userId` VARCHAR(191) NOT NULL,
    `actorId` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Review` (
    `id` VARCHAR(191) NOT NULL,
    `rating` INTEGER NOT NULL,
    `comment` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `reviewerId` VARCHAR(191) NOT NULL,
    `revieweeId` VARCHAR(191) NOT NULL,
    `tradeId` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `Review_tradeId_reviewerId_key`(`tradeId`, `reviewerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaskCompletion` (
    `id` VARCHAR(191) NOT NULL,
    `task` ENUM('VERIFY_ACCOUNT', 'COMPLETE_PROFILE', 'FIRST_LISTING', 'VERIFIED_SWAP', 'SAFEZONE_MEETUP') NOT NULL,
    `refId` VARCHAR(191) NOT NULL DEFAULT '',
    `leaves` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `userId` VARCHAR(191) NOT NULL,

    INDEX `TaskCompletion_userId_idx`(`userId`),
    UNIQUE INDEX `TaskCompletion_userId_task_refId_key`(`userId`, `task`, `refId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SwapConfirmationCode` (
    `id` VARCHAR(191) NOT NULL,
    `tradeId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `codeHash` VARCHAR(191) NOT NULL,
    `used` BOOLEAN NOT NULL DEFAULT false,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `SwapConfirmationCode_tradeId_userId_key`(`tradeId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PostLike` (
    `id` VARCHAR(191) NOT NULL,
    `postId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PostLike_postId_userId_key`(`postId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PostComment` (
    `id` VARCHAR(191) NOT NULL,
    `postId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `content` TEXT NOT NULL,
    `parentId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CommentLike` (
    `id` VARCHAR(191) NOT NULL,
    `commentId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `CommentLike_commentId_userId_key`(`commentId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Offer` (
    `id` VARCHAR(191) NOT NULL,
    `postId` VARCHAR(191) NOT NULL,
    `senderId` VARCHAR(191) NOT NULL,
    `receiverId` VARCHAR(191) NOT NULL,
    `offeredItems` TEXT NOT NULL,
    `offeredLeaves` INTEGER NULL,
    `message` TEXT NULL,
    `status` ENUM('PENDING', 'ACCEPTED', 'DECLINED') NOT NULL DEFAULT 'PENDING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LeafTransaction` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `type` ENUM('TRADE_SPEND', 'TRADE_RECEIVE', 'TASK_REWARD', 'SIGNUP_GRANT', 'CONTRACT_PAY', 'CONTRACT_COLLECT') NOT NULL,
    `amount` INTEGER NOT NULL,
    `description` VARCHAR(191) NOT NULL,
    `offerId` VARCHAR(191) NULL,
    `tradeId` VARCHAR(191) NULL,
    `contractId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `eventAt` DATETIME(3) NOT NULL,

    INDEX `LeafTransaction_userId_idx`(`userId`),
    INDEX `LeafTransaction_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `LeafTransaction_userId_eventAt_idx`(`userId`, `eventAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DeferredContract` (
    `id` VARCHAR(191) NOT NULL,
    `tradeId` VARCHAR(191) NOT NULL,
    `debtorId` VARCHAR(191) NOT NULL,
    `creditorId` VARCHAR(191) NOT NULL,
    `amountLeaves` INTEGER NOT NULL,
    `amountPaidLeaves` INTEGER NOT NULL DEFAULT 0,
    `deadline` DATETIME(3) NOT NULL,
    `status` ENUM('PENDING_ACCEPT', 'ACTIVE', 'FULFILLED', 'DEFAULTED', 'DECLINED') NOT NULL DEFAULT 'PENDING_ACCEPT',
    `extensionUsed` BOOLEAN NOT NULL DEFAULT false,
    `extensionRequestedAt` DATETIME(3) NULL,
    `extensionRequestedDeadline` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `acceptedAt` DATETIME(3) NULL,
    `fulfilledAt` DATETIME(3) NULL,
    `defaultedAt` DATETIME(3) NULL,

    INDEX `DeferredContract_debtorId_status_idx`(`debtorId`, `status`),
    INDEX `DeferredContract_creditorId_status_idx`(`creditorId`, `status`),
    INDEX `DeferredContract_status_deadline_idx`(`status`, `deadline`),
    INDEX `DeferredContract_tradeId_idx`(`tradeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Report` (
    `id` VARCHAR(191) NOT NULL,
    `reporterId` VARCHAR(191) NOT NULL,
    `targetType` ENUM('LISTING', 'USER', 'MESSAGE') NOT NULL,
    `targetId` VARCHAR(191) NOT NULL,
    `category` ENUM('SPAM', 'PROHIBITED_ITEM', 'SCAM_OR_FRAUD', 'HARASSMENT', 'COUNTERFEIT', 'OTHER') NOT NULL,
    `notes` TEXT NULL,
    `status` ENUM('OPEN', 'REVIEWING', 'ACTIONED', 'DISMISSED') NOT NULL DEFAULT 'OPEN',
    `openKey` VARCHAR(4) NULL,
    `resolvedById` VARCHAR(191) NULL,
    `resolvedAt` DATETIME(3) NULL,
    `resolutionNote` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Report_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `Report_targetType_targetId_idx`(`targetType`, `targetId`),
    INDEX `Report_reporterId_idx`(`reporterId`),
    INDEX `Report_resolvedById_idx`(`resolvedById`),
    UNIQUE INDEX `Report_reporterId_targetType_targetId_openKey_key`(`reporterId`, `targetType`, `targetId`, `openKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Block` (
    `id` VARCHAR(191) NOT NULL,
    `blockerId` VARCHAR(191) NOT NULL,
    `blockedId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Block_blockedId_idx`(`blockedId`),
    UNIQUE INDEX `Block_blockerId_blockedId_key`(`blockerId`, `blockedId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `IdVerification` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `idType` ENUM('NATIONAL_ID', 'DRIVERS_LICENCE', 'PASSPORT', 'UMID', 'PHILHEALTH', 'POSTAL_ID', 'VOTERS_ID') NOT NULL,
    `idNumberHash` VARCHAR(64) NOT NULL,
    `claimKey` VARCHAR(64) NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `rejectionReason` ENUM('BLURRY_PHOTO', 'NAME_MISMATCH', 'EXPIRED_ID', 'WRONG_DOCUMENT_TYPE', 'NOT_GOVERNMENT_ID') NULL,
    `reviewedById` VARCHAR(191) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `submittedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `attemptCount` INTEGER NOT NULL,
    `imageUrl` TEXT NULL,
    `imagePublicId` VARCHAR(255) NULL,
    `imageDeletedAt` DATETIME(3) NULL,
    `imageDeleteFailedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `IdVerification_userId_submittedAt_idx`(`userId`, `submittedAt`),
    INDEX `IdVerification_status_submittedAt_idx`(`status`, `submittedAt`),
    INDEX `IdVerification_status_imagePublicId_idx`(`status`, `imagePublicId`),
    UNIQUE INDEX `IdVerification_claimKey_key`(`claimKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AdminAction` (
    `id` VARCHAR(191) NOT NULL,
    `actorId` VARCHAR(191) NOT NULL,
    `action` ENUM('REPORT_REVIEWING', 'REPORT_DISMISSED', 'REPORT_ACTIONED', 'LISTING_HIDDEN', 'LISTING_UNHIDDEN', 'USER_SUSPENDED', 'USER_UNSUSPENDED', 'HUB_CREATED', 'HUB_UPDATED', 'HUB_DEACTIVATED', 'HUB_REACTIVATED', 'ID_VERIFICATION_APPROVED', 'ID_VERIFICATION_REJECTED') NOT NULL,
    `targetType` ENUM('REPORT', 'LISTING', 'USER', 'HUB', 'ID_VERIFICATION') NOT NULL,
    `targetId` VARCHAR(191) NOT NULL,
    `reportId` VARCHAR(191) NULL,
    `reason` TEXT NOT NULL,
    `detail` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AdminAction_actorId_createdAt_idx`(`actorId`, `createdAt`),
    INDEX `AdminAction_targetType_targetId_idx`(`targetType`, `targetId`),
    INDEX `AdminAction_createdAt_idx`(`createdAt`),
    INDEX `AdminAction_reportId_idx`(`reportId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SafeZoneHub` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `type` ENUM('MALL', 'BARANGAY_HALL', 'POLICE_STATION', 'PUBLIC_PLAZA', 'TRANSPORT_HUB') NOT NULL,
    `address` VARCHAR(300) NOT NULL,
    `latitude` DOUBLE NOT NULL,
    `longitude` DOUBLE NOT NULL,
    `city` VARCHAR(80) NOT NULL,
    `landmark` VARCHAR(200) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SafeZoneHub_isActive_city_idx`(`isActive`, `city`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ItemSafeZone` (
    `itemId` VARCHAR(191) NOT NULL,
    `hubId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ItemSafeZone_hubId_idx`(`hubId`),
    PRIMARY KEY (`itemId`, `hubId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Follow` ADD CONSTRAINT `Follow_followerId_fkey` FOREIGN KEY (`followerId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Follow` ADD CONSTRAINT `Follow_followeeId_fkey` FOREIGN KEY (`followeeId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RefreshToken` ADD CONSTRAINT `RefreshToken_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EmailVerificationToken` ADD CONSTRAINT `EmailVerificationToken_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Item` ADD CONSTRAINT `Item_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ItemImageHash` ADD CONSTRAINT `ItemImageHash_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `Item`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TradeRequest` ADD CONSTRAINT `TradeRequest_safeZoneHubId_fkey` FOREIGN KEY (`safeZoneHubId`) REFERENCES `SafeZoneHub`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TradeRequest` ADD CONSTRAINT `TradeRequest_senderId_fkey` FOREIGN KEY (`senderId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TradeRequest` ADD CONSTRAINT `TradeRequest_receiverId_fkey` FOREIGN KEY (`receiverId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TradeRequest` ADD CONSTRAINT `TradeRequest_offeredItemId_fkey` FOREIGN KEY (`offeredItemId`) REFERENCES `Item`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TradeRequest` ADD CONSTRAINT `TradeRequest_requestedItemId_fkey` FOREIGN KEY (`requestedItemId`) REFERENCES `Item`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Message` ADD CONSTRAINT `Message_senderId_fkey` FOREIGN KEY (`senderId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Message` ADD CONSTRAINT `Message_receiverId_fkey` FOREIGN KEY (`receiverId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Message` ADD CONSTRAINT `Message_tradeId_fkey` FOREIGN KEY (`tradeId`) REFERENCES `TradeRequest`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Notification` ADD CONSTRAINT `Notification_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Notification` ADD CONSTRAINT `Notification_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Review` ADD CONSTRAINT `Review_reviewerId_fkey` FOREIGN KEY (`reviewerId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Review` ADD CONSTRAINT `Review_revieweeId_fkey` FOREIGN KEY (`revieweeId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Review` ADD CONSTRAINT `Review_tradeId_fkey` FOREIGN KEY (`tradeId`) REFERENCES `TradeRequest`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TaskCompletion` ADD CONSTRAINT `TaskCompletion_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SwapConfirmationCode` ADD CONSTRAINT `SwapConfirmationCode_tradeId_fkey` FOREIGN KEY (`tradeId`) REFERENCES `TradeRequest`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SwapConfirmationCode` ADD CONSTRAINT `SwapConfirmationCode_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PostLike` ADD CONSTRAINT `PostLike_postId_fkey` FOREIGN KEY (`postId`) REFERENCES `Item`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PostLike` ADD CONSTRAINT `PostLike_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PostComment` ADD CONSTRAINT `PostComment_postId_fkey` FOREIGN KEY (`postId`) REFERENCES `Item`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PostComment` ADD CONSTRAINT `PostComment_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PostComment` ADD CONSTRAINT `PostComment_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `PostComment`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CommentLike` ADD CONSTRAINT `CommentLike_commentId_fkey` FOREIGN KEY (`commentId`) REFERENCES `PostComment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CommentLike` ADD CONSTRAINT `CommentLike_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Offer` ADD CONSTRAINT `Offer_postId_fkey` FOREIGN KEY (`postId`) REFERENCES `Item`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Offer` ADD CONSTRAINT `Offer_senderId_fkey` FOREIGN KEY (`senderId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Offer` ADD CONSTRAINT `Offer_receiverId_fkey` FOREIGN KEY (`receiverId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LeafTransaction` ADD CONSTRAINT `LeafTransaction_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DeferredContract` ADD CONSTRAINT `DeferredContract_tradeId_fkey` FOREIGN KEY (`tradeId`) REFERENCES `TradeRequest`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DeferredContract` ADD CONSTRAINT `DeferredContract_debtorId_fkey` FOREIGN KEY (`debtorId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DeferredContract` ADD CONSTRAINT `DeferredContract_creditorId_fkey` FOREIGN KEY (`creditorId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Report` ADD CONSTRAINT `Report_reporterId_fkey` FOREIGN KEY (`reporterId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Report` ADD CONSTRAINT `Report_resolvedById_fkey` FOREIGN KEY (`resolvedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Block` ADD CONSTRAINT `Block_blockerId_fkey` FOREIGN KEY (`blockerId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Block` ADD CONSTRAINT `Block_blockedId_fkey` FOREIGN KEY (`blockedId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `IdVerification` ADD CONSTRAINT `IdVerification_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `IdVerification` ADD CONSTRAINT `IdVerification_reviewedById_fkey` FOREIGN KEY (`reviewedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AdminAction` ADD CONSTRAINT `AdminAction_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AdminAction` ADD CONSTRAINT `AdminAction_reportId_fkey` FOREIGN KEY (`reportId`) REFERENCES `Report`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ItemSafeZone` ADD CONSTRAINT `ItemSafeZone_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `Item`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ItemSafeZone` ADD CONSTRAINT `ItemSafeZone_hubId_fkey` FOREIGN KEY (`hubId`) REFERENCES `SafeZoneHub`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

