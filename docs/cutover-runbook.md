# Schema v2 cutover runbook

**Status (5 Oct 2026):** all code is built and rehearsed, and nothing in this runbook has been run against live. What remains is the operator's run itself.
**Rehearsed on:** `D:\BAYLO\backups\baylo-pg-20261004-221810.sql` and `baylo-pg-20261005-080500.sql`. Both hold 34 tables, 1959 rows, ledger 1744 / 1804 / 60.
**Operator:** Jamaica. **Teammates:** Noor, John.
**Design:** `docs/schema-v2.md`.

**Branches** (API repo):

| Branch | What it is | When |
|---|---|---|
| `feature/schema-v2` | v2 code, the cutover tool and these tests. Its app refuses `public`. | Before and during the cutover |
| `feature/schema-v2-post-cutover` | `feature/schema-v2` plus one commit that lifts the "never `public`" guard. The app then refuses any **pre-v2** schema instead, and Prisma allows only `migrate status/deploy/diff/resolve` on `public`. **Not merged anywhere.** | Only after GO (section 7) |

**Tools:**

| File | Role |
|---|---|
| `scripts/schema-v2/cutover-live.ts` | **The** live tool: `arm` / `run` / `verify` for `lockdown`, `migrate` and `rollback` |
| `scripts/lib/migration-runner.ts` | The only way any script runs migration SQL or a dump. Holds the one-transaction cutover method |
| `scripts/lib/api-role-lockdown.ts` | The anon/authenticated lockdown |
| `scripts/schema-v2/cutover-rehearsal.ts` | Read-only inspection (`inspect-live`, `snapshot`, `state`, `counts`) and scratch copies (`restore-old`) |

**Proofs** (each ends by showing live unchanged):
- `test-migration-guard.ts`
- `test-pg-backup-target.ts <backup>`
- `test-cutover-live-e2e.ts <backup>`
- `test-post-cutover-guards.ts <v2 copy> <pre-v2 copy>` (on the post-cutover branch)

Live is one Supabase database: `aws-0-ap-southeast-1.pooler.supabase.com:5432`, database `postgres`, schema **`public`**. The scratch copies are other schemas in the same database. Every command prints its target first. **Stop if the target is not the one the step names.**

All commands run from `D:\BAYLO\baylo` in PowerShell. Shorthands used below:
```powershell
$B = "D:\BAYLO\backups\<the backup from step 3>.sql"
function cl { node_modules\.bin\tsx.cmd --env-file=.env scripts/schema-v2/cutover-live.ts @args }
function cr { node_modules\.bin\tsx.cmd --env-file=.env scripts/schema-v2/cutover-rehearsal.ts @args }
```

---

## 0. Prerequisites

All built on 5 Oct 2026:
- the migration runner;
- `pg-backup.ts` honouring `?schema=`;
- `verify-v2.ts` proven read-only, now with `--new/--old/--post-cutover`;
- the one-transaction method;
- the live tool with its one-time arm token;
- the post-cutover guard branch.

The design is in section 9.

## 1. Go / no-go criteria

`cl arm` checks G1–G7, G9 and G11 itself and refuses to arm on any NO-GO.

| # | Check | Expected | Checked by |
|---|---|---|---|
| G1 | Nothing written since the backup | 34/34 tables equal the backup trailer | `cl arm` |
| G2 | Ledger | all three checks hold | `cl arm` |
| G3 | Hidden trades | 0 | `cl arm` |
| G4 | CommentLike / ConversationHide | 0 / 0 | `cl arm` |
| G5 | Open DeferredContract | 0 | `cl arm` |
| G6 | Orgs without exactly one ACTIVE OWNER | 0 | `cl arm` |
| G7 | App connections | none (any `postgres` backend other than the tool and pg_net) | `cl arm`, and again by `cl run` |
| G8 | Dress rehearsal on a copy of **this** backup | step 3: lockdown → migrate → verify all PASS | operator |
| G9 | `_prisma_migrations` | no v2 row, nothing unfinished | `cl arm` |
| G10 | Guard tests on this commit | all PASSED | step 2.4 |
| G11 | Lockdown before migrate | 0 tables reachable by anon/authenticated; every table owned by `postgres` | `cl arm --purpose migrate` |

**NO-GO**: any check fails, or a teammate has not confirmed that their server is stopped.

## 2. Pre-checks (T-60 min)

