-- ════════════════════════════════════════════════════════════════════════════
-- SCHEMA V2, PART 1 OF 3: CORE                       (design: docs/schema-v2.md)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Everything in the 34 -> 25 redesign EXCEPT the two high-risk merges, which
-- are their own migrations so they can be held back at the go/no-go:
--   20261003000001_schema_v2_ledger  TaskCompletion -> LeafTransaction
--   20261003000002_schema_v2_trade   Offer + TradeRequest -> Trade
--
-- THIS FILE MOVES DATA, not only DDL. Each merge is CREATE new -> INSERT ...
-- SELECT from old -> ASSERT the counts -> DROP old, in one file, so a
-- `migrate deploy` either lands the whole step or (Postgres runs a multi-
-- statement migration as one implicit transaction) none of it. Every
-- assertion is a RAISE EXCEPTION, which aborts and rolls back.
--
-- Every statement is UNQUALIFIED ("Item", never public."Item") and there is no
-- catalog lookup by name, so the same file runs against a scratch schema
-- through search_path -- see scripts/schema-v2/build-scratch.ts.
--
-- ROWS THAT DO NOT SURVIVE (docs/schema-v2.md section 2c): non-owner
-- OrganizationMember rows and the ORG_INVITE notifications pointing at them;
-- the DeferredContract table; CommentLike and ConversationHide (asserted
-- empty); Item boost columns, Item.imageHash (a duplicate of ItemImage
-- position 0, asserted); PasswordResetToken rows whose
-- email matches no user.

-- ── 0. Preconditions. Refuse to run on data this file was not written for. ──
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM "CommentLike";
  IF n > 0 THEN RAISE EXCEPTION 'schema v2: CommentLike has % rows; it was dropped as empty. Decide before migrating.', n; END IF;

  SELECT count(*) INTO n FROM "ConversationHide";
  IF n > 0 THEN RAISE EXCEPTION 'schema v2: ConversationHide has % rows; it was dropped as empty. Decide before migrating.', n; END IF;

  SELECT count(*) INTO n FROM "DeferredContract" WHERE "status" NOT IN ('FULFILLED', 'DECLINED');
  IF n > 0 THEN RAISE EXCEPTION 'schema v2: % DeferredContract rows are still open; the table is dropped.', n; END IF;

  SELECT count(*) INTO n FROM "Organization" o
   WHERE (SELECT count(*) FROM "OrganizationMember" m
           WHERE m."organizationId" = o."id" AND m."role" = 'OWNER' AND m."status" = 'ACTIVE') <> 1;
  IF n > 0 THEN RAISE EXCEPTION 'schema v2: % organisations do not have exactly one ACTIVE OWNER', n; END IF;

  SELECT count(*) INTO n FROM "Item" WHERE json_typeof("images"::json) <> 'array';
  IF n > 0 THEN RAISE EXCEPTION 'schema v2: % Item.images values are not JSON arrays', n; END IF;

  SELECT count(*) INTO n FROM "Item" i, json_array_elements(i."images"::json) e WHERE json_typeof(e) <> 'string';
  IF n > 0 THEN RAISE EXCEPTION 'schema v2: % Item.images elements are not strings', n; END IF;

  SELECT count(*) INTO n FROM "ItemImageHash" h JOIN "Item" i ON i."id" = h."itemId"
   WHERE h."position" >= json_array_length(i."images"::json);
  IF n > 0 THEN RAISE EXCEPTION 'schema v2: % ItemImageHash rows point past the end of Item.images', n; END IF;

  -- Item.imageHash is dropped because it duplicates ItemImageHash position 0.
  -- Prove it before throwing it away.
  SELECT count(*) INTO n FROM "Item" i
   WHERE i."imageHash" IS NOT NULL
     AND i."imageHash" IS DISTINCT FROM (SELECT h."hash" FROM "ItemImageHash" h WHERE h."itemId" = i."id" AND h."position" = 0);
  IF n > 0 THEN RAISE EXCEPTION 'schema v2: % Item.imageHash values are not the position-0 ItemImageHash', n; END IF;
END $$;

