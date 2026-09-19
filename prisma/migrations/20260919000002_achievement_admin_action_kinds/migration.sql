-- Append the achievement admin action kinds and target type to the LIVE enums.
--
-- ── WHY THIS IS A SEPARATE MIGRATION ─────────────────────────
--
-- Adding values to an enum in prisma/schema.prisma does NOT alter the enum in
-- the database. Prisma only uses the schema's enum to know what values to SEND;
-- Postgres validates against its OWN enum, which is built by migrations. So a
-- schema-only addition compiles, type-checks, builds, and then fails at runtime
-- with "invalid input value for enum" the first time the code writes one -- the
-- exact P2007 this fixes.
--
-- The live "AdminActionKind" already contained the report, listing, user, hub,
-- ID, role, offer, value-review, trade and appeal kinds. It lacked the four
-- achievement kinds; "AdminTargetType" lacked ACHIEVEMENT. Both are appended
-- here, and nothing is renamed or dropped -- existing rows reference the old
-- values and must keep resolving.
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block on older
-- Postgres, so each statement stands alone, and IF NOT EXISTS makes each safe to
-- re-run.

-- ── AdminActionKind ──────────────────────────
ALTER TYPE "AdminActionKind" ADD VALUE IF NOT EXISTS 'ACHIEVEMENT_CREATED';
ALTER TYPE "AdminActionKind" ADD VALUE IF NOT EXISTS 'ACHIEVEMENT_UPDATED';
ALTER TYPE "AdminActionKind" ADD VALUE IF NOT EXISTS 'ACHIEVEMENT_DEACTIVATED';
ALTER TYPE "AdminActionKind" ADD VALUE IF NOT EXISTS 'ACHIEVEMENT_REACTIVATED';

-- ── AdminTargetType ──────────────────────────
ALTER TYPE "AdminTargetType" ADD VALUE IF NOT EXISTS 'ACHIEVEMENT';
