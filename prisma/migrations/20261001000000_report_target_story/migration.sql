-- Stories can be reported (1 Oct 2026).
--
-- ADDITIVE ONLY. One enum value. No columns, no indexes, no data touched.
--
-- ITS OWN MIGRATION, AND IT GOES TO `main` FIRST. Prisma refuses to read a row
-- whose enum column holds a value the generated client does not model, so the
-- first STORY report written from a branch would 500 every `main` checkout's
-- admin report queue. Land this folder (and the matching schema line) on main
-- before the stories feature can write one. See SETUP.md and
-- scripts/check-new-enum-rows.ts.
--
-- HAND-AUTHORED from `migrate diff --from-schema --to-schema`, which carries
-- none of the live database's unrelated drift.

ALTER TYPE "ReportTargetType" ADD VALUE 'STORY';