1. Both repos are on `feature/schema-v2` (API at or after `7cd8715`; mobile `feature/schema-v2`), and `git status` is clean.
2. Run `cr inspect-live` (read-only; it prints `session read-only: on (asserted)`).
3. Run `ListAgents` and ask any other Claude session to stay out of both repos, the database and servers.
4. Run the guard tests (they write only to `schema_v2_cut_*` scratch schemas). That gives G10.
   ```powershell
   node_modules\.bin\tsx.cmd --env-file=.env scripts/schema-v2/test-migration-guard.ts
   node_modules\.bin\tsx.cmd --env-file=.env scripts/schema-v2/test-pg-backup-target.ts <latest backup>
   ```

## 3. Backup and dress rehearsal (T-30 min, about 2 min)

1. Run the backup (read-only on live; 10–13 s). Set `$B` to the file it names. It must end `BACKUP VERIFIED` with `every table matches the live database exactly`.
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\backup-baylo-pg.ps1 -UseFallback
   ```
2. Restore drill (scratch, rolled back; about 15 s). It must print `RESTORE DRILL PASSED`.
   ```powershell
   node_modules\.bin\tsx.cmd --env-file=.env scripts/pg-backup.ts drill $B
   ```
3. **Dress rehearsal: the whole tool, end to end, on a copy of `$B`.** It takes about 3 min, includes every refusal path, and must end `CUTOVER TOOL E2E PASSED` (G8). It leaves no token and no schema behind.
   ```powershell
   node_modules\.bin\tsx.cmd --env-file=.env scripts/schema-v2/test-cutover-live-e2e.ts $B
   ```
4. Build the **old-side copy** for the post-cutover comparison (about 12 s):
   ```powershell
   cr restore-old $B --schema schema_v2_cutgo_src --replace
   ```

> **Never use `prisma migrate deploy` for the cutover.** It runs the six files as six transactions. Killed mid-way on 4 Oct, it left a copy **half-migrated**, plus a P3009 row blocking the next deploy.

## 4. Freeze (T-10 min)

1. **Noor and John:** stop every `npm run dev`, `next start` and `tsx` script that uses the API's `.env`, using **Ctrl+C**. Never force-kill: a hard kill strands session-pooler connections. Each of you confirms "stopped" in the team chat.
2. Jamaica stops her own servers the same way, including any `dev:v2`.
3. **Confirm no app is connected, right before migrating.** Run `cr inspect-live` and read `pg_stat_activity`.
   - **Expected:** only Supabase's own sessions (`authenticator`/PostgREST, `pgbouncer`/Supavisor auth_query, `postgres`/pg_net, `supabase_admin` pg_cron/exporter), plus the inspection's own `postgres`/`Supavisor` row.
   - App servers also appear as `postgres`/`Supavisor`, so any **second** such row is an app connection. `cl arm` and `cl run` refuse on it (G7), and `LOCK … NOWAIT` inside the transaction is the final backstop.

## 4b. Lockdown (T-2 min; rehearsed 6.1 s in the transaction, about 12 s with arm)

```powershell
cl arm --purpose lockdown --backup $B                  # every line GO, then "ARMED lockdown on public until …"
$env:BAYLO_CUTOVER_LIVE = "1"
cl run --purpose lockdown --confirm-live-lockdown      # type:  LOCKDOWN LIVE public <code>
Remove-Item Env:BAYLO_CUTOVER_LIVE
cl verify --purpose lockdown --backup $B               # VERIFY LOCKDOWN PASSED: 0/35 exposed, still pre-v2, 34/34 = backup
```

**What it does, in one transaction:** REVOKE ALL on every table, sequence and routine in `public` from `anon` and `authenticated`, and from `postgres`'s default privileges there. Before commit it asserts that 0 objects are reachable.

**Why:** on 4 Oct, `anon` and `authenticated` held every privilege on all 35 `public` tables with RLS off. Anyone with the anon key could read and rewrite every row through PostgREST.

**Nothing uses those roles** (checked 5 Oct):
- the API reaches Postgres only as `postgres` through Prisma;
- the API, the admin web and mobile have no supabase-js, PostgREST/GraphQL URL or anon key.

`service_role` and `postgres` are untouched.

**Limits, stated rather than fixed:**
- **`supabase_admin`'s default ACLs** in `public` still grant anon and authenticated, and our role **cannot** change them (`permission denied to change default privileges`). Create tables only through migrations, which run as `postgres`. `cl arm` and `cl verify` fail if any table is not owned by `postgres`. To clear those defaults, ask Supabase support or use the dashboard SQL editor as `supabase_admin`.
- **Functions** get EXECUTE through `PUBLIC` by the global built-in default. `public` has none and no migration creates one; changing it is a database-wide decision.
- **`storage`** (7 tables) and **`realtime`** (1 table) are Supabase-managed and out of scope.

**Undo:** `undoStatements("public")` in `api-role-lockdown.ts`.

## 5. Migrate (T-0; rehearsed 8.5 s in the transaction, 9.4 s wall clock)

```powershell
cl arm --purpose migrate --backup $B                   # every line GO (G11 needs 4b first), "ARMED migrate …"
$env:BAYLO_CUTOVER_LIVE = "1"
cl run --purpose migrate --confirm-live-migrate        # type:  MIGRATE LIVE public <code>
Remove-Item Env:BAYLO_CUTOVER_LIVE
```
**Expected:** `re-checked: counts and ledger as armed, no app connections`, then `locked 35 tables NOWAIT, migrate lock held`, six `applied …` lines, `25 tables; … holds; … holds; … holds`, and `MIGRATE COMMITTED on public in … ms (one transaction)`.

**One transaction** holds:
1. Prisma's migrate advisory lock;
2. `LOCK TABLE … ACCESS EXCLUSIVE NOWAIT` on every table;
3. the six migrations, each validated and pinned by the runner;
4. the six `_prisma_migrations` rows, written exactly as `prisma migrate deploy` writes them (LF checksums, identical to Prisma's);
5. the 25-table count and all three ledger checks, still inside the transaction.

Any failure rolls back **everything**, and live stays fully old.

**Rehearsed on fresh copies of live** (`schema_v2_cut4`, `schema_v2_cut_e2e`, `schema_v2_cut_suite`):
- **Killed** mid-run with `pg_terminate_backend`: FULLY OLD, 34/34 tables equal to the backup.
- **Run fully:** VERIFY MIGRATE PASSED; `verify-v2 --new <copy> --old <src>` SCHEMA V2 VERIFIED (0 FAIL); `prisma migrate status` reports up to date, and a follow-up `prisma migrate deploy` reports "No pending migrations to apply".

## 6. Verify (T+1 to T+20 min)

1. `cl verify --purpose migrate --backup $B` must print `VERIFY MIGRATE PASSED`. It checks:
   - FULLY NEW (25 tables, 6 v2 rows);
   - the ledger;
   - 0/26 exposed;
   - owners;
   - the carried-over counts against the backup.
2. Full data comparison: live against the pre-cutover backup in the old layout. Read-only, proven; under a minute. It must print `SCHEMA V2 VERIFIED`.
   ```powershell
   npm run v2:tsx -- scripts/schema-v2/verify-v2.ts --new public --old schema_v2_cutgo_src --post-cutover
   ```
3. Switch the operator's tree to the post-cutover branch. All servers are still stopped.
   ```powershell
   git fetch origin; git checkout feature/schema-v2-post-cutover
   npx prisma generate
   npx prisma migrate status    # "Database schema is up to date!"  (allowed on public on this branch)
   npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script   # only the Achievement drift
   ```
4. Start **one** server: `Remove-Item -Recurse -Force .next\dev; npm run dev`.
   - Its startup gate must print `[schema v2] database: schema "public" (v2 layout confirmed, …)`.
   - On a pre-v2 `public` it refuses to boot. That was tested on 5 Oct against live as it is now.
5. Smoke-test from the phone:
   - home and marketplace show photos;
   - an item page shows wanted categories;
   - the trades list and an old chat's offer card render;
   - Leaves show on the profile.
6. Run the verify suite against that server:
   - foreground batches, one suite at a time;
   - `verify-mobile-auth` first;
   - restart the server before `verify-email-verification` (the register limit is 3 per hour per server).

   **Baseline** (measured on the v2 copy, 5 Oct; see section 10). Anything outside it is a regression:
   - bracket-trading ≤ 13 failures (8 on 5 Oct);
   - org-cloudinary 2;
   - org-trading-http 1;
   - trust-tier 2;
   - assistant-samples failing;
   - email-verification 1;
   - org-settlement-http 1 (check 4d, **pre-existing**: it fails the same way on the pre-v2 code, see section 10);
   - every other suite passes.

## 7. Post-cutover: teammates switch branch

Only after GO at step 6. Teammates move to **`feature/schema-v2-post-cutover`**; the pre-cutover branch refuses `public` by design. Whether and when it is merged into `feature/schema-v2` or `main` is a separate decision; until then nobody merges it.

```powershell
# API
git fetch origin; git checkout feature/schema-v2-post-cutover; git pull
npm ci
npx prisma generate                      # a running server keeps the old client
Remove-Item -Recurse -Force .next\dev    # a stale dev cache gives HTML 404s on nested routes
npm run dev                              # must print "v2 layout confirmed"
# Mobile
git fetch origin; git checkout feature/schema-v2; git pull; npm ci
```

Nobody runs the **old** branches against live again. Their code reads Offer, TradeRequest and TaskCompletion, which no longer exist.

Afterwards Jamaica drops `schema_v2_cutgo_src` once nothing needs it any more.

## 8. Rollback (rehearsed 17.7 s in the transaction, 18.6 s wall clock)

### Triggers. Roll back if any of these happens:
- `cl run --purpose migrate` prints anything but COMMITTED. It is atomic, so live is **fully old**: check with `cl verify --purpose lockdown --backup $B`, fix the cause, and decide again. There is nothing to roll back;
- `cl verify --purpose migrate` fails, or `verify-v2 --post-cutover` reports a FAIL;
- `migrate status` is not up to date, or `migrate diff` shows more than the Achievement drift;
- the post-cutover server refuses to boot on `public`;
- a step 6.5 smoke check fails in a way that cannot be fixed forward within 30 minutes;
- any money-moving flow fails: an offer with Leaves, accept, the bridge fee, or a confirm code.

### Steps
1. Freeze again (step 4): every server stopped with Ctrl+C, and the operator's tree back on `feature/schema-v2`. The post-cutover branch's server would refuse the rolled-back schema anyway.
2. Run the rollback:
   ```powershell
   cl arm --purpose rollback --backup $B
   $env:BAYLO_CUTOVER_LIVE = "1"
   cl run --purpose rollback --confirm-live-rollback    # type:  ROLLBACK LIVE public <code>
   Remove-Item Env:BAYLO_CUTOVER_LIVE
   cl verify --purpose rollback --backup $B             # VERIFY ROLLBACK PASSED: FULLY OLD, 34/34 = backup, 0 v2 rows, still 0 exposed
   ```
   In one guarded transaction it:
   - drops the 25 v2 tables and every enum;
   - deletes the six v2 `_prisma_migrations` rows;
   - rebuilds the pre-v2 structure through the runner (with `drop_removed_roles`' inner BEGIN/COMMIT stripped);
   - restores `$B` and asserts the counts and the ledger before commit.

   The `public` schema, its grants and default ACLs, `_prisma_migrations` and the lockdown all survive.
3. Teammates stay on (or go back to) the pre-v2 branch, then `npx prisma generate`, delete `.next\dev`, and restart.
4. **Data written between step 5 and the rollback is lost**, because the backup is from before the migration. The freeze keeps this window empty, so do not unfreeze until GO or rollback.

*`pg-backup.ts restore $B --force --confirm-live-rollback` is a different tool, for "old layout intact, data bad". It truncates and reloads rows; it does not rebuild tables. Never use it after a successful migration.*

## 9. The one-time live-write override (built and tested 5 Oct)

- **Arm** (read-only): runs the go/no-go checks. Only if all pass does it write `D:\BAYLO\backups\.cutover-armed.json`, holding: purpose, target, host, database, backup path and SHA-256, the target's per-table counts and ledger, OS user, a one-time code, and a **15-minute** expiry. It refuses if a token is already armed. Nothing is written to the database.
- **Run** requires:
  - `BAYLO_CUTOVER_LIVE=1` in the shell;
  - the token, **consumed first**: renamed to `.cutover-used-<ts>.json` before anything else, so a crash, kill, refusal or success all disarm it;
  - that the token matches: same purpose, unexpired, same OS user, same database, unchanged backup hash;
  - for `public`, `confirmLiveWrite()`: the `--confirm-live-<purpose>` flag, an interactive terminal, and the typed `<PURPOSE> LIVE public <code>`;
  - and, on re-reading the target: counts and ledger exactly as armed, and no app connections.

  It logs to `D:\BAYLO\backups\cutover-<ts>.log`.
- **The existing guards stay** for everything else: `v2.mjs`, `prisma.config.ts`, `assertV2Schema`, `live-guard.ts` and the runner.
- **Tested** by `test-cutover-live-e2e.ts`. Ten refusals: no token, no env flag, migrate before lockdown, a second arm, wrong purpose, expired, counts changed, backup changed, another OS user, wrong phrase. Plus the live path with no terminal and without the flag, refused before connecting.

## 10. Rehearsal record

| Date | Step | Result | Time |
|---|---|---|---|
| 4 Oct | Backup `…20261004-221810.sql` | VERIFIED, matches live | 13.4 s |
| 4 Oct | `prisma migrate deploy` on a live replica | worked, but six transactions; killed mid-way → **HALF** | 10.0 s |
| 4 Oct | Rollback over a migrated copy | FULLY OLD, 34/34 | 1.87 s |
| 5 Oct | Backup `…20261005-080500.sql` | VERIFIED, matches live | 10.2 s |
| 5 Oct | `test-migration-guard.ts` | PASSED | — |
| 5 Oct | `test-pg-backup-target.ts` | PASSED | — |
| 5 Oct | Cutover method killed mid-run (`cut4`) | **FULLY OLD**, 34/34 | — |
| 5 Oct | Cutover method full run (`cut4`) | FULLY NEW, VERIFIED, migrate status up to date | 4.7 s |
| 5 Oct | **`test-cutover-live-e2e.ts`**: the tool end to end on a copy of live (live's history and grants) | **PASSED**, 0 FAIL, live identical | about 3 min in total |
| | — `cl` lockdown | arm 4.5 s, run 7.2 s wall (6.1 s in the transaction), verify 4.5 s | |
| | — `cl` migrate | arm 4.7 s, run 9.4 s wall (8.5 s in the transaction), verify 3.5 s | |
| | — `cl` rollback | arm 3.6 s, run 18.6 s wall (17.7 s in the transaction), verify 4.8 s | |
| 5 Oct | Suite copy `schema_v2_cut_suite` built with `cl` lockdown + migrate | VERIFY LOCKDOWN / MIGRATE PASSED | 5.3 s + 8.0 s |
| 5 Oct | **Verify suite** on `schema_v2_cut_suite` via `npm run dev:v2` (all 40; one restart before email-verification) | 34 pass. The 6 that fail are all baseline: bracket-trading 8, org-cloudinary 2, org-trading-http 1, trust-tier 2, assistant-samples, email-verification 1, and org-settlement-http 1 (pre-existing, below) | about 22 min |
| 5 Oct | org-settlement-http on the **pre-v2 code** (`8c0277f`, temporary worktree, webpack) against an **old-layout** copy of the same backup, run twice | 4d fails identically in both runs (95 passed, 1 failed), so it is **pre-existing**; live fingerprint identical before and after (`4a5835f1…8906`) | 90 s + 70 s |
| 5 Oct | `test-post-cutover-guards.ts` (post-cutover branch) | PASSED: v2 copy starts; pre-v2 copy and live `public` refuse; reset/dev/push refused before connecting | — |
| 5 Oct | Dropped `schema_v2_cut1`–`cut4` and their `_src` twins | live fingerprint identical before and after (`4a5835f1…8906`) | — |

**org-settlement-http 4d: pre-existing, in the baseline.** The check *"anything the person's review moved is a QUEST_REWARD"* sums every non-TRADE_REWARD ledger row the person received in the last **60 s of wall-clock time**, and compares that with how much their balance moved during the review. The trade completing a few seconds earlier writes a 20-Leaf TASK_REWARD (and sometimes a quest reward) inside that window, so the check fails whenever the suite runs at normal speed. Measured on 5 Oct:

| Code / layout | Run | Balance during the review | Rows in the 60 s window |
|---|---|---|---|
| v2 (`schema_v2_cut_suite`) | 1 | 26 → 26 | TASK_REWARD 20 |
| v2 | 2 | 29 → 31 | TASK_REWARD 20, QUEST_REWARD 5, QUEST_REWARD 2 |
| pre-v2 `8c0277f` (`schema_v2_cut_old`) | 1 | 26 → 28 | TASK_REWARD 20, QUEST_REWARD 2 |
| pre-v2 `8c0277f` | 2 | 26 → 26 | TASK_REWARD 20 |

The old run was safe from the 23 Sep raw-SQL hazard: its `DATABASE_URL` carried `options=-c search_path="schema_v2_cut_old",extensions`, and a probe through the old code's own Prisma client showed raw SQL resolving to the copy. Live's fingerprint was unchanged.

**Fix (not applied; needs approval):** scope the rows to `createdAt >` the moment the review request was sent, instead of `now - 60 s`.
