-- Adds the VIP tier alongside the existing Premium one:
--
--   1. User.vipUntil -- same shape as the existing premiumUntil (nullable
--      DateTime, null or past = not subscribed). Gates acquiring an item at
--      VIP_MIN_BRACKET (9) or above; see isVip() in @/lib/premium and
--      enforcePremiumForListing() in @/lib/reputation-gate.
--
--   2. User.lastTierGrantAt -- the UTC calendar day the daily Premium/VIP
--      Leaves allowance was last paid. See claimDailyTierGrant() in
--      @/lib/tier-grant, the only writer.
--
--   3. LeafTxType.TIER_DAILY_GRANT -- the ledger row type for that daily
--      allowance. ALTER TYPE ... ADD VALUE cannot run inside a transaction
--      block on some Postgres versions, so it is its own statement, same as
--      the two migrations before it that add enum values. IF NOT EXISTS
--      makes it safe to re-run.
--
-- Nothing here renames or drops a column or a value: existing rows are valid
-- with both new columns NULL, and nothing currently reads TIER_DAILY_GRANT.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "vipUntil" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastTierGrantAt" TIMESTAMP(3);

ALTER TYPE "LeafTxType" ADD VALUE IF NOT EXISTS 'TIER_DAILY_GRANT';
