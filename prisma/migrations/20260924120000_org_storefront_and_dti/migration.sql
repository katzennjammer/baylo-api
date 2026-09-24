-- MSME storefront profile + DTI registration number on Organization.
--
--   bannerUrl              the storefront's wide cover image (public upload)
--   description            the shop's tagline / pitch under the category line
--   dtiRegistrationNumber  as typed by the applicant, shown to the reviewer
--                          beside the business document; never validated
--                          against any DTI registry
--
-- ADDITIVE ONLY. Three nullable columns, no default, no backfill, no index, no
-- enum value -- so there is none of the enum hazard SETUP.md describes: a
-- `main` checkout whose client does not model these columns simply never
-- selects them. Every existing organisation reads as "no banner, no tagline,
-- no number on file", which the storefront and the admin page both render.
--
-- HAND-AUTHORED, NOT `migrate diff` OUTPUT, for the same reason as the last
-- few: the generated script carries unrelated live-vs-schema drift.

ALTER TABLE "Organization" ADD COLUMN "bannerUrl" TEXT;
ALTER TABLE "Organization" ADD COLUMN "description" VARCHAR(500);
ALTER TABLE "Organization" ADD COLUMN "dtiRegistrationNumber" VARCHAR(64);
