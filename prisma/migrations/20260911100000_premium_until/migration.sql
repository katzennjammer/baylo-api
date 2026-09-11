-- User.premiumUntil: the premium subscription's expiry. Null or past = not
-- subscribed. Read by isPremium() in @/lib/premium, which gates ACQUIRING an
-- item in value bracket 7 or above, by proposing or by accepting an offer of
-- one (@/lib/brackets).
--
-- Nothing writes it yet -- Play Billing has no Console account to test against
-- -- so it is set by hand with scripts/set-premium.ps1.
--
-- SAFE TO APPLY LIVE: one nullable column, no default, no index. Every existing
-- user reads as "not subscribed", which is what they are.

-- AlterTable
ALTER TABLE `User` ADD COLUMN `premiumUntil` DATETIME(3) NULL;
