# Restoring a Baylo database backup

The workflow is [`db-backup.yml`](db-backup.yml). It dumps the `public` schema
of the live Supabase database every day, encrypts it, and keeps it as a GitHub
Actions artifact for **14 days**.

Read this before you need it. The first time you decrypt one of these files
should not be the morning you have just dropped a table.

---

## What you need

| | |
|---|---|
| `BACKUP_PASSPHRASE` | The repo secret. **Not stored anywhere else.** Without it every dump is landfill. |
| `postgresql-client-17` | `pg_restore`/`psql`, major 17 or newer. `winget install -e --id PostgreSQL.PostgreSQL.17` |
| `gpg` | Preinstalled on macOS/Linux; on Windows use Git Bash, which ships it. |

## What is in an artifact

Download from **Actions → Database backup → a run → Artifacts**, then unzip:

```
MANIFEST.txt              plaintext — read this first, no passphrase needed
baylo-<stamp>.dump.gpg    custom format, encrypted. For selective restores.
baylo-<stamp>.sql.gpg     plain SQL, encrypted. For "just put it back".
```

`MANIFEST.txt` carries the row counts, the SHA-256 of both files before
encryption, the server version and the ledger invariant as they were at dump
time. Use it to pick the right artifact without decrypting three of them, and
to confirm afterwards that what you restored is what was dumped.

## Step 0 — decrypt

```bash
gpg --batch --passphrase "$BACKUP_PASSPHRASE" --pinentry-mode loopback \
    --decrypt baylo-20260923-181700.dump.gpg > baylo.dump

sha256sum baylo.dump          # must match "sha256 custom" in MANIFEST.txt
```

Without `--batch --passphrase`, gpg simply prompts. That is fine too.

---

## The three restores

### 1. A few rows or one table — the common case

This is what the 23 September incident actually needed: 15 rows in one table
were wrong, and everything else in the database was healthy. **Do not restore
the whole database to fix one table.** Load the old table into a scratch
schema, look at it, and copy across only what you meant to.

```bash
# a scratch schema on the SAME database, with an empty copy of the table shape
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA restore_20260923;
CREATE TABLE restore_20260923."UserAchievement"
  (LIKE "public"."UserAchievement" INCLUDING DEFAULTS);
SQL

# one table's rows out of the dump, redirected into that schema
pg_restore --data-only --table='"UserAchievement"' --no-owner --no-privileges \
           --file=- baylo.dump \
  | sed '0,/^COPY public\./s//COPY restore_20260923./' \
  | psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1

# now compare, and copy across ONLY what you meant to
psql "$SUPABASE_DB_URL" <<'SQL'
SELECT l.id, l."displayOrder" AS live, r."displayOrder" AS backup
FROM "public"."UserAchievement" l
JOIN restore_20260923."UserAchievement" r USING (id)
WHERE l."displayOrder" IS DISTINCT FROM r."displayOrder";
SQL

psql "$SUPABASE_DB_URL" -c 'DROP SCHEMA restore_20260923 CASCADE;'
```

Two details in there are load-bearing, and both are the kind that fail quietly:

**`--table='"UserAchievement"'` is quoted twice on purpose.** Since PostgreSQL
14, `pg_restore --table` is a *pattern* and follows psql's case-folding rules,
so an unquoted `--table=UserAchievement` looks for `userachievement`, matches
nothing, and **exits 0 having restored nothing at all**. The inner double
quotes preserve the case. Every table in this schema is mixed-case, so this
applies to all of them.

**The `sed` is anchored and applies once.** `pg_restore` emits
`COPY public."UserAchievement" (...) FROM stdin;` followed by raw tab-separated
rows, and a blanket `s/public\./restore_x./g` would also rewrite those *rows* —
any message body or pickup address containing the text `public.` would be
silently corrupted on the way in. `0,/^COPY public\./s//.../` replaces only the
first line that starts with `COPY public.`, which is the header and never data.
If you want to be certain, drop the `| psql` and read the output first.

### 2. The whole database, into a fresh Supabase project

For "the project is gone" or "we are moving". The plain dump carries schema and
data together, so the target starts empty — no `prisma migrate deploy` first.

```bash
gpg --decrypt baylo-20260923-181700.sql.gpg > baylo.sql

psql "$NEW_DATABASE_URL" -v ON_ERROR_STOP=1 -f baylo.sql
```

`ON_ERROR_STOP=1` is not optional. Without it psql prints errors, carries on,
and exits 0 — you get a half-restored database that reports success.

Then point the app at it and confirm before trusting it:

```bash
npx prisma migrate status          # schema matches what the repo expects
npx tsx --env-file=.env scripts/pg-backup.ts counts
```

Compare those counts against `MANIFEST.txt`. If they disagree, the restore is
not finished, whatever psql said.

### 3. Overwriting the live database — last resort

