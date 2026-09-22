-- Organisations / SMMEs, and perishable listings with category matching.
--
-- ADDITIVE ONLY. Nothing here drops, renames or narrows an existing object.
-- Every new column on an existing table is either nullable or has a default,
-- so every row that already exists reads correctly the moment this lands and
-- the feature code is still on its branch.
--
-- HAND-AUTHORED, NOT `migrate diff` OUTPUT. The generated script also carried
-- two pre-existing drifts between the live database and the committed schema --
-- a DROP INDEX on UserAchievement and a default on Achievement.icon -- which
-- have nothing to do with this change and one of which is destructive. They are
-- deliberately left out; whoever owns that drift should land it on its own.

-- ── New enum types ──────────────────────────────────────────────────────────

CREATE TYPE "BusinessCategory" AS ENUM ('SARI_SARI', 'FOOD_AND_BEVERAGE', 'AGRICULTURE', 'HANDICRAFT', 'APPAREL', 'ELECTRONICS_REPAIR', 'SERVICES', 'RETAIL', 'COOPERATIVE', 'NONPROFIT', 'OTHER');

CREATE TYPE "OrgVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

CREATE TYPE "OrgRejectionReason" AS ENUM ('BLURRY_DOCUMENT', 'NAME_MISMATCH', 'EXPIRED_REGISTRATION', 'WRONG_DOCUMENT_TYPE', 'NOT_A_BUSINESS_DOCUMENT');

CREATE TYPE "OrgMemberRole" AS ENUM ('OWNER', 'STAFF');

CREATE TYPE "OrgMemberStatus" AS ENUM ('PENDING', 'ACTIVE');

CREATE TYPE "QuantityUnit" AS ENUM ('KG', 'PCS', 'LITERS');

-- ── New values on existing enums ────────────────────────────────────────────
--
-- THIS IS THE HALF THAT MUST LAND ON `main` BEFORE ANY CODE USES IT, and the
-- reason this migration is split from the feature branch at all. Prisma refuses
-- to read a row whose enum column holds a value the generated client does not
-- model, so the first item written as EXPIRED would turn every `main` checkout
-- into a 500 on the WHOLE Item table -- not on perishables, on the table. Same
-- for a CATEGORY_MATCH notification and the Notification table.
--
-- Adding the value here and writing it only from the feature branch is what
-- closes that window. See SETUP.md, "A migration deployed from a branch changes
-- the database for every branch", and scripts/check-new-enum-rows.ts.
--
-- Postgres 17 runs ALTER TYPE ... ADD VALUE inside Prisma's migration
-- transaction. It could not on older versions, which is why this reads as
-- unremarkable and is not.

ALTER TYPE "ItemStatus" ADD VALUE 'EXPIRED';

ALTER TYPE "NotificationType" ADD VALUE 'CATEGORY_MATCH';

-- ── User: the org-account discriminator ─────────────────────────────────────
--
-- FALSE ON EVERY EXISTING ROW, which is the correct answer for all of them:
-- every account that exists today is a person. See the note on the column.

ALTER TABLE "User" ADD COLUMN "isOrgAccount" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "User_isOrgAccount_idx" ON "User"("isOrgAccount");

-- ── Item: perishables, and what the owner wants back ────────────────────────
--
-- `lookingForCategories` is a Postgres array and arrays are NOT NULL-able in
-- Prisma's scalar-list mapping: existing rows get '{}', which is exactly the
-- "no preference stated" the matcher skips. There is no backfill to run.

ALTER TABLE "Item"
  ADD COLUMN "isPerishable"         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "quantity"             DOUBLE PRECISION,
  ADD COLUMN "quantityUnit"         "QuantityUnit",
  ADD COLUMN "tradeWithinHours"     INTEGER,
  ADD COLUMN "lookingForCategories" "Category"[];

-- The expiry sweep: unexpired perishables, oldest first.
CREATE INDEX "Item_isPerishable_status_createdAt_idx" ON "Item"("isPerishable", "status", "createdAt");

-- THE MATCHER'S INDEX, AND THE ONE PRISMA CANNOT DECLARE.
--
-- `lookingForCategories && ARRAY[...]` -- which is what Prisma's `hasSome`
-- compiles to -- is an array-overlap operator, and a B-tree cannot answer it.
-- Without this the matcher sequentially scans every AVAILABLE item on every
-- single listing creation, which is a full table scan on the hot write path.
-- GIN is the index type for the array operators; Prisma has no syntax for it,
-- so it is written here by hand and recorded in the schema's comment so the
-- next `migrate diff` does not look like it wants to drop it.
CREATE INDEX "Item_lookingForCategories_idx" ON "Item" USING GIN ("lookingForCategories");

-- ── Organization ────────────────────────────────────────────────────────────

CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "orgUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logoUrl" TEXT,
    "businessCategory" "BusinessCategory" NOT NULL,
    "verificationStatus" "OrgVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "businessDocUrl" TEXT,
    "businessDocPublicId" VARCHAR(255),
    "docDeletedAt" TIMESTAMP(3),
    "docDeleteFailedAt" TIMESTAMP(3),
    "rejectionReason" "OrgRejectionReason",
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- One organisation per backing account. See the note on orgUserId.
CREATE UNIQUE INDEX "Organization_orgUserId_key" ON "Organization"("orgUserId");

-- The admin queue: PENDING, oldest first.
CREATE INDEX "Organization_verificationStatus_createdAt_idx" ON "Organization"("verificationStatus", "createdAt");

-- The retry sweep: decided rows whose document is still on Cloudinary.
CREATE INDEX "Organization_verificationStatus_businessDocPublicId_idx" ON "Organization"("verificationStatus", "businessDocPublicId");

CREATE INDEX "Organization_reviewedById_idx" ON "Organization"("reviewedById");

-- ── OrganizationMember ──────────────────────────────────────────────────────

CREATE TABLE "OrganizationMember" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "OrgMemberRole" NOT NULL DEFAULT 'STAFF',
    "status" "OrgMemberStatus" NOT NULL DEFAULT 'PENDING',
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joinedAt" TIMESTAMP(3),

    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

-- "may this person act as this org" -- read on every org-context switch.
CREATE INDEX "OrganizationMember_userId_status_idx" ON "OrganizationMember"("userId", "status");

-- One membership per (org, person). The invite path relies on this to make a
-- repeat invitation a no-op rather than a second row.
CREATE UNIQUE INDEX "OrganizationMember_organizationId_userId_key" ON "OrganizationMember"("organizationId", "userId");

-- ── Foreign keys ────────────────────────────────────────────────────────────

-- Cascade: the backing row and the organisation are one thing.
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_orgUserId_fkey" FOREIGN KEY ("orgUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull: the decision outlives the staff account that made it.
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
