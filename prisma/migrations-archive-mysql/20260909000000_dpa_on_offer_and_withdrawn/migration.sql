-- Deferred agreements against an OFFER, and a sender-side withdrawal.
--
-- WRITTEN BY HAND, NOT BY `prisma migrate dev`, and deliberately: the live
-- database is the one described in the project notes, and `migrate dev` would
-- have applied this to it as a side effect of generating it. Generate, read,
-- then apply — see the report that accompanies this change.
--
-- EVERY STATEMENT IS ADDITIVE OR WIDENING. Nothing here drops a column, drops a
-- row, or narrows a type, so an existing row cannot fail it:
--
--   1. `tradeId` NOT NULL -> NULL is a widening. Every existing contract keeps
--      the trade it has; only new offer-born rows use the nullability.
--   2. `offerId` arrives NULL on every existing row, which is correct — every
--      contract that exists today was proposed against a trade.
--   3. `WITHDRAWN` is appended to the END of the enum. MariaDB stores an ENUM
--      as an index into its value list, so appending is free and reordering
--      would silently rewrite every existing row's meaning. Do not sort these.
--
-- The reverse is NOT symmetrical and there is no down migration: dropping
-- `offerId` would destroy the only link an offer-born contract has to what it
-- was about, and re-imposing NOT NULL on `tradeId` would fail on exactly those
-- rows. Rolling this back means deciding what happens to that data first.

-- 1 ── a contract need not have a trade any more.
ALTER TABLE `DeferredContract` MODIFY `tradeId` VARCHAR(191) NULL;

-- 2 ── it may have an offer instead.
ALTER TABLE `DeferredContract` ADD COLUMN `offerId` VARCHAR(191) NULL;

CREATE INDEX `DeferredContract_offerId_idx` ON `DeferredContract`(`offerId`);

ALTER TABLE `DeferredContract`
  ADD CONSTRAINT `DeferredContract_offerId_fkey`
  FOREIGN KEY (`offerId`) REFERENCES `Offer`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 3 ── the sender can retract an offer.
--
-- APPENDED, never reordered. See the note above.
ALTER TABLE `Offer`
  MODIFY `status` ENUM('PENDING', 'ACCEPTED', 'DECLINED', 'WITHDRAWN') NOT NULL DEFAULT 'PENDING';
