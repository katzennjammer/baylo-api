-- ════════════════════════════════════════════════════════════════════════════
-- SCHEMA V2, PART 2 OF 3: LEDGER                     (design: docs/schema-v2.md)
-- TaskCompletion -> LeafTransaction.task / taskRefId
-- ════════════════════════════════════════════════════════════════════════════
--
-- HIGH RISK, AND SEPARABLE ON PURPOSE. Nothing in part 1 or part 3 depends on
-- this file; if it is not ready at the go/no-go, delete this folder and the
-- `task`/`taskRefId` block in schema.prisma, and restore the TaskCompletion
-- model from git -- the rest ships without it.
--
-- WHY THE INVARIANT CANNOT MOVE. A paid TaskCompletion row was always written
-- in the same transaction as one TASK_REWARD ledger row of the same amount
-- (awardTask() in @/lib/tasks). This migration does NOT add a ledger row for a
-- paid completion: it finds that existing row and stamps (task, taskRefId) on
-- it. The only rows it INSERTS are for the completions that paid NOTHING (a
-- repeat partner or the weekly cap recorded a permanent denial as leaves = 0),
-- and those are inserted with amount 0. So:
--   SUM(LeafTransaction.amount)  is unchanged, to the Leaf;
--   SUM(User.leaves)             is not touched at all;
--   issuance (TASK_REWARD is an issuance type) changes by 0.
-- All three are asserted below before TaskCompletion is dropped.

-- ── 0. Preconditions ────────────────────────────────────────────────────────
DO $$
DECLARE n int;
BEGIN
  -- Every paid completion must have exactly as many TASK_REWARD rows behind it,
  -- per user and amount. If this fails the matcher below would have to guess.
  SELECT count(*) INTO n FROM (
    SELECT tc."userId", tc."leaves", count(*) AS c FROM "TaskCompletion" tc WHERE tc."leaves" > 0 GROUP BY 1, 2
  ) a
  LEFT JOIN (
    SELECT l."userId", l."amount", count(*) AS c FROM "LeafTransaction" l WHERE l."type" = 'TASK_REWARD' GROUP BY 1, 2
  ) b ON b."userId" = a."userId" AND b."amount" = a."leaves"
  WHERE coalesce(b.c, 0) < a.c;
  IF n > 0 THEN RAISE EXCEPTION 'schema v2 ledger: % (user, amount) groups have fewer TASK_REWARD rows than paid completions', n; END IF;
END $$;

-- ── 1. The columns ──────────────────────────────────────────────────────────
ALTER TABLE "LeafTransaction" ADD COLUMN "task" "TaskKind",
ADD COLUMN "taskRefId" TEXT;

-- ── 2. Stamp each PAID completion onto the ledger row that paid it ──────────
--
-- The pair was written in one transaction, so they are milliseconds apart (the
-- live maximum was 0.27 s). Candidates are: same user, TASK_REWARD, same
-- amount, not already claimed, within 5 s. Ranked by
--   1. the ledger row's tradeId equals the completion's refId (repeatable tasks);
--   2. the ledger row's description names THIS task (it is never allowed to
--      name a different one -- that candidate is excluded outright);
--   3. the smallest time gap, then id, so the result is deterministic.
-- When two candidates are still tied, they are the same user, the same amount
-- and the same moment: which of the two carries the stamp changes no balance,
-- no sum and no window, only which of two identical rows is "the" claim.
DO $$
DECLARE r record; lid text;
BEGIN
  FOR r IN SELECT * FROM "TaskCompletion" WHERE "leaves" > 0 ORDER BY "createdAt", "id" LOOP
    SELECT l."id" INTO lid
      FROM "LeafTransaction" l
     WHERE l."userId" = r."userId"
       AND l."type" = 'TASK_REWARD'
       AND l."amount" = r."leaves"
       AND l."task" IS NULL
       AND abs(extract(epoch FROM (l."createdAt" - r."createdAt"))) < 5
       -- The task the description names, if it names one. Never a different task.
       AND coalesce((CASE
              WHEN l."description" ILIKE '%VERIFY_ACCOUNT%' OR l."description" ILIKE '%verified your account%' THEN 'VERIFY_ACCOUNT'
              WHEN l."description" ILIKE '%COMPLETE_PROFILE%' OR l."description" ILIKE '%completed your profile%' THEN 'COMPLETE_PROFILE'
              WHEN l."description" ILIKE '%FIRST_LISTING%' OR l."description" ILIKE '%first item%' THEN 'FIRST_LISTING'
              WHEN l."description" ILIKE '%VERIFIED_SWAP%' OR l."description" ILIKE '%verified swap%' THEN 'VERIFIED_SWAP'
              WHEN l."description" ILIKE '%SAFEZONE_MEETUP%' OR l."description" ILIKE '%safe%zone%' THEN 'SAFEZONE_MEETUP'
              WHEN l."description" ILIKE '%FIRST_TRADE%' OR l."description" ILIKE '%first trade%' THEN 'FIRST_TRADE'
            END), r."task"::text) = r."task"::text
     ORDER BY (CASE WHEN r."refId" <> '' AND l."tradeId" = r."refId" THEN 0 ELSE 1 END),
              (CASE WHEN l."description" ILIKE '%' || r."task"::text || '%' THEN 0 ELSE 1 END),
              abs(extract(epoch FROM (l."createdAt" - r."createdAt"))),
              l."id"
     LIMIT 1;

    IF lid IS NULL THEN
      RAISE EXCEPTION 'schema v2 ledger: no TASK_REWARD row pays completion % (% %, % Leaves)', r."id", r."task", r."refId", r."leaves";
    END IF;

    UPDATE "LeafTransaction" SET "task" = r."task", "taskRefId" = r."refId" WHERE "id" = lid;
  END LOOP;