-- ── 1. New enums ────────────────────────────────────────────────────────────
CREATE TYPE "AuthTokenType" AS ENUM ('REFRESH', 'PASSWORD_RESET', 'EMAIL_VERIFICATION');
CREATE TYPE "ModerationCaseType" AS ENUM ('REPORT', 'LISTING_APPEAL');
CREATE TYPE "ModerationCaseStatus" AS ENUM ('OPEN', 'REVIEWING', 'ACTIONED', 'DISMISSED', 'UPHELD', 'OVERTURNED', 'WITHDRAWN');
CREATE TYPE "ProgressType" AS ENUM ('QUEST', 'ACHIEVEMENT');

-- ── 2. AuthToken = RefreshToken + PasswordResetToken + EmailVerificationToken ─
CREATE TABLE "AuthToken" (
    "id" TEXT NOT NULL,
    "type" "AuthTokenType" NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthToken_pkey" PRIMARY KEY ("id"),
    -- Refresh-only columns. See the AuthToken model note.
    CONSTRAINT "AuthToken_refresh_family_check" CHECK (("type" = 'REFRESH') = ("familyId" IS NOT NULL)),
    CONSTRAINT "AuthToken_refresh_only_check" CHECK ("type" = 'REFRESH' OR ("usedAt" IS NULL AND "revokedAt" IS NULL))
);

INSERT INTO "AuthToken" ("id", "type", "userId", "tokenHash", "familyId", "usedAt", "revokedAt", "expiresAt", "createdAt")
SELECT "id", 'REFRESH', "userId", "tokenHash", "familyId", "usedAt", "revokedAt", "expiresAt", "createdAt"
  FROM "RefreshToken";

INSERT INTO "AuthToken" ("id", "type", "userId", "tokenHash", "expiresAt", "createdAt")
SELECT "id", 'EMAIL_VERIFICATION', "userId", "tokenHash", "expiresAt", "createdAt"
  FROM "EmailVerificationToken";

-- The reset token was stored IN THE CLEAR and keyed on an email. Hash it the
-- way @/lib/auth-tokens hashes the others (SHA-256, lowercase hex of the UTF-8
-- string) and resolve the email to the account. A row whose email matches no
-- user could never have reset anything; it is not carried over.
INSERT INTO "AuthToken" ("id", "type", "userId", "tokenHash", "expiresAt", "createdAt")
SELECT p."id", 'PASSWORD_RESET', u."id", encode(sha256(convert_to(p."token", 'UTF8')), 'hex'), p."expiresAt", p."createdAt"
  FROM "PasswordResetToken" p
  JOIN "User" u ON u."email" = p."email";

DO $$
DECLARE want int; got int;
BEGIN
  SELECT (SELECT count(*) FROM "RefreshToken") + (SELECT count(*) FROM "EmailVerificationToken")
       + (SELECT count(*) FROM "PasswordResetToken" p WHERE EXISTS (SELECT 1 FROM "User" u WHERE u."email" = p."email"))
    INTO want;
  SELECT count(*) INTO got FROM "AuthToken";
  IF got <> want THEN RAISE EXCEPTION 'schema v2: AuthToken has % rows, expected %', got, want; END IF;
END $$;

CREATE UNIQUE INDEX "AuthToken_tokenHash_key" ON "AuthToken"("tokenHash");
CREATE INDEX "AuthToken_userId_type_idx" ON "AuthToken"("userId", "type");
CREATE INDEX "AuthToken_familyId_idx" ON "AuthToken"("familyId");
ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP TABLE "RefreshToken";
DROP TABLE "PasswordResetToken";
DROP TABLE "EmailVerificationToken";

-- ── 3. SwapCode = SwapConfirmationCode (rename; the data stays put) ─────────
-- tradeId still references TradeRequest here; part 3 repoints it at Trade.
ALTER TABLE "SwapConfirmationCode" RENAME TO "SwapCode";
ALTER TABLE "SwapCode" RENAME CONSTRAINT "SwapConfirmationCode_pkey" TO "SwapCode_pkey";
ALTER TABLE "SwapCode" RENAME CONSTRAINT "SwapConfirmationCode_tradeId_fkey" TO "SwapCode_tradeId_fkey";
ALTER TABLE "SwapCode" RENAME CONSTRAINT "SwapConfirmationCode_userId_fkey" TO "SwapCode_userId_fkey";
ALTER INDEX "SwapConfirmationCode_tradeId_userId_key" RENAME TO "SwapCode_tradeId_userId_key";
ALTER INDEX "SwapConfirmationCode_userId_idx" RENAME TO "SwapCode_userId_idx";

