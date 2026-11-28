-- Automatic ID check (29 Nov 2026). Owner-approved after the defense: ID
-- validation is decided by the system, an admin only sees the rare case the
-- system could not decide on a user's last attempt.
--
-- ADDITIVE ONLY: two rejection reasons and four nullable columns. No data is
-- changed; rows decided by an admin before this keep NULL in the new columns.

-- Postgres needs each new enum value in its own statement; they cannot be used
-- in the same transaction they are added in, and nothing here uses them.
ALTER TYPE "IdRejectionReason" ADD VALUE IF NOT EXISTS 'NUMBER_MISMATCH';
ALTER TYPE "IdRejectionReason" ADD VALUE IF NOT EXISTS 'UNDERAGE';

-- What the automatic check concluded, and why. Check OUTCOMES only (pass /
-- fail / unknown per check, scores): never the text read from the card.
ALTER TABLE "IdVerification" ADD COLUMN "autoDecision"   TEXT;
ALTER TABLE "IdVerification" ADD COLUMN "autoConfidence" DOUBLE PRECISION;
ALTER TABLE "IdVerification" ADD COLUMN "autoChecks"     JSONB;
ALTER TABLE "IdVerification" ADD COLUMN "autoCheckedAt"  TIMESTAMP(3);
