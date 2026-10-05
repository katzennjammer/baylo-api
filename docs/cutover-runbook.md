# Schema v2 cutover runbook

**Status:** Stage 1 (rehearsal) and the pre-Stage-2 fixes are done (5 Oct 2026). Nothing in this runbook has been run against live. Stage 2 cannot start until the two remaining prerequisites in section 0 are built.
**Rehearsed:** 4 Oct 2026 on `D:\BAYLO\backups\baylo-pg-20261004-221810.sql`, and on 5 Oct 2026 on `baylo-pg-20261005-080500.sql`. Both hold 34 tables, 1959 rows, ledger 1744 / 1804 / 60.
**Operator:** Jamaica. **Teammates:** Noor, John.
**Design:** `docs/schema-v2.md`.
**Tools:**
- `scripts/lib/migration-runner.ts` is the only way any script runs migration SQL or a dump;
- `scripts/lib/api-role-lockdown.ts` holds the lockdown;
- `scripts/schema-v2/cutover-rehearsal.ts` is the rehearsal driver.

**Proofs:**
- `scripts/schema-v2/test-migration-guard.ts`;
- `scripts/schema-v2/test-pg-backup-target.ts <backup>`.

Live is one Supabase database: `aws-0-ap-southeast-1.pooler.supabase.com:5432`, database `postgres`, schema **`public`**. The scratch copies are other schemas in the same database. Every command below prints its target first. **Stop if the target is not the one the step names.**

---

## 0. Stage 2 prerequisites

**Done (5 Oct 2026):**
- **The migration runner.** One transaction. `search_path` is pinned at session level and re-checked before and after every batch. A plain inner `BEGIN;`/`COMMIT;` is stripped, and any other transaction control or path change is refused before it runs. Before COMMIT, a backstop checks that `public` has no row writes, no write locks and an unchanged catalog fingerprint, and rolls back if any of these fails. `build-scratch.ts`, `pg-backup.ts` (restore and drill) and `cutover-rehearsal.ts` all use it, and `test-migration-guard.ts` checks statically that every script reading migration SQL imports it.
- **`pg-backup.ts` honours `?schema=`** for dump, counts, restore and drill. `restore` refuses `public` unless `--confirm-live-rollback` is passed **and** the operator types `ROLLBACK LIVE public <one-time code>` in a terminal. A pipe, CI or a pasted command cannot confirm. `restore --force` truncates and reloads in the same transaction, and `drill` builds the layout the backup was taken in.
- **`verify-v2.ts` is actually read-only.** It sets `SET SESSION default_transaction_read_only = on`, runs one `REPEATABLE READ READ ONLY` transaction, and has Postgres refuse a write probe before any check runs. (The startup option it used before is dropped by the Supavisor pooler.)
- **The cutover method** is `applyV2InTransaction()` (section 5), rehearsed on a fresh copy of live.

**Still to build:**
1. **The live applier**, `cutover-live.ts` (section 9). It is a thin wrapper that calls the same functions the rehearsal uses:
   - `withGuardedTransaction(pg, { target: "public", live }, (g) => applyV2InTransaction(g))` for the migration;
   - the `rollback` logic for rollback;
   - `lockdownStatements("public", "postgres")` for section 4b.

   `live` comes only from `confirmLiveWrite()`. The arm token, expiry and one-run consumption in section 9 are not built.
2. **The guard-removal commit** on `feature/schema-v2`. This branch refuses `public` in `src/lib/db-schema.ts` `assertV2Schema` (app and scripts), in `prisma.config.ts` (`migrate`/`db`) and in `scripts/v2.mjs`. Until the first two flip, teammates cannot run this branch against live (step 7), and `prisma migrate status` cannot read live in step 6.

## 1. Go / no-go criteria

**GO** only if every line holds at T-0, immediately before step 5:

| # | Check | Expected | Source |
|---|---|---|---|
| G1 | Backup from step 3 | `BACKUP VERIFIED`, trailer matches live exactly | `backup-baylo-pg.ps1` |
| G2 | Ledger on live | all three checks hold (1744 / 1804 / 60 on 5 Oct) | `inspect-live` |
| G3 | Hidden trades | **0**. `drop_trade_hidden` refuses otherwise | `inspect-live` |
| G4 | CommentLike / ConversationHide rows | 0 / 0 | `inspect-live` |
| G5 | Open DeferredContract | 0 | `inspect-live` |
| G6 | Orgs without exactly one ACTIVE OWNER | 0 | `inspect-live` |
| G7 | App connections | **none** (step 4.3) | `inspect-live` |
| G8 | Fresh dry run on a copy of **this** backup | `SCHEMA V2 VERIFIED`, 0 FAIL | step 3 |
| G9 | Live `_prisma_migrations` | 28 rows, 27 finished, 1 rolled back (`20260923000003_daily_quests`), 0 unfinished; only the six v2 migrations pending | `inspect-live` |
| G10 | Guard tests on this commit | `MIGRATION GUARD TEST PASSED` and `PG-BACKUP TARGET TEST PASSED` | step 2.4 |
| G11 | API-role lockdown (step 4b) | `public`: 0 tables reachable by anon/authenticated; no postgres default ACL granting them; every table owned by `postgres` | `inspect-live` |