-- ── 4. Like = PostLike, Comment = PostComment (renames); CommentLike dropped ─
DROP TABLE "CommentLike";

ALTER TABLE "PostLike" RENAME TO "Like";
ALTER TABLE "Like" RENAME CONSTRAINT "PostLike_pkey" TO "Like_pkey";
ALTER TABLE "Like" RENAME CONSTRAINT "PostLike_postId_fkey" TO "Like_postId_fkey";
ALTER TABLE "Like" RENAME CONSTRAINT "PostLike_userId_fkey" TO "Like_userId_fkey";
ALTER INDEX "PostLike_postId_userId_key" RENAME TO "Like_postId_userId_key";
ALTER INDEX "PostLike_userId_idx" RENAME TO "Like_userId_idx";

ALTER TABLE "PostComment" RENAME TO "Comment";
ALTER TABLE "Comment" RENAME CONSTRAINT "PostComment_pkey" TO "Comment_pkey";
ALTER TABLE "Comment" RENAME CONSTRAINT "PostComment_postId_fkey" TO "Comment_postId_fkey";
ALTER TABLE "Comment" RENAME CONSTRAINT "PostComment_userId_fkey" TO "Comment_userId_fkey";
ALTER TABLE "Comment" RENAME CONSTRAINT "PostComment_parentId_fkey" TO "Comment_parentId_fkey";
ALTER INDEX "PostComment_postId_idx" RENAME TO "Comment_postId_idx";
ALTER INDEX "PostComment_userId_idx" RENAME TO "Comment_userId_idx";
ALTER INDEX "PostComment_parentId_idx" RENAME TO "Comment_parentId_idx";

-- ── 5. Retired features: ConversationHide, DeferredContract ─────────────────
-- The DPA's ledger pair (CONTRACT_PAY / CONTRACT_COLLECT) keeps its contractId.
DROP TABLE "ConversationHide";
DROP TABLE "DeferredContract";
DROP TYPE "ContractStatus";

-- ── 6. Item: photos, wanted categories, bracket; boosts removed ─────────────
CREATE TABLE "ItemImage" (
    "itemId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "hash" VARCHAR(64),

    CONSTRAINT "ItemImage_pkey" PRIMARY KEY ("itemId","position")
);

-- position = the 0-based index into the old JSON array, which is exactly what
-- ItemImageHash.position already meant, so the hash lands on its own photo.
INSERT INTO "ItemImage" ("itemId", "position", "url", "hash")
SELECT i."id", (e.ord - 1)::int, e.url, h."hash"
  FROM "Item" i
 CROSS JOIN LATERAL json_array_elements_text(i."images"::json) WITH ORDINALITY AS e(url, ord)
  LEFT JOIN "ItemImageHash" h ON h."itemId" = i."id" AND h."position" = (e.ord - 1)::int;

DO $$
DECLARE want int; got int; want_h int; got_h int;
BEGIN
  SELECT coalesce(sum(json_array_length("images"::json)), 0) INTO want FROM "Item";
  SELECT count(*) INTO got FROM "ItemImage";
  IF got <> want THEN RAISE EXCEPTION 'schema v2: ItemImage has % rows, expected % photos', got, want; END IF;
  SELECT count(*) INTO want_h FROM "ItemImageHash";
  SELECT count(*) INTO got_h FROM "ItemImage" WHERE "hash" IS NOT NULL;
  IF got_h <> want_h THEN RAISE EXCEPTION 'schema v2: ItemImage carries % hashes, ItemImageHash had %', got_h, want_h; END IF;
END $$;

ALTER TABLE "ItemImage" ADD CONSTRAINT "ItemImage_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
DROP TABLE "ItemImageHash";

CREATE TABLE "ItemWantedCategory" (
    "itemId" TEXT NOT NULL,
    "category" "Category" NOT NULL,

    CONSTRAINT "ItemWantedCategory_pkey" PRIMARY KEY ("itemId","category")
);

