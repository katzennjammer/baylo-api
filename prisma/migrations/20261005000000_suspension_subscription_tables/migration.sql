-- ════════════════════════════════════════════════════════════════════════════
-- SUSPENSION AND SUBSCRIPTION TABLES
-- Moves two pairs of columns off "User" into tables of their own, one row per
-- event, so each has an id and a history:
--
--   User.premiumUntil, User.vipUntil      ->  "Subscription" (one row per term)
--   User.suspendedAt,  User.suspendedUntil ->  "Suspension"   (one row per
--                                              suspension, with its `level`:
--                                              1st, 2nd, 3rd... for the account)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Rows ARE written, but none in the ledger: no Leaves figure can move.
--
-- The four columns are dropped at the bottom, after the backfill and after a
-- check that the new tables suspend EXACTLY the accounts the columns did. If
-- that check fails the whole migration rolls back and nothing is dropped.
--
-- "now" is written as (now() AT TIME ZONE 'UTC') throughout: every timestamp
-- in this database is a UTC TIMESTAMP(3) written by Prisma, and a bare
-- CURRENT_TIMESTAMP would be read in the session's zone instead.

-- ── Tables ──────────────────────────────────────────────────────────────────

CREATE TYPE "SubscriptionTier" AS ENUM ('PREMIUM', 'VIP');

CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tier" "SubscriptionTier" NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Subscription_userId_idx" ON "Subscription"("userId");

ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Suspension" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "liftedAt" TIMESTAMP(3),

    CONSTRAINT "Suspension_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Suspension_userId_idx" ON "Suspension"("userId");

ALTER TABLE "Suspension" ADD CONSTRAINT "Suspension_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Subscriptions: one row per non-null column ──────────────────────────────
--
-- Lapsed dates are carried too -- the membership screen says "expired 3 Sep".
-- When a term STARTED was never recorded, so startsAt is the migration time,
-- or the end date itself for a term that had already lapsed.

INSERT INTO "Subscription" ("id", "userId", "tier", "startsAt", "endsAt")
SELECT 'sub_p_' || "id", "id", 'PREMIUM', LEAST((now() AT TIME ZONE 'UTC'), "premiumUntil"), "premiumUntil"
FROM "User" WHERE "premiumUntil" IS NOT NULL;

INSERT INTO "Subscription" ("id", "userId", "tier", "startsAt", "endsAt")
SELECT 'sub_v_' || "id", "id", 'VIP', LEAST((now() AT TIME ZONE 'UTC'), "vipUntil"), "vipUntil"
FROM "User" WHERE "vipUntil" IS NOT NULL;

-- ── Suspensions 1/3: the history, from the audit log ────────────────────────
--
-- The User row only ever held the CURRENT suspension; past ones survive in
-- AdminAction, one USER_SUSPENDED row each. Rebuilding them here is what makes
-- `level` right from day one: an account suspended twice before today gets
-- level 3 next time, not level 1.
--
-- endsAt comes from the `until` the route wrote into AdminAction.detail (JSON;
-- null = indefinite). liftedAt is the first USER_UNSUSPENDED for the same
-- account that falls before its next suspension.

WITH s AS (
  SELECT a."id", a."targetId" AS "userId", a."reason", a."createdAt" AS "startsAt",
         ((a."detail"::jsonb ->> 'until')::timestamptz AT TIME ZONE 'UTC') AS "endsAt",
         row_number() OVER (PARTITION BY a."targetId" ORDER BY a."createdAt", a."id") AS "level"
  FROM "AdminAction" a
  JOIN "User" u ON u."id" = a."targetId"
  WHERE a."action" = 'USER_SUSPENDED' AND a."targetType" = 'USER'
)
INSERT INTO "Suspension" ("id", "userId", "level", "reason", "startsAt", "endsAt", "liftedAt")
SELECT 'sus_' || s."id", s."userId", s."level", s."reason", s."startsAt", s."endsAt",
       (SELECT min(l."createdAt")
        FROM "AdminAction" l
        WHERE l."action" = 'USER_UNSUSPENDED' AND l."targetType" = 'USER'
          AND l."targetId" = s."userId"
          AND l."createdAt" >= s."startsAt"
          AND l."createdAt" < COALESCE(
                (SELECT min(n."startsAt") FROM s n
                 WHERE n."userId" = s."userId" AND n."startsAt" > s."startsAt"),
                'infinity'))
FROM s;

-- ── Suspensions 2/3 and 3/3: the columns win ────────────────────────────────
--
-- Who is suspended RIGHT NOW is decided by the User columns, not by the audit
-- log: a script or a hand-typed UPDATE can change the columns without writing
-- an audit row. So wherever the rebuilt history disagrees with the columns --
--   2  a row still in force for an account the columns say is not suspended
--      (or is suspended on different terms): lift it;
--   3  an account the columns say is suspended, with no row in force: add one.

UPDATE "Suspension" s
SET "liftedAt" = (now() AT TIME ZONE 'UTC')
FROM "User" u
WHERE u."id" = s."userId"
  AND s."liftedAt" IS NULL
  AND (s."endsAt" IS NULL OR s."endsAt" > (now() AT TIME ZONE 'UTC'))
  AND (u."suspendedAt" IS NULL OR u."suspendedUntil" IS DISTINCT FROM s."endsAt");

INSERT INTO "Suspension" ("id", "userId", "level", "reason", "startsAt", "endsAt")
SELECT 'sus_u_' || u."id", u."id",
       1 + (SELECT count(*) FROM "Suspension" x WHERE x."userId" = u."id"),
       'Carried over from User.suspendedAt (no matching audit row)',
       u."suspendedAt", u."suspendedUntil"
FROM "User" u
WHERE u."suspendedAt" IS NOT NULL
  AND (u."suspendedUntil" IS NULL OR u."suspendedUntil" > (now() AT TIME ZONE 'UTC'))
  AND NOT EXISTS (
        SELECT 1 FROM "Suspension" s
        WHERE s."userId" = u."id" AND s."liftedAt" IS NULL
          AND (s."endsAt" IS NULL OR s."endsAt" > (now() AT TIME ZONE 'UTC')));

-- ── Check, then drop ────────────────────────────────────────────────────────
--
-- The accounts suspended by the table must be exactly the accounts suspended
-- by the columns. One account either way is a person wrongly locked out or
-- wrongly let back in, so this refuses rather than dropping the evidence.

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
  FROM "User" u
  WHERE (u."suspendedAt" IS NOT NULL
         AND (u."suspendedUntil" IS NULL OR u."suspendedUntil" > (now() AT TIME ZONE 'UTC')))
        IS DISTINCT FROM
        EXISTS (SELECT 1 FROM "Suspension" s
                WHERE s."userId" = u."id" AND s."liftedAt" IS NULL
                  AND (s."endsAt" IS NULL OR s."endsAt" > (now() AT TIME ZONE 'UTC')));
  IF n > 0 THEN RAISE EXCEPTION 'suspension backfill: % accounts would change suspension state; nothing dropped', n; END IF;

  SELECT (SELECT count(*) FROM "User" WHERE "premiumUntil" IS NOT NULL)
       + (SELECT count(*) FROM "User" WHERE "vipUntil" IS NOT NULL)
       - (SELECT count(*) FROM "Subscription") INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'subscription backfill: row count is off by %; nothing dropped', n; END IF;
END $$;

DROP INDEX "User_suspendedAt_idx";

ALTER TABLE "User" DROP COLUMN "premiumUntil",
                   DROP COLUMN "vipUntil",
                   DROP COLUMN "suspendedAt",
                   DROP COLUMN "suspendedUntil";