**NO-GO**: any check fails, or a teammate has not confirmed that their server is stopped.

## 2. Pre-checks (T-60 min)

1. Check that both repos are on the release commits: API `feature/schema-v2` with the section 0 commits, and mobile `feature/schema-v2`. `git status` must be clean.
2. Read-only live inspection:
   ```powershell
   cd D:\BAYLO\baylo
   node_modules\.bin\tsx.cmd --env-file=.env scripts/schema-v2/cutover-rehearsal.ts inspect-live
   ```
   It prints `session read-only: on (asserted)`. Record G2 to G6, G9 and the API-role exposure line.
3. Run `ListAgents` and ask any other Claude session to stay out of both repos, the database and servers until the cutover is over.
4. Run the guard tests (they write only to `schema_v2_cut_*` scratch schemas, and each proves at its end that live is unchanged). That gives G10.
   ```powershell
   node_modules\.bin\tsx.cmd --env-file=.env scripts/schema-v2/test-migration-guard.ts
   node_modules\.bin\tsx.cmd --env-file=.env scripts/schema-v2/test-pg-backup-target.ts D:\BAYLO\backups\<latest>.sql
   ```

## 3. Backup and fresh dry run (T-30 min, about 2 min)

1. Run the backup (read-only on live; about 10 to 13 s):
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\backup-baylo-pg.ps1 -UseFallback
   ```
   Record the file name as `$B`. The output must end `BACKUP VERIFIED` with `every table matches the live database exactly`.
2. Restore drill (scratch only, and rolled back, so nothing is left behind):
   ```powershell
   node_modules\.bin\tsx.cmd --env-file=.env scripts/pg-backup.ts drill $B
   ```
   It must print `RESTORE DRILL PASSED`.
3. Dry run with **the cutover method** on a fresh copy of `$B` that carries live's `_prisma_migrations` (about 12 s to restore, 5 s to apply, under a minute to verify):
   ```powershell
   node_modules\.bin\tsx.cmd --env-file=.env scripts/schema-v2/cutover-rehearsal.ts restore-old $B --schema schema_v2_cutgo --replace
   node_modules\.bin\tsx.cmd --env-file=.env scripts/schema-v2/cutover-rehearsal.ts restore-old $B --schema schema_v2_cutgo_src --replace
   node_modules\.bin\tsx.cmd --env-file=.env scripts/schema-v2/cutover-rehearsal.ts apply-single --schema schema_v2_cutgo
   node_modules\.bin\tsx.cmd --env-file=.env scripts/schema-v2/cutover-rehearsal.ts state --schema schema_v2_cutgo   # FULLY NEW
   npm run v2:tsx -- scripts/schema-v2/verify-v2.ts --schema schema_v2_cutgo                                          # SCHEMA V2 VERIFIED (G8)
   ```

> **Never use `prisma migrate deploy` for the cutover.** It runs the six files as six transactions. Killed mid-way on 4 Oct, it left a copy **half-migrated**: core and ledger committed, trade not, plus an unfinished `_prisma_migrations` row that blocks the next deploy with P3009.

## 4. Freeze (T-10 min)

1. **Noor and John:** stop every `npm run dev`, `next start` and `tsx` script that uses the API's `.env`, using **Ctrl+C**. Never force-kill: a hard kill strands session-pooler connections in the Supabase pool. Each of you confirms "stopped" in the team chat.
2. Jamaica stops her own servers the same way, including any `dev:v2`.
3. **Confirm that no app is connected, right before migrating.** Run `inspect-live` and read the `pg_stat_activity` block.
   - **Expected:** only Supabase's own sessions:
     - `authenticator` / PostgREST;
     - `pgbouncer` / Supavisor (auth_query);
     - `postgres` / pg_net;
     - `supabase_admin` (pg_cron, postgres_exporter, idle `show archive_mode`).
   - **Plus exactly one** `postgres` / `Supavisor` row in state `active`: the inspection itself.
   - App servers **also** appear as `postgres` / `Supavisor`, through either pooler, so the rule is by count: any second `postgres` row other than pg_net is an app connection. Find its owner and stop it gracefully. **No-go until it is gone.** (The migration's `LOCK … NOWAIT` is the hard backstop: it aborts with nothing changed if anything holds a table.)
   - Rehearsal reading, 4 Oct 22:17: exactly the expected set.
4. If anything could have written since step 3, compare live with `$B` (`cutover-rehearsal.ts counts --schema schema_v2_cutgo_src --backup $B` must show `differ from live: 0`). Otherwise take a new `$B`.

## 4b. API-role lockdown (T-2 min, about 1 s)

**Why.** On live, `anon` and `authenticated` hold every privilege on all 35 `public` tables, and RLS is off. Supabase's default ACLs give every new table the same grants. Anyone with the project's anon key could read and rewrite every row through PostgREST.

**Nothing uses those roles** (checked 5 Oct 2026):
- the API reaches Postgres only as `postgres` through Prisma (`pg` driver);
- the API, the admin web (`src/app/admin`, same repo) and the mobile app have no `@supabase/*` package, no PostgREST or GraphQL URL, and no anon or service key;
- the only Supabase value in any `.env` is the Postgres connection string.

**When.** It runs **before** step 5, so the v2 tables are created without the grants and there is never a window in which they have them.

**Run.** It runs through the live applier, with its own typed confirmation, in one transaction. The statements come from `lockdownStatements("public", "postgres")`:
```sql
REVOKE ALL PRIVILEGES ON ALL TABLES    IN SCHEMA "public" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "public" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL ROUTINES  IN SCHEMA "public" FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA "public" REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA "public" REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA "public" REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
```
`service_role` and `postgres` are untouched.

**Verify (G11).** `inspect-live` must print `API-role exposure of public: tables 0/35 …` and `public table owners: postgres x35`, and no `postgres/… -> anon|authenticated` default ACL. After step 5 the line reads `0/26` (25 tables plus `_prisma_migrations`).

**Rehearsed** 5 Oct on `schema_v2_cut4`, a copy in the v2 layout mirrored to live's exact grants:
- before: 26/26 tables exposed;
- after: 0/26 tables exposed and no granting default ACLs; a table created afterwards had anon SELECT false and authenticated INSERT false; service_role and postgres kept full access;
- time: 741 ms.

**Limits, stated rather than fixed:**
- **`supabase_admin`'s default ACLs** in `public` still grant anon and authenticated, and this role **cannot** change them: `permission denied to change default privileges`, measured on the copy. A table created *by `supabase_admin`* (for example by the Supabase dashboard's table editor, if it runs as that role) would be exposed again. **Rule:** create tables only through migrations, which run as `postgres`. The G11 owner check catches a stray table. To remove those defaults, ask Supabase support or use the dashboard SQL editor as `supabase_admin`.
- **Functions:** every new function gets EXECUTE through `PUBLIC` by the *global* built-in default, which a per-schema revoke cannot remove. `public` has no functions and no migration creates one. Changing this needs `ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`, which is database-wide, so it is a separate decision.
- **`storage` (7 tables) and `realtime` (1 table)** are Supabase-managed schemas that anon can read. They are out of scope; Baylo uses neither.

**Undo** (only if something unexpectedly depended on anon): `undoStatements("public")` in `api-role-lockdown.ts`, the same six statements with GRANT/TO.

## 5. Migrate (T-0)

**The method, and the only one:** `applyV2InTransaction()` inside `withGuardedTransaction()`, run by the live applier. **One transaction** holds:
1. Prisma's own migrate advisory lock (`pg_advisory_xact_lock(72707369)`), so no concurrent `prisma migrate` can interleave;
2. `LOCK TABLE` on every table `IN ACCESS EXCLUSIVE MODE NOWAIT`, with `lock_timeout 5s`. If any app is mid-work, this aborts with nothing changed;
3. a refusal if any v2 migration is already recorded;
4. the six v2 migrations in order. Each goes through the runner: validated, pinned, re-checked;
5. **the six `_prisma_migrations` rows**, written in the same transaction exactly as `prisma migrate deploy` writes them: uuid, checksum, `started_at`, `finished_at`, `applied_steps_count = 1`;
6. a check of 25 tables and all three ledger checks, still **inside** the transaction. A failure raises and rolls everything back;
7. COMMIT. It is the only commit.

The checksum is SHA-256 over LF line endings (what git stores). On 4 Oct it matched byte for byte the checksums Prisma's own `deploy` wrote, and it matches live's 27 pre-v2 rows. So it reads the same from a CRLF checkout on Windows.

**Expected:** six `applied …` lines, then `25 tables; … holds; … holds; … holds` and `DONE`. It takes about 4.7 s in the transaction, 5.6 s wall clock (5 Oct, on a fresh copy of live).

**Rehearsed on a fresh copy of live, 5 Oct** (`schema_v2_cut4`, from `baylo-pg-20261005-080500.sql`, carrying live's 28 `_prisma_migrations` rows):
- **Killed** after migration 3 (`pg_terminate_backend`, mid-transaction): **FULLY OLD**. 34/34 tables equal the backup, 0 v2 rows, ledger intact.
- **Run fully:** FULLY NEW, then `SCHEMA V2 VERIFIED` (0 FAIL), `prisma migrate status` → *Database schema is up to date!*, a follow-up `prisma migrate deploy` → *No pending migrations to apply*, and `migrate diff` → only the known Achievement drift.

## 6. Verify (T+1 to T+15 min)

1. `cutover-rehearsal.ts state` against live (read-only; the live applier provides it) must say `FULLY NEW (25 tables, 6 v2 rows)`, and the three ledger checks must hold.
2. `prisma migrate status` → `Database schema is up to date!` (after the guard-removal commit).
3. `migrate diff` from live to `schema.prisma` must show **only** the Achievement drift: `updatedAt` DROP DEFAULT, and `Achievement_key` → `Achievement_key_key`.
4. `inspect-live` → API-role exposure `0/26` (G11 still holds).
5. Start **one** server on the release commit (`npm run dev`) and sign in from the phone. Check:
   - home and marketplace load with photos (ItemImage);
   - an item page shows its wanted categories;
   - the trades list and an old chat with an embedded offer card (legacy offer id) render;
   - the profile shows Leaves (the ledger).
6. Run the verify suite against that server, one server per run. Run `verify-mobile-auth` first, then restart before `verify-email-verification` (the register limit is 3 per hour per server). Known failures that are not v2 regressions: email-verification 1, bracket-trading ≤ 13, trust-tier 2, org-trading-http 1, org-cloudinary 2, assistant-samples. **The suite has not been run against a v2 copy yet** (Stage 1 stopped before it).

## 7. Post-cutover: teammates switch branch

Only after GO at step 6, and only once the guard-removal commit is on `feature/schema-v2`.

```powershell
# API
git fetch origin; git checkout feature/schema-v2; git pull
npm ci
npx prisma generate                      # a running server keeps the old client
Remove-Item -Recurse -Force .next\dev    # a stale dev cache gives HTML 404s on nested routes
npm run dev
# Mobile
git fetch origin; git checkout feature/schema-v2; git pull; npm ci
```

Nobody runs the **old** branches against live again. Their code reads Offer, TradeRequest and TaskCompletion, which no longer exist.

Jamaica then drops the `schema_v2_cut*` and `schema_v2_cutgo*` rehearsal schemas once they are no longer needed. `.env.v2` was restored to `schema_v2_wk1` on 5 Oct.

## 8. Rollback

### Triggers. Roll back if any of these happens:
- the applier reports anything but `DONE`. It is atomic, so live is **fully old** and nothing needs undoing: confirm with `state` (`FULLY OLD`), fix the cause, and decide again;
- `state` is not `FULLY NEW`, or any ledger check fails;
- `migrate status` is not up to date, or `migrate diff` shows more than the Achievement drift;
- a step 6.5 smoke check fails in a way that cannot be fixed forward within 30 minutes;
- any money-moving flow fails: an offer with Leaves, accept, the bridge fee, or a confirm code.

### Steps (rehearsed: 1.87 s for the transaction, 3.4 s wall clock)
1. Freeze again (step 4): all servers stopped, no app connections.
2. Run the live `rollback $B` through the live applier, with its own typed confirmation. **One guarded transaction** that:
   - drops the 25 v2 tables and every enum type in `public` (the `public` schema itself, its grants and default ACLs, and `_prisma_migrations` stay);
   - deletes the six v2 rows from `_prisma_migrations`;
   - rebuilds the pre-v2 structure from the 27 old migrations through the runner, with `drop_removed_roles`' inner BEGIN/COMMIT stripped;
   - restores `$B`.

   The lockdown from step 4b survives, because the default ACLs are kept and the rebuilt tables are created by `postgres`.

   *`pg-backup.ts restore $B --force --confirm-live-rollback` is the other path. It needs the **old structure still in place**: it truncates and reloads rows, it does not rebuild tables. Use it only for "old layout, bad data", never after a successful migration.*
3. Verify:
   - `state` → `FULLY OLD (34 tables, no v2 bookkeeping)`;
   - `counts` against `$B` → `differ from backup: 0`;
   - ledger figures equal to `$B`'s trailer;
   - `migrate status` (from the **old** branch) shows nothing pending.
4. Teammates stay on (or go back to) the pre-v2 branch, then `npx prisma generate`, delete `.next\dev`, and restart.
5. **Data written between step 5 and the rollback is lost**, because the backup is from before the migration. The freeze is what keeps this window empty, so do not unfreeze until GO or rollback.

## 9. The one-time live-write override (design; the typed gate exists, the token does not)

The override has to lift the guard for exactly one run, for one stated purpose, against one stated backup. It must not be possible to supply by accident, and it must close again whether the run succeeds or crashes. The existing guards (`v2.mjs`, `prisma.config.ts`, `assertV2Schema`, `live-guard.ts`, `migration-runner.ts`) stay as they are for everything else.

- **Built (5 Oct):** `confirmLiveWrite(purpose)` in `migration-runner.ts`. It needs the explicit `--confirm-live-<purpose>` flag and an interactive terminal, and the operator must type `<PURPOSE> LIVE public <one-time code>`. `withGuardedTransaction` accepts `target: "public"` only with the branded object it returns; a forged object is refused (tested). `pg-backup.ts restore` uses it.
- **Not built:**
  1. **Arm** (`cutover-live.ts arm --purpose lockdown|migrate|rollback --backup $B`):
     - it runs every G check read-only and refuses on any failure;
     - it writes `D:\BAYLO\backups\.cutover-armed.json`, holding the purpose, backup path, backup SHA-256, live per-table counts, ledger figures, OS user, `createdAt`, and `expiresAt = createdAt + 15 min`.
  2. **Run** (`cutover-live.ts run`):
     - it requires `BAYLO_CUTOVER_LIVE=1`, the token **and** `confirmLiveWrite()`;
     - it **renames the token to `.cutover-used-<ts>.json` before connecting**, so a crash, a kill or a success all leave it disarmed;
     - it refuses if the token has expired, its purpose does not match, the backup hash changed, or live's counts or ledger differ from the token;
     - it then runs the section 4b, 5 or 8 transaction and logs to `D:\BAYLO\backups\cutover-<ts>.log`.
  3. **Expire:** the token is single-use with a 15-minute life, and the env flag is per-shell. Nothing is written to the database to arm it.

## 10. Rehearsal record

| Date | Step | Result | Time |
|---|---|---|---|
| 4 Oct | Backup `…20261004-221810.sql` | VERIFIED, 34 tables, 1959 rows, matches live | 13.4 s |
| 4 Oct | Restore drill (`schema_v2_cut1_src`) | 34/34 tables equal live and backup | — |
| 4 Oct | Dry run, build-scratch (`schema_v2_cut1`) | SCHEMA V2 VERIFIED, 0 FAIL | 0.82 s for six migrations |
| 4 Oct | Real `prisma migrate deploy` on a live replica (`schema_v2_cut2`) | exit 0, up to date, VERIFIED; but six transactions | 10.0 s |
| 4 Oct | Kill mid-trade, six transactions | **HALF** (26 tables, two v2 rows committed) | — |
| 4 Oct | Rollback over a migrated copy | FULLY OLD, 34/34 equal to backup | 1.87 s |
| 5 Oct | `test-migration-guard.ts` | PASSED: hazard reproduced with reads only; runner kept one txid; 5 dynamic escapes onto a decoy rolled back; live identical | — |
| 5 Oct | Backup `…20261005-080500.sql` | VERIFIED, matches live | 10.2 s |
| 5 Oct | `test-pg-backup-target.ts` | PASSED: restore into `?schema=`, row-for-row equal to live; `--force` atomic; 4 ways at `public` refused; drill passes and leaves nothing; live identical | — |
| 5 Oct | Cutover method, killed after migration 3 (`schema_v2_cut4`) | **FULLY OLD**, 34/34 equal to backup | — |
| 5 Oct | Cutover method, full run | FULLY NEW; VERIFIED 0 FAIL; `migrate status` up to date; `deploy` no-op | 4.7 s (5.6 s wall clock) |
| 5 Oct | API-role lockdown on the v2 copy | VERIFIED: 26/26 → 0/26, new tables unexposed, service_role and postgres intact | 0.74 s |
| — | Verify suite (`verify-*.ts` via a `dev:v2` server) | **not yet run** | — |
