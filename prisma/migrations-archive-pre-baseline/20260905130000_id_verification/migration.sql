-- Government ID verification.
--
-- Gates two acts and only two: POST /api/items, and proposing a
-- DeferredContract. Browsing, searching, messaging, liking, commenting and --
-- most importantly -- ACCEPTING a trade or a DPA stay open to everyone, because
-- blocking an accept strands a counterparty in a trade they did not cause.
--
-- WHAT THIS MIGRATION DOES, in one sentence each:
--   1  creates `IdVerification`, one row per submitted ID
--   2  adds `User.idVerifiedGrandfatheredAt`
--   3  stamps every account that exists TODAY as grandfathered
--   4  extends the two admin-audit enums with the two new decisions
--   5  extends NotificationType so the submitter can be told the outcome
--
-- ADDITIVE THROUGHOUT. No existing column is dropped, narrowed or rewritten;
-- the only UPDATE is step 3, which writes a column created two statements
-- earlier and which no code before this migration reads. Running it against a
-- server still serving the previous build changes nothing that build can see.
--
-- ROLLBACK, in full:
--     DROP TABLE `IdVerification`;
--     ALTER TABLE `User` DROP COLUMN `idVerifiedGrandfatheredAt`;
--   -- the two enum widenings are harmless to leave in place; to undo them,
--   -- re-run the two MODIFY statements below without the added members. They
--   -- will fail if any row has taken one of the new values, which is correct.
--
-- Backup taken before this ran:
--   D:\BAYLO\baylo-backup-pre-id-verification-20260905.sql   (145.9 KB, verified)

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The table.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- THE COLLATION IS EXPLICIT AND HAS TO BE. This database's default is
-- utf8mb4_general_ci while every Prisma-created table, `User` among them, is
-- utf8mb4_unicode_ci. An unqualified CREATE TABLE takes the DATABASE default,
-- and the two foreign keys below then fail with errno 150 -- MySQL will not
-- point a key at a column whose collation differs from its own. The same lesson
-- as ItemImageHash, one migration ago.
--
-- ON THE COLUMN SET, and what is deliberately NOT here:
--   there is no `idNumber`     -- only `idNumberHash`, a SHA-256 digest
--   there is no `fullName`     -- the reviewer compares against `User.name`
--   there is no `dateOfBirth`  -- `User.dateOfBirth` already holds it
-- Every one of those would be a copy of a government document living in a table
-- that outlives the review, which is the thing this feature exists not to do.
CREATE TABLE `IdVerification` (
  `id`     VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,

  `idType` ENUM(
    'NATIONAL_ID','DRIVERS_LICENCE','PASSPORT','UMID',
    'PHILHEALTH','POSTAL_ID','VOTERS_ID'
  ) NOT NULL,

  -- SHA-256 hex of the NORMALISED number (upper-cased, non-alphanumerics
  -- stripped). 64 chars exactly; VARCHAR rather than CHAR to match the
  -- generator's output for every other hash column in this schema.
  `idNumberHash` VARCHAR(64) NOT NULL,

  -- The live claim on that ID. A COPY of idNumberHash while PENDING or
  -- APPROVED, NULL once REJECTED. MySQL treats NULLs as distinct in a unique
  -- index, so the index below permits one live claim per ID and any number of
  -- rejected rows carrying the same digest.
  --
  -- NOT A GENERATED COLUMN. It was going to be; MariaDB 10.4.32 hangs the whole
  -- server on an UPDATE to a table with a STORED generated column inside a
  -- unique index. Report.openKey carries the long version of that note.
  `claimKey` VARCHAR(64) NULL,

  `status`          ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  `rejectionReason` ENUM(
    'BLURRY_PHOTO','NAME_MISMATCH','EXPIRED_ID',
    'WRONG_DOCUMENT_TYPE','NOT_GOVERNMENT_ID'
  ) NULL,

  `reviewedById` VARCHAR(191) NULL,
  `reviewedAt`   DATETIME(3)  NULL,

  `submittedAt`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  -- Which attempt this was, 1..3. A snapshot for display; the cap itself is
  -- enforced by COUNT(*) over this user's rows at submission time.
  `attemptCount` INT NOT NULL,

  -- Populated only between submission and decision. `imageUrl` is nulled inside
  -- the decision transaction; `imagePublicId` survives until Cloudinary
  -- confirms the destroy, because it IS the delete key. A decided row with a
  -- non-null imagePublicId is exactly the retry set.
  `imageUrl`      TEXT         NULL,
  `imagePublicId` VARCHAR(255) NULL,

  `imageDeletedAt`      DATETIME(3) NULL,
  `imageDeleteFailedAt` DATETIME(3) NULL,

  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),

  -- One live claim per ID number. The rule the whole table exists for.
  UNIQUE INDEX `IdVerification_claimKey_key` (`claimKey`),
  -- "this user's submissions, newest first" -- the status screen and the cap.
  INDEX `IdVerification_userId_submittedAt_idx` (`userId`, `submittedAt`),
  -- The queue: PENDING, oldest first.
  INDEX `IdVerification_status_submittedAt_idx` (`status`, `submittedAt`),
  -- The retry sweep: decided rows whose image is still up there.
  INDEX `IdVerification_status_imagePublicId_idx` (`status`, `imagePublicId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CASCADE on the subject: deleting the account deletes its submissions, which
-- is what FREES THE ID for re-use -- the spec's "on account DELETION the hash
-- frees" is this line plus the explicit deleteMany() in deleteAccount(). (Baylo
-- anonymises rather than row-deletes users, so in practice the explicit delete
-- is the one that runs; this is the backstop.)
ALTER TABLE `IdVerification`
  ADD CONSTRAINT `IdVerification_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL on the reviewer, matching Report.resolvedById: the decision outlives
-- the staff account that made it. AdminAction still names the actor, and its
-- own actorId is RESTRICT, so the identity is not actually lost -- only this
-- convenience pointer is.
ALTER TABLE `IdVerification`
  ADD CONSTRAINT `IdVerification_reviewedById_fkey`
  FOREIGN KEY (`reviewedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The grandfather stamp.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A COLUMN ON `User` AND NOT A SYNTHETIC `IdVerification` ROW. A synthetic row
-- would need an idType and an idNumberHash that do not exist, would have to be
-- excluded from the uniqueness index by hand, and would read in the admin queue
-- as a decision somebody made. This says what actually happened: nobody looked
-- at an ID for this account, and here is when we decided not to.
ALTER TABLE `User` ADD COLUMN `idVerifiedGrandfatheredAt` DATETIME(3) NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Grandfather every account that exists right now.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- THE `WHERE` IS THE IMPORTANT PART OF THIS STATEMENT. Without it this is a
-- blanket UPDATE with no predicate; with it, it is idempotent -- re-running the
-- migration stamps nobody twice, and an account created a minute after it runs
-- is NOT stamped, which is the whole point. `deletedAt IS NULL` keeps retired
-- accounts out: a deleted account has no posting to keep doing.
--
-- 12 rows on this database as of 2026-09-05 (the spec said 8; two are
-- zzmobileauth-* test accounts and two more were created since that count).
-- Every one of them keeps posting without submitting anything, which is the
-- requirement. To make a specific tester walk the real flow, clear their stamp:
--     UPDATE `User` SET `idVerifiedGrandfatheredAt` = NULL WHERE `email` = '...';
UPDATE `User`
   SET `idVerifiedGrandfatheredAt` = NOW(3)
 WHERE `idVerifiedGrandfatheredAt` IS NULL
   AND `deletedAt` IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The audit vocabulary.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Every ID decision writes an AdminAction, like every other moderation act, so
-- both enums have to learn the new words. MODIFY rather than anything cleverer
-- because MySQL enums are a column type, not a shared object -- these two
-- statements rewrite no rows (adding members at the END of an enum is a
-- metadata-only change; inserting them in the middle would renumber every
-- existing value, which is why they go last).
ALTER TABLE `AdminAction` MODIFY `action` ENUM(
  'REPORT_REVIEWING','REPORT_DISMISSED','REPORT_ACTIONED',
  'LISTING_HIDDEN','LISTING_UNHIDDEN',
  'USER_SUSPENDED','USER_UNSUSPENDED',
  'HUB_CREATED','HUB_UPDATED','HUB_DEACTIVATED','HUB_REACTIVATED',
  'ID_VERIFICATION_APPROVED','ID_VERIFICATION_REJECTED'
) NOT NULL;

ALTER TABLE `AdminAction` MODIFY `targetType` ENUM(
  'REPORT','LISTING','USER','HUB','ID_VERIFICATION'
) NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Telling the submitter what happened.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A decision the user is not told about is a decision they discover by tapping
-- Post again three days later. Two members and not one, because the two
-- outcomes are not variants of each other: the approval unlocks posting and
-- says so, the rejection carries a specific fix and a remaining-attempts count.
-- A client that wants to style them differently should not have to parse the
-- message text to tell them apart.
--
-- Appended at the END of the enum, like step 4 and for the same reason:
-- inserting in the middle renumbers every existing value.
ALTER TABLE `Notification` MODIFY `type` ENUM(
  'TRADE_REQUEST','TRADE_ACCEPTED','TRADE_REJECTED','TRADE_COMPLETED','TRADE_CANCELLED',
  'NEW_MESSAGE','NEW_REVIEW','FOLLOW_REQUEST','FOLLOW_ACCEPTED','REPORT_RESOLVED',
  'ID_VERIFICATION_APPROVED','ID_VERIFICATION_REJECTED'
) NOT NULL;
