-- Staff invitations become a notification.
--
-- ADDITIVE ONLY. One enum value. No columns, no indexes, no data touched.
--
-- THE ENUM VALUE MUST REACH `main` BEFORE ANY CODE WRITES IT, for the reason
-- 20260923000000_organizations_and_perishables gives: Prisma refuses to read a
-- row whose enum column holds a value the generated client does not model, so
-- the first ORG_INVITE row written from a branch would 500 every `main`
-- checkout's notification list for that recipient. See SETUP.md and
-- scripts/check-new-enum-rows.ts.
--
-- HAND-AUTHORED, NOT `migrate diff` OUTPUT, for the same reason as the last
-- three: the generated script carries unrelated drift.

ALTER TYPE "NotificationType" ADD VALUE 'ORG_INVITE';
