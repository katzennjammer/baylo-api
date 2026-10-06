-- A suspension ending tells the account it ended.
--
-- ADDITIVE ONLY. One enum value. No columns, no indexes, no data touched.
--
-- Written by notifySuspensionEnded() in @/lib/moderation, the first time an
-- account signs in after its suspension was lifted or ran out. Until this is
-- applied that write fails, is caught, and the sign-in carries on without the
-- notice -- nothing else depends on the value.

ALTER TYPE "NotificationType" ADD VALUE 'SUSPENSION_LIFTED';
