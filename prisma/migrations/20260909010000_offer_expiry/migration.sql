-- Offers end on their own.
--
-- ── WHY THIS IS A SECOND MIGRATION AND NOT AN EDIT TO THE FIRST ─────────────
--
-- These two statements were briefly appended to
-- 20260909000000_dpa_on_offer_and_withdrawn, and that was wrong: that migration
-- had already been applied, so editing it would have left the recorded checksum
-- describing a file that no longer existed, and the database holding three of
-- four steps with no record of the fourth being outstanding. A migration that
-- has run is history and does not get rewritten.
--
-- The observed state before this file: `Offer.status` had WITHDRAWN and not
-- EXPIRED; `Notification.type` was unchanged. Both statements below are
-- therefore genuinely outstanding rather than re-runs.
--
-- ── BOTH ARE APPENDS, NEVER REORDERINGS ────────────────────────────────────
--
-- MariaDB stores an ENUM as an index into its value list, so appending a value
-- is free and reordering silently rewrites the meaning of every existing row.
-- Each list below is the baseline's order verbatim with one new member at the
-- end. Do not sort them.
--
-- NO BACKFILL AND NO DATA CHANGE. Expiry is derived from `Offer.createdAt`
-- rather than stored per row — see the long note in @/lib/offers — so there is
-- no deadline to compute for an existing offer. The lazy sweep works it out on
-- the next read that measures a balance.

ALTER TABLE `Offer`
  MODIFY `status` ENUM('PENDING', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED') NOT NULL DEFAULT 'PENDING';

ALTER TABLE `Notification`
  MODIFY `type` ENUM(
    'TRADE_REQUEST', 'TRADE_ACCEPTED', 'TRADE_REJECTED', 'TRADE_COMPLETED',
    'TRADE_CANCELLED', 'NEW_MESSAGE', 'NEW_REVIEW', 'FOLLOW_REQUEST',
    'FOLLOW_ACCEPTED', 'REPORT_RESOLVED', 'ID_VERIFICATION_APPROVED',
    'ID_VERIFICATION_REJECTED', 'OFFER_EXPIRED'
  ) NOT NULL;