-- DISTINCT: the array never forbade a repeat; the PK does.
INSERT INTO "ItemWantedCategory" ("itemId", "category")
SELECT DISTINCT i."id", c
  FROM "Item" i CROSS JOIN LATERAL unnest(i."lookingForCategories") AS c;

DO $$
DECLARE want int; got int;
BEGIN
  SELECT count(*) INTO want FROM (SELECT DISTINCT i."id", c FROM "Item" i CROSS JOIN LATERAL unnest(i."lookingForCategories") AS c) x;
  SELECT count(*) INTO got FROM "ItemWantedCategory";
  IF got <> want THEN RAISE EXCEPTION 'schema v2: ItemWantedCategory has % rows, expected %', got, want; END IF;
END $$;

CREATE INDEX "ItemWantedCategory_category_idx" ON "ItemWantedCategory"("category");
ALTER TABLE "ItemWantedCategory" ADD CONSTRAINT "ItemWantedCategory_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Boosts removed. The FEATURE_BOOST ledger rows stay.
DROP INDEX "Item_isFeatured_category_featuredAt_idx";
-- Dropping lookingForCategories also drops its GIN index (Item_lookingForCategories_idx).
ALTER TABLE "Item" DROP COLUMN "featuredAt",
DROP COLUMN "featuredUntil",
DROP COLUMN "isFeatured",
DROP COLUMN "imageHash",
DROP COLUMN "images",
DROP COLUMN "lookingForCategories";

-- The bracket, DERIVED and stored. Copy three of BRACKET_CEILINGS in
-- @/lib/brackets -- see the note on Item.bracket. Values at or below zero land
-- in bracket 1, as bracketOf() does.
ALTER TABLE "Item" ADD COLUMN "bracket" INTEGER GENERATED ALWAYS AS (
  CASE
    WHEN "valueLeaves" IS NULL THEN NULL
    WHEN "valueLeaves" <= 100 THEN 1
    WHEN "valueLeaves" <= 250 THEN 2
    WHEN "valueLeaves" <= 500 THEN 3
    WHEN "valueLeaves" <= 900 THEN 4
    WHEN "valueLeaves" <= 1500 THEN 5
    WHEN "valueLeaves" <= 2500 THEN 6
    WHEN "valueLeaves" <= 4000 THEN 7
    WHEN "valueLeaves" <= 9000 THEN 8
    WHEN "valueLeaves" <= 12000 THEN 9
    ELSE 10
  END
) STORED;

CREATE INDEX "Item_status_bracket_idx" ON "Item"("status", "bracket");

-- ── 7. ModerationCase = Report + ListingAppeal ──────────────────────────────
CREATE TABLE "ModerationCase" (
    "id" TEXT NOT NULL,
    "type" "ModerationCaseType" NOT NULL,
    "filedById" TEXT NOT NULL,
    "status" "ModerationCaseStatus" NOT NULL DEFAULT 'OPEN',
    "targetType" "ReportTargetType",
    "targetId" TEXT,
    "category" "ReportCategory",
    "notes" TEXT,
    "openKey" VARCHAR(4),
    "itemId" TEXT,
    "appealKind" "ListingAppealKind",
    "message" VARCHAR(300),
    "actionId" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationCase_pkey" PRIMARY KEY ("id"),
    -- Per-type shape. See the ModerationCase model note.
    CONSTRAINT "ModerationCase_report_shape_check" CHECK ("type" <> 'REPORT' OR (
        "targetType" IS NOT NULL AND "targetId" IS NOT NULL AND "category" IS NOT NULL
        AND "itemId" IS NULL AND "appealKind" IS NULL AND "message" IS NULL AND "actionId" IS NULL
        AND "status" IN ('OPEN', 'REVIEWING', 'ACTIONED', 'DISMISSED'))),
    CONSTRAINT "ModerationCase_appeal_shape_check" CHECK ("type" <> 'LISTING_APPEAL' OR (
        "itemId" IS NOT NULL AND "appealKind" IS NOT NULL AND "message" IS NOT NULL AND "actionId" IS NOT NULL
        AND "targetType" IS NULL AND "targetId" IS NULL AND "category" IS NULL AND "notes" IS NULL AND "openKey" IS NULL
        AND "status" IN ('OPEN', 'UPHELD', 'OVERTURNED', 'WITHDRAWN')))
);

