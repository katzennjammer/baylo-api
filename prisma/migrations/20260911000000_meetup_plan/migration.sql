-- The meetup PLAN: where and when the parties have arranged to meet, agreed
-- before the meeting rather than claimed after it.
--
-- `safeZoneHubId` on this table is NOT touched and is not reused. That column is
-- the CLAIM, and the SAFEZONE_MEETUP reward keys off `safeZoneHubId IS NOT NULL`
-- -- writing a plan into it would mint 10 Leaves the moment somebody merely
-- suggested a place. See the block on TradeRequest.meetupHubId in schema.prisma.
--
-- SAFE TO APPLY WITH TRADES IN FLIGHT. Five nullable columns and one foreign
-- key: no existing row is rewritten and no existing column changes type. Every
-- trade already open reads as "no plan", which is what it is.
--
-- The Notification enum gains two values AT THE END, which is the case MariaDB
-- can do with ALGORITHM=INPLACE rather than copying the table. Nothing reorders
-- and nothing is removed, so existing rows keep their meaning.

-- AlterTable
ALTER TABLE `TradeRequest` ADD COLUMN `meetupAgreedAt` DATETIME(3) NULL,
    ADD COLUMN `meetupAt` DATETIME(3) NULL,
    ADD COLUMN `meetupHubId` VARCHAR(191) NULL,
    ADD COLUMN `meetupNote` VARCHAR(200) NULL,
    ADD COLUMN `meetupProposedBySender` BOOLEAN NULL;

-- AlterTable
ALTER TABLE `Notification` MODIFY `type` ENUM('TRADE_REQUEST', 'TRADE_ACCEPTED', 'TRADE_REJECTED', 'TRADE_COMPLETED', 'TRADE_CANCELLED', 'NEW_MESSAGE', 'NEW_REVIEW', 'FOLLOW_REQUEST', 'FOLLOW_ACCEPTED', 'REPORT_RESOLVED', 'ID_VERIFICATION_APPROVED', 'ID_VERIFICATION_REJECTED', 'OFFER_EXPIRED', 'MEETUP_PROPOSED', 'MEETUP_AGREED') NOT NULL;

-- AddForeignKey
ALTER TABLE `TradeRequest` ADD CONSTRAINT `TradeRequest_meetupHubId_fkey` FOREIGN KEY (`meetupHubId`) REFERENCES `SafeZoneHub`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
