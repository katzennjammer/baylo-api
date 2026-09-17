# Baylo — API and web app

Baylo is a non-monetary trading platform: people swap things they own, and the
only unit that changes hands is **Pasa Leaves**, which cannot be bought. This
repo is the Next.js app — the web UI, the REST API under `/api`, the versioned
mobile API under `/api/v1`, and the Prisma schema.

The Expo mobile client lives in a sibling repo, **[`../baylo-mobile`](../baylo-mobile)**,
and talks to this server over `/api/v1` with a Bearer token. It needs this
server running first. If you are setting up both, do this one first and then
follow [`../baylo-mobile/README.md`](../baylo-mobile/README.md).

> **The database is Postgres on Supabase since 2026-09-15.** It was MariaDB
> under XAMPP before that. If you have a working MySQL checkout, read
> [Coming from MySQL](#coming-from-mysql-teammates-read-this) before you pull.

---

## Setup

Written for someone who has never seen this project. Seven steps, about ten
minutes, most of it `npm install`.

### 1. Prerequisites

| | Version | Notes |
|---|---|---|
| **Node.js** | 20.9+ (22 LTS recommended) | `node --version`. Next 16 and the `tsx` seed runner both need ≥20.9. |
| **npm** | 10+ | Ships with Node. |
| **A Supabase project** | Postgres 17 | Free tier is enough. See step 4. Nothing to install locally — the database is hosted. |
| **Git** | any | |

No MariaDB, no XAMPP. There is no local database server to start.

### 2. Install

```bash
git clone <this repo> baylo
cd baylo
npm install
```

### 3. Environment

```bash
cp .env.example .env
```

Now open `.env`. It is long, but it is organised so you can stop early:
**`DATABASE_URL` and `AUTH_SECRET` are the only two you need to run the app.**
Every other block is a capability that fails on its own if left blank, and the
file says exactly what each blank costs you.

Which values are yours and which come from the project owner:

| Variable | Where it comes from |
|---|---|
| `DATABASE_URL` | **Yours.** Your own Supabase project — see step 4. Do not ask for the owner's; it is their live data. |
| `AUTH_SECRET` | **Yours.** Generate it: `openssl rand -base64 32`. Never share one. |
| `NEXTAUTH_URL` | **Yours.** Leave the default for local work. |
| `CLOUDINARY_*` | **Ask the project owner** — or sign up free at cloudinary.com and use your own. |
| `PUSHER_*`, `NEXT_PUBLIC_PUSHER_*` | **Ask the project owner** — or a free Channels app at pusher.com. |
| `ANTHROPIC_API_KEY` | **Ask the project owner** — or your own from console.anthropic.com. Note this one bills per call. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_NATIVE_CLIENT_IDS` | **Ask the project owner** — or create your own OAuth client. |
| `EMAIL_SMTP_*` | **Leave blank. Do not ask.** See below. |

**On SMTP.** `EMAIL_SMTP_PASS` is a personal Gmail app password belonging to the
project owner. It is tied to their personal account, it is not a project
credential, and it will not be shared — so leave all five `EMAIL_*` variables
empty. The cost of leaving them empty is that verification emails do not send,
and nothing else: the send is wrapped in a try/catch, registration still
succeeds, and **login is not gated on being verified.** The seeded accounts in
step 6 are already verified, so in practice this never comes up. If you do want
real email, use your own Gmail app password.

### 4. Create the database

Make a Supabase project at <https://supabase.com/dashboard>:

- **Region: Singapore (`ap-southeast-1`).** Closest to the Philippines; every
  query pays the round trip, and from Manila that is ~40 ms to Singapore and
  ~200 ms to anywhere in the US.
- **Database password:** pick a strong one and save it. It is shown once.
- Postgres 17, the default. Leave everything else alone.

Then *Connect → ORMs → Prisma* and copy the **Session pooler** string — the one
on port **5432** at `aws-0-ap-southeast-1.pooler.supabase.com` with user
`postgres.<project-ref>`. Paste it as `DATABASE_URL` in `.env`.

Why that one and not the other two on that page:

- **Direct connection** (`db.<ref>.supabase.co:5432`) is **IPv6-only** on the
  free tier. A typical home connection in the Philippines cannot reach it, and
  the failure is a silent hang, not an error.
- **Transaction pooler** (port **6543**) is for serverless deployments. It does
  not support everything Prisma migrations need. Do not use it for
  `migrate deploy`.
- **Session pooler** (port **5432** on the `pooler.` host) works over IPv4 and
  supports everything. Use it for the app *and* for migrations.

The `public` schema of a new project is empty. Prisma builds the tables in the
next step; there is no `CREATE DATABASE` to run.

### 5. Generate the client and create the tables

```bash
npx prisma generate      # writes the typed client to src/generated/prisma
npx prisma migrate deploy
```

`migrate deploy` applies one migration, `20260915000000_postgres_baseline`,
which builds all 25 tables, 20 enum types, 55 indexes and 48 foreign keys. It
should finish in a few seconds and print
`All migrations have been successfully applied.`

> **Use `migrate deploy`, not `migrate dev`.** `migrate dev` needs a shadow
> database it can `CREATE`, and the Supabase role cannot, so it fails. It is
> never needed to set up, and [authoring a migration](#adding-a-migration-from-here)
> is done differently here.

### 6. Seed

```bash
npm run seed
```

This turns the empty database into something you can actually click through:

```
  hubs      22 Safe-Zone Hubs
  users     4, all verified and grandfathered past ID verification
  listings  8 across 5 categories (4 available, 4 settled)
  trades    2 completed
  offers    1 pending
  ledger    8 Leaf transactions

  leaf invariant OK   SUM(User.leaves) = 80 = SUM(LeafTransaction.amount) = 80
```

**Log in as any of these. The password is the same for all four:**

| Email | Password | |
|---|---|---|
| `maria@baylo.test` | `BayloDev123!` | 0 Leaves · has a pending offer waiting for an answer |
| `jun@baylo.test` | `BayloDev123!` | 40 Leaves |
| `aya@baylo.test` | `BayloDev123!` | 5 Leaves |
| `carlo@baylo.test` | `BayloDev123!` | 35 Leaves · sent the pending offer |

All four are verified (so login works and the 20-Leaf signup grant is already
paid) and **grandfathered past ID verification**, so they can post listings
without submitting a government ID.

The seed is **idempotent** — every row it writes has a fixed `seed-*` id and is
upserted, so running it twice produces exactly the state it produced once. The
flip side is that re-running resets seeded rows to their seeded values; rows you
create through the app have generated ids and are never touched.

### 7. Run

```bash
npm run dev
```

Open <http://localhost:3000> and sign in as `maria@baylo.test`. You should see
the four available listings in the feed, and one pending offer on the rattan
armchair.

Every request now crosses the internet to Singapore. Expect ~1 s per API call
in dev on a home connection, where MySQL on localhost took ~50 ms. That is the
network, not the queries — the acceptance harness counts them and they did not
change.

Use `npm run dev:lan` instead if a phone or emulator needs to reach this server
— it binds `0.0.0.0` rather than loopback. See
[`../baylo-mobile`](../baylo-mobile).

---

## Before UAT

The checklist for turning a development server into one a tester can trust.
Each item is a development convenience that must be off when a real person is
judging the app, because each one makes the app lie about something.

- [ ] **`ID_VERIFICATION_DEV_AUTO_APPROVE="0"` in `.env`.** While it is `1`,
      every submitted ID is approved on the spot and the "under review" state
      never happens, so a tester cannot see the gate they are meant to test.
      Check the line appears **exactly once** -- dotenv keeps the last
      occurrence, and a duplicate lower in the file silently wins (16 Sep 2026:
      a stray `=1` above and a `"0"` below made every dev submit land as
      pending). `next dev` reloads `.env` on save; no restart is needed, but
      confirm it: submit an ID from a throwaway account and the response's
      `meta.autoApproved` must be `false`.

---

## Scripts

```bash
npm run dev        # Next dev server on :3000
npm run dev:lan    # same, bound to 0.0.0.0 so a phone can reach it
npm run build      # production build
npm run start      # serve the production build
npm run lint       # eslint
npm run seed       # (re)seed the development data — idempotent
```

`scripts/` holds one-off and verification tooling, run with `npx tsx`. The
`verify-*.ts` files are acceptance harnesses for individual features:

```bash
npx tsx --env-file=.env scripts/verify-token-auth.ts
```

**They create and delete rows.** Run them on a **scratch schema**, never on
the live tables — see [Scratch schemas](#scratch-schemas-for-harnesses-and-a-second-dev-server)
below. Most need a dev server running on `:3100`
(`ACCEPT_BASE` overrides it); the two that register accounts
(`verify-email-verification`, `verify-mobile-auth`) need a *fresh* dev server
each, because registration is limited to 3 per hour per client and the limiter
lives in the server's memory.

> Most `verify-*.ts` failures on a fresh setup are environmental rather than
> real regressions — usually the register rate limit, a missing SMTP sink, or a
> harness process from an earlier run still holding port 2525 and its log file.
> Check those before chasing a failure. Two failures are **known and
> deliberate** on a seeded database and documented in the scripts themselves:
> `verify-valuation` section 4 (assumes the band path; the seed provides
> comparables) and `verify-moderation`'s "no API route writes `User.role`"
> (tripped by the admin role-management route; pending a decision on which rule
> wins).

`scripts/migrate-mysql-to-postgres.ts` is the one-shot data move from the old
MariaDB database. See [Coming from MySQL](#coming-from-mysql-teammates-read-this).

### Scratch schemas, for harnesses and a second dev server

Supabase's free tier is one database, so the scratch unit is a **schema** in
it: the live `DATABASE_URL` with `?schema=scratch_<name>` appended. The Prisma
CLI builds the tables there, and since 16 Sep 2026 `src/lib/prisma.ts` hands
the same parameter to the driver adapter, so the running code reads and writes
there too. (Before that the runtime silently ignored it and a harness that
believed it was on scratch was on live.) `scripts/scratch.ps1` does the whole
dance:

```powershell
.\scripts\scratch.ps1 -Run scripts\verify-bracket-libs.ts          # push, run, drop
.\scripts\scratch.ps1 -Push -Name scratch_http                      # a schema to keep
.\scripts\scratch.ps1 -Seed -Name scratch_http                      # seed it
.\scripts\scratch.ps1 -Dev  -Name scratch_http -Port 3001           # a dev server on it
.\scripts\scratch.ps1 -Drop -Name scratch_http
```

The HTTP harnesses (`verify-*-http`, `verify-v1-endpoints`,
`verify-bracket-trading`) drive a dev server, so the server has to be the one
bound to scratch: start it with `-Dev` on `:3001` and point the harness at it
(`ACCEPT_BASE=http://localhost:3001`). `verify-bracket-libs.ts` and
`verify-safezone-faucet.ts` refuse to run on `public` at all.

In PowerShell the URL is `"${base}?schema=x"`, **with braces**: `"$base?schema"`
reads a variable named `base?schema` and hands Prisma an empty string.

`scripts/check-new-enum-rows.ts` counts live rows that use an enum value an
older client does not know. Run it before pointing a `main` checkout at a
database a feature branch has migrated — Prisma refuses to read a row whose
enum column holds a value outside the generated type, so one such row is a
500 on every query that touches the table.

### TODO: brackets on the wire

Since 16 Sep 2026 every surface in the offer and trade flow shows other
people's items as **brackets**, never as a Leaves figure — but that is a
client-side rendering rule. `/api/v1/trades`, `/api/v1/items/[id]`, browse and
home still send `valueLeaves` for non-owner items, so the number is one proxy
away. **Next task after bracket trading merges:** send `bracket` instead of
`valueLeaves` for every item the viewer does not own, on every v1 route, and
move the client's `bracketOf()` calls to read the field. The grid tiles, the
feed cards, the offer picker, the trade rows and the notifications all
consume it, which is why it is its own task.

`scripts/backup-baylo-pg.ps1` backs up the live database and verifies the dump;
`scripts/pg-backup.ts` is the no-install dumper it falls back to, and also
restores and rehearses. See [Backups](#backups).

`scripts/backup-baylo.ps1`, `baseline-existing-db.ps1`, `set-premium.ps1` and
`apply-leaves-migration.ps1` shell out to XAMPP's `mysql.exe` and are **MySQL
only**. They still work against the fallback database and nothing else.

---

## Database and migrations

The schema is `prisma/schema.prisma` — 25 models, **Postgres via
`@prisma/adapter-pg`**. The generated client goes to `src/generated/prisma`
(not `node_modules`), so `npx prisma generate` is required after a fresh clone
and after any schema change.

A running `next dev` holds the client it started with. After `prisma generate`,
restart it before concluding a route is broken.

### One baseline migration

`prisma/migrations/` holds exactly one migration,
`20260915000000_postgres_baseline`, containing the whole schema. The header of
that file says why it exists and what is deliberately different from the MySQL
schema (25 extra indexes — InnoDB created one on every foreign-key column
implicitly, Postgres does not, so they are declared in the schema).

Two earlier chains are archived and read by nothing:

- `prisma/migrations-archive-mysql/` — the MySQL chain this replaced
  (`20260906000000_baseline` + 10), preserved because their comments carry the
  reasoning behind several schema decisions.
- `prisma/migrations-archive-pre-baseline/` — the 19-migration chain squashed
  on 2026-09-06, which could not build a database from empty.

### Adding a migration from here

**Never `prisma migrate dev` against the shared Supabase URL.** Two reasons,
and the second is the one that costs data: it needs a shadow database the
Supabase role cannot create, and when it decides the database has drifted from
the migration history it offers to RESET it — which on this URL means dropping
the live tables. `migrate deploy` only ever applies pending migrations forward
and has no reset path; it is the only migration command that should ever see
the live URL. For iterating on a schema, push it to a scratch schema instead
(`.\scripts\scratch.ps1 -Push -Name scratch_x`), which touches nothing live.

So: author the SQL from the diff, read it, save it, deploy it:

```bash
# 1. edit prisma/schema.prisma
# 2. generate the SQL for the difference between the live database and the schema
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema prisma/schema.prisma --script
# 3. read it. Save it as prisma/migrations/<YYYYMMDDHHMMSS>_<what_you_did>/migration.sql
# 4. apply it, regenerate, restart the dev server
npx prisma migrate deploy
npx prisma generate
```

Enum additions become `ALTER TYPE ... ADD VALUE`, which Postgres 17 runs fine
inside Prisma's migration transaction. Do not edit the baseline.

**A migration deployed from a branch changes the database for every branch.**
Prisma refuses to read a row whose enum column holds a value the generated
client does not model, so a value added on a feature branch and then USED
turns every `main` checkout into a 500 on that whole table — not on the
feature, on the table. Land the schema half (enum values and nullable columns,
no feature code) on `main` first, and run
`npx tsx --env-file=.env scripts/check-new-enum-rows.ts` before pointing a
`main` checkout at the live database. This is exactly what happened on
16 Sep 2026 and how it was closed.

### Coming from MySQL (teammates, read this)

If you have a working checkout against XAMPP/MariaDB, this is what happens when
you pull, in the order it happens:

1. **`npm install`.** The pull adds `@prisma/adapter-pg` and `pg`. Without
   this, the server dies on boot with `Cannot find module '@prisma/adapter-pg'`.
2. **`npx prisma generate`.** The client is generated per engine. Without this
   you have a MySQL client under a Postgres schema, and every query fails in
   ways that look like bugs in the code.
3. **A Supabase `DATABASE_URL`** — your own project, step 4 above. If you leave
   the `mysql://` one in place:
   - `prisma migrate deploy` stops with
     `Error: P1013 ... must start with the protocol postgresql:// or postgres://`.
   - The app connects to your MariaDB with the Postgres wire protocol and every
     query fails with `received invalid response: 59`. That message is the
     MariaDB handshake being misread. It is not a code bug.
4. **`npx prisma migrate deploy`**, then **`npm run seed`** (or the data move
   below). Then restart the dev server.

**Your local MySQL data is not touched by any of this.** Nothing on this branch
knows MariaDB exists. It just stops being read. If you want it on Postgres —
listings you made, accounts you tested with — move it once:

```bash
# reads MySQL with SELECT only, inside a consistent snapshot; writes nothing there.
# Target must be empty (skip the seed first, or pass --truncate to empty it).
MYSQL_URL="mysql://root:@127.0.0.1:3306/baylo" npx tsx --env-file=.env scripts/migrate-mysql-to-postgres.ts
```

It copies all 25 tables in foreign-key order, then verifies: per-table row
counts against MySQL, every foreign key for orphans, and
`SUM(User.leaves) == SUM(LeafTransaction.amount)` on both sides. It exits
non-zero if any disagree. `DATETIME` values travel as the literal stored text,
so the UTC instants Prisma wrote are the instants Prisma reads back — it was
checked value by value on the real data (509 timestamps, 0 mismatches).

**What is at risk in your local work:**

- **Uncommitted edits to these files will conflict**, because the migration
  touched them (one `mode: "insensitive"` per search filter, nothing else):
  `src/app/api/admin/users/route.ts`, `src/app/api/admin/access/route.ts`,
  `src/app/api/admin/listings/route.ts`, `src/app/admin/users/page.tsx`,
  `src/app/admin/listings/page.tsx`. Resolve by keeping both.
- **A migration you authored against MySQL and have not pushed** cannot be
  applied. `prisma/migrations/` is Postgres-only now (`migration_lock.toml`
  names one provider). Re-author it with `migrate diff` as above; the SQL will
  differ (`"quoted"` identifiers, `ALTER TYPE` for enums).
- **Raw SQL you wrote** (`$queryRaw`, `$executeRaw`) needs `"double-quoted"`
  identifiers — Postgres folds unquoted `camelCase` names to lower case — and
  positional `$1` placeholders instead of `?`. Every existing raw query was
  ported; see `src/app/api/v1/messages/conversations/route.ts` for the shape.
- **`contains` filters are case-sensitive on Postgres.** MySQL's collation hid
  that. Add `mode: "insensitive" as const` to any new search filter.
- **A caught unique-violation inside a `$transaction` aborts the whole
  transaction on Postgres.** MySQL rolled back only the statement. Use
  `createMany({ skipDuplicates: true })` and branch on `count`, as
  `src/lib/tasks.ts` now does, rather than `create` + catch `P2002`.

Nothing else in the application code changed for the engine. Your components,
routes and libraries are as you left them.

### Reverting to MySQL

**Three commands, not one line in `.env`, and here is why it is not one line.**
The Prisma client is generated per database engine — `datasource.provider` is
baked into `src/generated/prisma`, which is gitignored and so belongs to
whichever branch last ran `generate`. Changing `DATABASE_URL` alone leaves a
Postgres client talking to MariaDB, which fails with the
`received invalid response: 59` above.

```bash
git checkout mysql-fallback  # the last MySQL commit: adapter-mariadb, mysql provider, the MySQL migration chain
npx prisma generate          # regenerate the client for that provider
# .env: comment the postgresql:// line, uncomment the mysql:// line above it. Then restart the dev server.
```

`mysql-fallback` is a branch kept at the commit `main` pointed to before the
Postgres migration was merged, and `mysql-final-20260915` is an annotated tag on
the same commit. **`main` is Postgres now** — checking it out will not get you
back. Neither the branch nor the tag is deleted until the revert window closes.

The XAMPP database was never written to during the migration and has not been
dropped. Its last verified dump is `D:\BAYLO\backups\baylo-20260915-190207.sql`
(193.7 KB, 26 tables, 23 INSERTs, all five checks passed). If the database
itself is damaged, `scripts/backup-baylo.ps1 -VerifyOnly <file>` first, then
`mysql -u root < <file>`.

Going back onto Postgres is the same shape in reverse:
`git checkout main && npx prisma generate`, swap the `.env` lines, restart.

**Anything written to Supabase after the switch is not in MySQL.** The revert
returns the app to the data as it was on 2026-09-15 at 19:02. That is the
whole cost of reverting, and it grows every day.

### Closing the revert window

The fallback is worth keeping until the defense is over and the Postgres
database has carried real use for a while. After that, a dead connection
string and an unused driver stop being safety and start being the thing the
next person trips over. When you decide the window is closed, in one commit:

- delete the commented `mysql://` line from `.env` (and any `.env.bak-*`
  copies in the repo root);
- `npm uninstall @prisma/adapter-mariadb mariadb`;
- delete the MySQL-only scripts (`backup-baylo.ps1`, `baseline-existing-db.ps1`,
  `apply-leaves-migration.ps1`, `set-premium.ps1`) or rewrite `set-premium`
  for Postgres if it is still used;
- delete the `mysql-fallback` branch (the `mysql-final-20260915` tag is enough
  to find the commit again, and costs nothing);
- leave `migrate-mysql-to-postgres.ts` and `prisma/migrations-archive-mysql/`
  — they are history, and they do nothing unless run.

Until then, the `mysql://` line stays commented in `.env`, directly above the
live one, so the revert is a matter of moving a `#`.

### Backups

`scripts/backup-baylo-pg.ps1` dumps the Supabase database and then **verifies**
the dump before calling it a backup. It is the Postgres counterpart of
`backup-baylo.ps1` and applies the same five checks, for the same reason: on
26 Aug 2026 a backup reported success and was 991 bytes of nothing.

```bash
powershell -ExecutionPolicy Bypass -File scripts/backup-baylo-pg.ps1
powershell -ExecutionPolicy Bypass -File scripts/backup-baylo-pg.ps1 -Keep 14        # prune to the last 14
powershell -ExecutionPolicy Bypass -File scripts/backup-baylo-pg.ps1 -VerifyOnly D:\BAYLO\backups\baylo-pg-....sql
```

The checks: the dump tool's real exit code (never through a pipeline), a size
floor, the completion trailer, a table count, and actual row data. Plus a sixth
the MySQL script could not make — the dump records its own per-table row counts
and the ledger invariant, and both are read back and compared against the live
database, so a file that lost half a table disagrees with itself and is
rejected. A failed dump is renamed `*.FAILED` and the script exits non-zero.

**This matters more here than it would elsewhere.** The Supabase free tier takes
**no automatic backups**. A hosted database is not a backed-up database.

`scripts/backup-baylo.ps1` still exists and still works, but it dumps the
**MySQL fallback**, not the live database.

#### With or without pg_dump

`pg_dump` is the standard tool and the script prefers it whenever it is on PATH
(or at `C:\Program Files\PostgreSQL\*\bin`, or passed as `-PgDumpPath`). It is
a separate install:

```powershell
winget install -e --id PostgreSQL.PostgreSQL.17
```

That installs a server you do not have to run; the client tools are what you
want, and they land in `C:\Program Files\PostgreSQL\17\bin`. **Version 17 or
newer** — an older `pg_dump` refuses to read a 17 server, and the script detects
that and falls back rather than write a doubtful file.

**You do not need it.** With no PostgreSQL install at all, the script uses
`scripts/pg-backup.ts`, which speaks to the database through `pg` — already a
dependency — and writes a plain-SQL **data-only** dump. The trade-off, stated
plainly:

| | `pg_dump` | `pg-backup.ts` fallback |
|---|---|---|
| Install needed | yes | none |
| Captures schema | yes | no — the schema is `prisma/migrations` |
| Restore | `psql "$DATABASE_URL" -f file.sql` | `prisma migrate deploy`, then `pg-backup.ts restore file.sql` |
| Needs this repo to restore | no | **yes** |

The fallback's dependency on the repo is the reason to install `pg_dump`
eventually. It is not a reason to go unprotected in the meantime.

#### Restoring, and rehearsing it

```bash
# into a database whose schema is built and whose tables are empty
npx prisma migrate deploy
npx tsx --env-file=.env scripts/pg-backup.ts restore D:\BAYLO\backups\baylo-pg-....sql
```

`restore` refuses a target that already has rows unless you pass `--force`,
which truncates every table first. The whole restore is one transaction: it
lands completely or not at all.

**A backup nobody has restored is a hypothesis.** Rehearse one without touching
anything:

```bash
npx tsx --env-file=.env scripts/pg-backup.ts drill D:\BAYLO\backups\baylo-pg-....sql
```

`drill` builds the entire schema from the migrations in a throwaway
`restore_drill` schema beside `public`, loads the dump into it, compares every
table against both the file's own trailer and the live database, checks the
ledger invariant in the restored copy, confirms timestamps came back as the
same instants, and drops the schema again. `public` is only ever read, no locks
are taken on it, and it is safe to run while the app is up. Run it after any
change to the schema or to the dumper.

---

## Pasa Leaves, in one paragraph

Leaves have **no mint**. They enter the system only as a 20-Leaf signup grant at
email verification and as capped task rewards; between users they move only
through a settled trade, which writes a matched `TRADE_SPEND` / `TRADE_RECEIVE`
pair in one transaction. The system-wide invariant is therefore
`SUM(User.leaves) == SUM(LeafTransaction.amount)`, signed — the ledger is the
truth and the balance is its consequence. `prisma/seed.ts` re-derives and
asserts that invariant from the database after writing, and fails loudly rather
than seeding an unbalanced world. `User.lifetimeLeaves` is a separate,
monotonic number that only positive awards raise; it drives the rank ladder, and
receiving Leaves in a trade deliberately does not move it.

---

## Layout

```
prisma/
  schema.prisma                                25 models
  migrations/20260915000000_postgres_baseline  the whole schema, one file
  migrations-archive-mysql/                    the MySQL chain, for reference only
  migrations-archive-pre-baseline/             the pre-squash chain, for reference only
  seed.ts                                      npm run seed
src/
  app/api/          the REST API. /api/v1/* is the mobile surface.
  lib/              valuation, leaves, tasks, moderation, id-verification, auth
  generated/prisma  the generated client — npx prisma generate writes this
scripts/            seeding, the MySQL->Postgres data move, and the verify-* acceptance harnesses
proxy.ts            route guards. NOT middleware.ts — see below.
auth.ts             NextAuth configuration
```

> **Route guards live in `src/proxy.ts`.** This is Next.js 16, where
> `middleware.ts` is ignored without warning. If a guard seems not to run, check
> you are editing `src/proxy.ts`.

---

## The mobile client

[`../baylo-mobile`](../baylo-mobile) — Expo / React Native, talks to this server
over `/api/v1`. Set it up after this repo is running, and read
[`../baylo-mobile/README.md`](../baylo-mobile/README.md) first: the phone cannot
reach `localhost`, so there are a few things to get right in order.