INSERT INTO "ModerationCase" ("id", "type", "filedById", "status", "targetType", "targetId", "category", "notes", "openKey",
                              "decidedById", "decidedAt", "decisionNote", "createdAt")
SELECT "id", 'REPORT', "reporterId", "status"::text::"ModerationCaseStatus", "targetType", "targetId", "category", "notes", "openKey",
       "resolvedById", "resolvedAt", "resolutionNote", "createdAt"
  FROM "Report";

INSERT INTO "ModerationCase" ("id", "type", "filedById", "status", "itemId", "appealKind", "message", "actionId",
                              "decidedById", "decidedAt", "decisionNote", "createdAt")
SELECT "id", 'LISTING_APPEAL', "ownerId", "status"::text::"ModerationCaseStatus", "itemId", "kind", "message", "actionId",
       "decidedById", "decidedAt", "decisionReason", "createdAt"
  FROM "ListingAppeal";

DO $$
DECLARE want int; got int;
BEGIN
  SELECT (SELECT count(*) FROM "Report") + (SELECT count(*) FROM "ListingAppeal") INTO want;
  SELECT count(*) INTO got FROM "ModerationCase";
  IF got <> want THEN RAISE EXCEPTION 'schema v2: ModerationCase has % rows, expected %', got, want; END IF;
END $$;

CREATE UNIQUE INDEX "ModerationCase_actionId_key" ON "ModerationCase"("actionId");
CREATE INDEX "ModerationCase_type_status_createdAt_idx" ON "ModerationCase"("type", "status", "createdAt");
CREATE INDEX "ModerationCase_targetType_targetId_idx" ON "ModerationCase"("targetType", "targetId");
CREATE INDEX "ModerationCase_filedById_idx" ON "ModerationCase"("filedById");
CREATE INDEX "ModerationCase_itemId_idx" ON "ModerationCase"("itemId");
CREATE INDEX "ModerationCase_decidedById_idx" ON "ModerationCase"("decidedById");
CREATE UNIQUE INDEX "ModerationCase_filedById_targetType_targetId_openKey_key" ON "ModerationCase"("filedById", "targetType", "targetId", "openKey");
ALTER TABLE "ModerationCase" ADD CONSTRAINT "ModerationCase_filedById_fkey" FOREIGN KEY ("filedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ModerationCase" ADD CONSTRAINT "ModerationCase_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ModerationCase" ADD CONSTRAINT "ModerationCase_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AdminAction.reportId -> caseId. Report ids are now ModerationCase ids.
ALTER TABLE "AdminAction" ADD COLUMN "caseId" TEXT;
UPDATE "AdminAction" SET "caseId" = "reportId" WHERE "reportId" IS NOT NULL;
ALTER TABLE "AdminAction" DROP CONSTRAINT "AdminAction_reportId_fkey";
DROP INDEX "AdminAction_reportId_idx";
ALTER TABLE "AdminAction" DROP COLUMN "reportId";
CREATE INDEX "AdminAction_caseId_idx" ON "AdminAction"("caseId");
ALTER TABLE "AdminAction" ADD CONSTRAINT "AdminAction_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ModerationCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DROP TABLE "Report";
DROP TABLE "ListingAppeal";
DROP TYPE "ReportStatus";
DROP TYPE "ListingAppealStatus";

-- ── 8. Organization.ownerId = the ACTIVE OWNER member; staff removed ────────
ALTER TABLE "Organization" ADD COLUMN "ownerId" TEXT,
ADD COLUMN "ownerJoinedAt" TIMESTAMP(3);

UPDATE "Organization" o
   SET "ownerId" = m."userId",
       "ownerJoinedAt" = coalesce(m."joinedAt", m."invitedAt")
  FROM "OrganizationMember" m
 WHERE m."organizationId" = o."id" AND m."role" = 'OWNER' AND m."status" = 'ACTIVE';

-- An ORG_INVITE notification points at a membership row by id. Every
-- membership except the owner's is about to stop existing, and a notification
-- about an invitation that no longer exists points at nothing (the rule the
-- invite routes already follow when they withdraw one).
DELETE FROM "Notification" n
 WHERE n."entityType" = 'org_invite'
   AND NOT EXISTS (SELECT 1 FROM "OrganizationMember" m
                    WHERE m."id" = n."entityId" AND m."role" = 'OWNER' AND m."status" = 'ACTIVE');

ALTER TABLE "Organization" ALTER COLUMN "ownerId" SET NOT NULL,
ALTER COLUMN "ownerJoinedAt" SET NOT NULL;
CREATE INDEX "Organization_ownerId_idx" ON "Organization"("ownerId");
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP TABLE "OrganizationMember";
DROP TYPE "OrgMemberRole";
DROP TYPE "OrgMemberStatus";

-- ── 9. UserProgress = QuestAssignment + UserAchievement ────────────────────
CREATE TABLE "UserProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "ProgressType" NOT NULL,
    "periodStart" TIMESTAMP(3),
    "tier" "QuestTier",
    "quest" "QuestKind",
    "rewardLeaves" INTEGER,
    "completedAt" TIMESTAMP(3),
    "achievementId" TEXT,
    "unlockedAt" TIMESTAMP(3),
    "displayOrder" INTEGER,
    "homeDisplayOrder" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserProgress_pkey" PRIMARY KEY ("id"),
    -- Per-type shape. See the UserProgress model note.
    CONSTRAINT "UserProgress_quest_shape_check" CHECK ("type" <> 'QUEST' OR (
        "periodStart" IS NOT NULL AND "tier" IS NOT NULL AND "quest" IS NOT NULL AND "rewardLeaves" IS NOT NULL
        AND "achievementId" IS NULL AND "unlockedAt" IS NULL AND "displayOrder" IS NULL AND "homeDisplayOrder" IS NULL)),
    CONSTRAINT "UserProgress_achievement_shape_check" CHECK ("type" <> 'ACHIEVEMENT' OR (
        "achievementId" IS NOT NULL AND "unlockedAt" IS NOT NULL
        AND "periodStart" IS NULL AND "tier" IS NULL AND "quest" IS NULL AND "rewardLeaves" IS NULL AND "completedAt" IS NULL))
);

