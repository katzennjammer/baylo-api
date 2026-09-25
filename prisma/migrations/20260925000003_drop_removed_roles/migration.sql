-- Drop MODERATOR and SUPER_ADMIN from "Role".
--
-- schema.prisma has said `enum Role { USER ADMIN }` since the ADMIN-only
-- decision, but the postgres_baseline created the type with four values and
-- nothing ever removed two of them, so the live type still carried them.
--
-- Postgres cannot DROP VALUE from an enum, so the type is rebuilt: rename the
-- old one aside, create the two-value type, move User.role across by text
-- cast, drop the old type. User.role is the only column of type "Role"
-- (checked on live 2026-09-25: no other column, no function).
--
-- Prisma does not wrap a Postgres migration in a transaction; this one is
-- explicit so a failure part-way leaves the old type exactly as it was.

BEGIN;

-- The cast below would fail on a MODERATOR/SUPER_ADMIN row anyway, but with
-- a message about enum input syntax. Fail first, and say why.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "User" WHERE "role"::text IN ('MODERATOR', 'SUPER_ADMIN')) THEN
    RAISE EXCEPTION 'drop_removed_roles: a user still holds MODERATOR or SUPER_ADMIN; reassign them before migrating';
  END IF;
END $$;

ALTER TYPE "Role" RENAME TO "Role_old";
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- The default is typed as the old enum and would block the column change.
ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "role" TYPE "Role" USING ("role"::text::"Role");
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'USER';

DROP TYPE "Role_old";

COMMIT;
