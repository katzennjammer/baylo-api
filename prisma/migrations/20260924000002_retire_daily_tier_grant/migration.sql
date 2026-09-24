-- Retires the daily Premium/VIP Leaves allowance. It was dropped from the
-- Premium perk list before Play Billing existed to actually sell a
-- subscription, and confirmed to have paid out to nobody: zero
-- LeafTransaction rows of type TIER_DAILY_GRANT exist on the live database.
-- Safe to drop the column outright rather than leave it -- there is no data
-- behind it to lose.
--
-- The LeafTxType.TIER_DAILY_GRANT enum VALUE is not dropped here: Postgres
-- cannot cheaply remove one value from an enum type (it would require
-- rebuilding the type and every column that uses it), and this repo's own
-- convention for a retired concept is to leave the value in place and say so
-- in schema.prisma -- see TaskKind.VERIFIED_SWAP for the precedent.

ALTER TABLE "User" DROP COLUMN IF EXISTS "lastTierGrantAt";