END $$;

-- ── 3. The DENIED completions become 0-Leaf ledger rows ─────────────────────
-- Same id as the TaskCompletion row (a cuid, unique across tables). createdAt
-- and eventAt are the moment the denial was recorded. tradeId carries the
-- trade for a repeatable task, as the paid VERIFIED_SWAP rows already do.
INSERT INTO "LeafTransaction" ("id", "userId", "type", "amount", "description", "tradeId", "task", "taskRefId", "createdAt", "eventAt")
SELECT tc."id", tc."userId", 'TASK_REWARD', 0,
       'Task not awarded: ' || tc."task"::text || ' (denied by a faucet rule; 0 Leaves)',
       nullif(tc."refId", ''), tc."task", tc."refId", tc."createdAt", tc."createdAt"
  FROM "TaskCompletion" tc
 WHERE tc."leaves" = 0;

-- ── 4. Prove it ─────────────────────────────────────────────────────────────
DO $$
DECLARE tc_rows int; l_rows int; tc_sum bigint; l_sum bigint; missing int; stray int;
BEGIN
  SELECT count(*), coalesce(sum("leaves"), 0) INTO tc_rows, tc_sum FROM "TaskCompletion";
  SELECT count(*), coalesce(sum("amount"), 0) INTO l_rows, l_sum FROM "LeafTransaction" WHERE "task" IS NOT NULL;
  IF l_rows <> tc_rows THEN RAISE EXCEPTION 'schema v2 ledger: % task rows on the ledger, % completions', l_rows, tc_rows; END IF;
  IF l_sum <> tc_sum THEN RAISE EXCEPTION 'schema v2 ledger: task rows sum to %, completions to %', l_sum, tc_sum; END IF;

  SELECT count(*) INTO missing FROM "TaskCompletion" tc
   WHERE NOT EXISTS (SELECT 1 FROM "LeafTransaction" l
                      WHERE l."userId" = tc."userId" AND l."task" = tc."task" AND l."taskRefId" = tc."refId" AND l."amount" = tc."leaves");
  IF missing > 0 THEN RAISE EXCEPTION 'schema v2 ledger: % completions have no matching ledger row', missing; END IF;

  -- Every PAID TASK_REWARD row must now be claimed by a task: a TASK_REWARD
  -- row with no completion behind it would be a payment nobody can explain.
  SELECT count(*) INTO stray FROM "LeafTransaction" WHERE "type" = 'TASK_REWARD' AND "task" IS NULL;
  IF stray > 0 THEN RAISE EXCEPTION 'schema v2 ledger: % TASK_REWARD rows match no completion', stray; END IF;
END $$;

-- ── 5. Constraints, then the old table goes ─────────────────────────────────
ALTER TABLE "LeafTransaction" ADD CONSTRAINT "LeafTransaction_task_pair_check" CHECK (("task" IS NULL) = ("taskRefId" IS NULL));
ALTER TABLE "LeafTransaction" ADD CONSTRAINT "LeafTransaction_task_type_check" CHECK ("task" IS NULL OR "type" = 'TASK_REWARD');
CREATE UNIQUE INDEX "LeafTransaction_userId_task_taskRefId_key" ON "LeafTransaction"("userId", "task", "taskRefId");

DROP TABLE "TaskCompletion";
