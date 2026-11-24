-- Push notifications: the Expo push token of the phone an account last signed
-- in on. See User.pushToken and @/lib/push.
--
-- ADDITIVE ONLY. One nullable column, no default, no index, no data touched.
--
-- APPLY THIS BEFORE DEPLOYING THE CODE THAT NAMES IT. Prisma selects every
-- scalar column on a query without `select`, so a build whose client knows
-- pushToken, running against a database without it, fails every such User
-- query. The reverse is harmless: the old code never asks for the column.

ALTER TABLE "User" ADD COLUMN "pushToken" TEXT;
