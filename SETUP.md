# Baylo — API and web app

Baylo is a non-monetary trading platform: people swap things they own, and the
only unit that changes hands is **Pasa Leaves**, which cannot be bought. This
repo is the Next.js app — the web UI, the REST API under `/api`, the versioned
mobile API under `/api/v1`, and the Prisma schema.

The Expo mobile client lives in a sibling repo, **[`../baylo-mobile`](../baylo-mobile)**,
and talks to this server over `/api/v1` with a Bearer token. It needs this
server running first. If you are setting up both, do this one first and then
follow [`../baylo-mobile/README.md`](../baylo-mobile/README.md).

---

## Setup

Written for someone who has never seen this project. Seven steps, about ten
minutes, most of it `npm install`.

### 1. Prerequisites

| | Version | Notes |
|---|---|---|
| **Node.js** | 20.9+ (22 LTS recommended) | `node --version`. Next 16 and the `tsx` seed runner both need ≥20.9. |
| **npm** | 10+ | Ships with Node. |
| **MariaDB or MySQL** | MariaDB 10.4+ / MySQL 8+ | Any install works. On Windows, [XAMPP](https://www.apachefriends.org/) is the path of least resistance and is what this project is developed against. |
| **Git** | any | |

Start MariaDB before going further. With XAMPP that is the **Start** button next
to MySQL in the XAMPP Control Panel.

> **If you use XAMPP, never stop MariaDB by killing the process or closing the
> console window.** Use the Control Panel's Stop button and let it shut down.
> An unclean shutdown corrupts the Aria system tables and the server then
> refuses to start — it has happened to this project more than once and costs
> an hour each time.

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
| `DATABASE_URL` | **Yours.** Your own local database. Nobody can give you this — see step 4. |
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

Prisma creates *tables*, not the schema itself, so the database has to exist
first. XAMPP on Windows:

```bash
"D:\Xampp\mysql\bin\mysql.exe" -u root -e "CREATE DATABASE baylo"
```

Anywhere else:

```bash
mysql -u root -p -e "CREATE DATABASE baylo"
```

Then make sure `DATABASE_URL` in `.env` matches the name, user and password you
just used. A default XAMPP install is user `root` with **no** password, which is
the empty gap in `mysql://root:@127.0.0.1:3306/baylo`.

### 5. Generate the client and create the tables

```bash
npx prisma generate      # writes the typed client to src/generated/prisma
npx prisma migrate deploy
```

`migrate deploy` applies one migration, `20260906000000_baseline`, which builds
all 25 tables. It should finish in a couple of seconds and print
`All migrations have been successfully applied.`

> **Use `migrate deploy`, not `migrate dev`.** `migrate dev` is for authoring new
> migrations and will offer to reset the database if it thinks anything drifted.
> You never need it to set up.

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

  leaf invariant OK   SUM(User.leaves) = 200 = SUM(LeafTransaction.amount) = 200
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

Use `npm run dev:lan` instead if a phone or emulator needs to reach this server
— it binds `0.0.0.0` rather than loopback. See
[`../baylo-mobile`](../baylo-mobile).

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

> Most `verify-*.ts` failures on a fresh setup are environmental rather than
> real regressions — usually the register rate limit, a missing SMTP sink, or
> leaked database connections from an earlier run. Check those before chasing a
> failure.

---

## Database and migrations

The schema is `prisma/schema.prisma` — 25 models, MariaDB via
`@prisma/adapter-mariadb`. The generated client goes to `src/generated/prisma`
(not `node_modules`), so `npx prisma generate` is required after a fresh clone
and after any schema change.

### One baseline migration

`prisma/migrations/` holds exactly one migration,
`20260906000000_baseline`, containing the whole schema.

It was squashed on 2026-09-06 because the previous 19-migration chain **could
not build a database from empty.** `init` created six tables; the next migration
altered `User.points`, `Offer` and `WalletTransaction`, none of which any
migration ever created — nine of the 25 tables had only ever reached a database
through `prisma db push`. So `migrate deploy` on a fresh clone always died on
the second migration. The chain also carried one-off data repairs pinned to row
ids from one laptop.

The pre-squash chain is in git history and archived at
`prisma/migrations-archive-pre-baseline/`. Nothing reads it; it is kept so the
reasoning in those files is not lost.

### Adding a migration from here

Normal Prisma workflow. Edit `prisma/schema.prisma`, then:

```bash
npx prisma migrate dev --name what_you_did
```

New migrations stack on top of the baseline as usual. Do not edit the baseline.

### If you already had a database before the squash

A database created after the squash needs nothing. A database that predates it
is already past every migration in the old chain, and `prisma migrate status`
will fail with a 20-line list of migrations that are applied but no longer on
disk. Fix it with:

```bash
powershell -ExecutionPolicy Bypass -File scripts/baseline-existing-db.ps1 -DryRun   # look first
powershell -ExecutionPolicy Bypass -File scripts/baseline-existing-db.ps1
```

That takes a verified backup, replaces the superseded `_prisma_migrations` rows
with a single row naming the baseline, and confirms `migrate status` is happy.
It touches **only** Prisma's own bookkeeping table: `migrate resolve --applied`
records a migration as applied precisely so that its SQL does *not* run, so no
DDL executes and no data table is read or written. It is safe to run twice.

The same thing by hand, if you would rather see each step:

```bash
powershell -ExecutionPolicy Bypass -File scripts/backup-baylo.ps1
mysql -u root -D baylo -e "DELETE FROM _prisma_migrations WHERE migration_name <> '20260906000000_baseline'"
npx prisma migrate resolve --applied 20260906000000_baseline
npx prisma migrate status   # → up to date
```

### Backups

`scripts/backup-baylo.ps1` dumps the database and then **verifies** the dump
before calling it a backup — exit code, size floor, the `Dump completed`
trailer, a table count and at least one `INSERT`. It exists because a backup
once reported success and was 991 bytes of nothing.

```bash
powershell -ExecutionPolicy Bypass -File scripts/backup-baylo.ps1
powershell -ExecutionPolicy Bypass -File scripts/backup-baylo.ps1 -VerifyOnly path\to\dump.sql
```

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
  schema.prisma                       25 models
  migrations/20260906000000_baseline  the whole schema, one file
  migrations-archive-pre-baseline/    the squashed chain, for reference only
  seed.ts                             npm run seed
src/
  app/api/          the REST API. /api/v1/* is the mobile surface.
  lib/              valuation, leaves, tasks, moderation, id-verification, auth
  generated/prisma  the generated client — npx prisma generate writes this
scripts/            seeding, backups, and the verify-* acceptance harnesses
proxy.ts            route guards. NOT middleware.ts — see below.
auth.ts             NextAuth configuration
```

> **Route guards live in `proxy.ts`.** This is Next.js 16, where `middleware.ts`
> is ignored without warning. If a guard seems not to run, check you are editing
> `proxy.ts`.

---

## The mobile client

[`../baylo-mobile`](../baylo-mobile) — Expo / React Native, talks to this server
over `/api/v1`. Set it up after this repo is running, and read
[`../baylo-mobile/README.md`](../baylo-mobile/README.md) first: the phone cannot
reach `localhost`, so there are a few things to get right in order.