INSERT INTO "UserProgress" ("id", "userId", "type", "periodStart", "tier", "quest", "rewardLeaves", "completedAt", "createdAt")
SELECT "id", "userId", 'QUEST', "periodStart", "tier", "quest", "rewardLeaves", "completedAt", "createdAt"
  FROM "QuestAssignment";

-- UserAchievement had no createdAt; the row was written when it was unlocked.
INSERT INTO "UserProgress" ("id", "userId", "type", "achievementId", "unlockedAt", "displayOrder", "homeDisplayOrder", "createdAt")
SELECT "id", "userId", 'ACHIEVEMENT', "achievementId", "unlockedAt", "displayOrder", "homeDisplayOrder", "unlockedAt"
  FROM "UserAchievement";

DO $$
DECLARE want int; got int;
BEGIN
  SELECT (SELECT count(*) FROM "QuestAssignment") + (SELECT count(*) FROM "UserAchievement") INTO want;
  SELECT count(*) INTO got FROM "UserProgress";
  IF got <> want THEN RAISE EXCEPTION 'schema v2: UserProgress has % rows, expected %', got, want; END IF;
END $$;

CREATE INDEX "UserProgress_userId_type_periodStart_idx" ON "UserProgress"("userId", "type", "periodStart");
CREATE INDEX "UserProgress_userId_displayOrder_idx" ON "UserProgress"("userId", "displayOrder");
CREATE INDEX "UserProgress_achievementId_idx" ON "UserProgress"("achievementId");
CREATE UNIQUE INDEX "UserProgress_userId_periodStart_quest_key" ON "UserProgress"("userId", "periodStart", "quest");
CREATE UNIQUE INDEX "UserProgress_userId_achievementId_key" ON "UserProgress"("userId", "achievementId");
ALTER TABLE "UserProgress" ADD CONSTRAINT "UserProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserProgress" ADD CONSTRAINT "UserProgress_achievementId_fkey" FOREIGN KEY ("achievementId") REFERENCES "Achievement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP TABLE "QuestAssignment";
DROP TABLE "UserAchievement";
