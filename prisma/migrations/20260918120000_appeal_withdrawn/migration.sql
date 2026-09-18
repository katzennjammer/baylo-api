-- Listing appeals: the owner deleting the listing closes the appeal as
-- WITHDRAWN (18 Sep 2026). Additive only. Authored by hand: one enum value,
-- which is all `migrate diff` would have produced once the unmodelled
-- Achievement tables (see the note in schema.prisma) were stripped from it.

-- AlterEnum
ALTER TYPE "ListingAppealStatus" ADD VALUE 'WITHDRAWN';