Only when live is definitively worse than a day-old copy. It **destroys
everything written since the dump**, including anything the dump was taken to
protect. Take a fresh dump first even if you believe the data is ruined:

```bash
# 1. capture the current state, however bad
pg_dump "$SUPABASE_DB_URL" --schema=public --no-owner --no-privileges \
        --format=custom --file=before-restore.dump

# 2. drop and rebuild public
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO postgres;
GRANT ALL ON SCHEMA public TO anon, authenticated, service_role;
SQL

# 3. put the backup back
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f baylo.sql
```

The `GRANT`s matter on Supabase: dropping `public` takes the platform's default
grants with it, and PostgREST and the dashboard stop working without them.

---

## Rehearsing, which is the only way to know any of this works

`scripts/pg-backup.ts drill` restores into a throwaway schema and reports what
it found, without touching live. Do it once now, while nothing is wrong:

```bash
npx tsx --env-file=.env --tsconfig tsconfig.json scripts/pg-backup.ts drill baylo.sql
```

Unrehearsed restore instructions are a guess written down confidently.

---

## Decisions worth knowing about

**Why 14 days of retention.** Not a storage decision. The encrypted dump is
around 150 KB, so 14 of them is ~2 MB against a quota measured in gigabytes —
you could keep 365 and not notice. 14 is about *how long it takes to notice a
problem*. Same-day corruption gets caught by anyone looking; the September
incident was subtle enough (two nullable columns, no errors, nothing visibly
broken) that it could easily have sat unnoticed for a week. Two weeks gives
real margin. The cap is 90 days: GitHub will not retain an artifact longer,
whatever you set. If you want longer than 90 days, artifacts are the wrong
place and you want object storage.

**Why the schedule is 18:17 UTC.** 02:17 Manila, so a failure is waiting for
you in the morning rather than mid-session. The `:17` avoids the top of the
hour, which is when everyone's cron fires and GitHub's scheduler queues.

**Why two formats.** `.dump` supports selective restore — one table, which is
what an incident usually needs. `.sql` is readable, greppable, and restorable
by any psql without a version-matched `pg_restore`. They fail in different
ways and together they cost ~300 KB.

**Why three tables come back empty.** `RefreshToken`, `PasswordResetToken` and
`EmailVerificationToken` are dumped with `--exclude-table-data`: the tables are
created, their rows are not. They are ephemeral auth material, and leaving the
rows out means a leaked passphrase does not also hand over 240 session tokens.

The cost is intended: **a restore logs everyone out and voids pending password
resets and email verifications.** Users sign in again; anyone mid-reset asks
for a new link. That is what you want after a restore-from-backup anyway —
resurrecting week-old sessions is not a feature.

Note the flag: `--exclude-table-data`, not `--exclude-table`. The latter would
drop the `CREATE TABLE` too, and a restore into a fresh project would come up
three tables short of what Prisma expects — failing at first login rather than
at restore time, which is the worst place to find out.

**Why only `--schema=public`.** That is everything the app owns. Supabase's
`auth`, `storage`, `realtime`, `vault`, `graphql` and `extensions` schemas
belong to the platform; the `postgres` role cannot dump them completely, and
restoring them over a fresh project fights its own migrations. Baylo uses
NextAuth with its own `User` table in `public` and does not use `auth.users`.

**Why roles and grants are not dumped.** `pg_dumpall --globals-only` needs
superuser, which Supabase does not give you. Roles are managed by the platform
and are recreated with a new project, so there is nothing to restore.

**What is deliberately NOT protected.** Storage objects (Cloudinary images —
that is Cloudinary's problem, and note that a `secure_url` is a permanent
credential), Supabase Auth users (unused), and anything written since the last
dump. Worst case is 24 hours of lost writes; twice-daily halves that.

---

## When it breaks

| Symptom | Cause | Fix |
|---|---|---|
| `server version 17.6; pg_dump version 16.x` | Supabase upgraded past the pinned client | Bump `PG_MAJOR` in the workflow |
| `invalid URI query parameter: "schema"` | Prisma parameters in `SUPABASE_DB_URL` | Strip `?schema=`, `?pgbouncer=`, `?connection_limit=` |
| `SASL authentication failed` | Rotated database password | Re-set the secret from Supabase → Settings → Database |
| `Connection refused` / hangs | Port 6543 (transaction mode), or project paused | Use port **5432**; unpause the project |
| `no such file or directory` on a socket | Secret unset, expanding to an empty string | Check the secret name spelling |
| Backups stopped and nothing failed | GitHub disables schedules after 60 days of repo inactivity | Re-enable in the Actions tab; push something |

The workflow opens a GitHub issue labelled `backup-failure` when a run fails,
and comments on the existing one rather than filing a new issue every night.
**An empty Actions tab is not the same as a working backup** — the 60-day
disable is silent, and it is the failure mode this table exists for.
