# Running this app

*Written 23 September 2026. If you have been away for a few days, read section 2
first — "which branch am I on" explains most of the confusion.*

This is the **short, plain-English** version. `SETUP.md` is the long version with
all the reasoning; this file is just "what do I type, and what should happen".

---

## The 30-second version

```powershell
# the API + web admin
cd D:\BAYLO\baylo
npm run dev            # then open http://localhost:3000

# the phone app (separate terminal, separate folder)
cd D:\BAYLO\baylo-mobile
npm run phone          # starts the API and Metro too, if they are not already up
```

Log in with `maria@baylo.test` / `BayloDev123!`.

---

## 1. What folder do I run this from, and what starts it?

There are **two separate projects** in `D:\BAYLO`, each with its own folder, its
own `npm install`, its own `.env`, and its own branch. The phone app is useless
without the API, so the API starts first.

### `baylo/` — the API and the web admin side (Next.js)

```powershell
cd D:\BAYLO\baylo
npm run dev
```

| Command | What it does |
|---|---|
| `npm run dev` | Starts the dev server on **http://localhost:3000**. Only this machine can reach it. |
| `npm run dev:lan` | The same thing, but reachable from outside this laptop, so **your phone can talk to it**. Use this one whenever the mobile app is involved. |
| `npm run seed` | Refills the database with the 4 test users, 8 listings and 22 Safe-Zone Hubs. Safe to re-run. |
| `npm run build` / `npm start` | Production build. You almost never need these day to day. |

**What a successful start looks like:** a few seconds of output ending in
something like `✓ Ready in 2.4s` and `- Local: http://localhost:3000`. Open that
URL, sign in as `maria@baylo.test` (password `BayloDev123!`), and you should see
four available listings plus one pending offer on the rattan armchair.

**Pages feel slow, about a second per action?** Normal, not a bug. The database
is hosted in Singapore, so every request crosses the internet. It was ~50 ms back
when the database lived on this laptop. It does not anymore.

**After a fresh clone, or after pulling other people's changes:**

```powershell
npm install            # only if package.json changed
npx prisma generate    # required after ANY change to prisma/schema.prisma
```

### `baylo-mobile/` — the phone app (Expo / React Native)

Different folder, different command. It needs a **real Android phone**, Android
11 or newer.

```powershell
cd D:\BAYLO\baylo-mobile
npm run phone          # works out your laptop's address and connects the phone
```

`npm run phone` is the one to reach for — it starts the API and Metro itself if
they are not already running, and it figures out the network address the phone
needs.

To see the three pieces separately (better when something is broken):

```powershell
# Terminal 1 — the API, reachable from outside this laptop
cd D:\BAYLO\baylo        ; npm run dev:lan

# Terminal 2 — connect the phone
cd D:\BAYLO\baylo-mobile ; npm run phone

# Terminal 3 — Metro (the thing that serves the JavaScript to the phone)
cd D:\BAYLO\baylo-mobile ; npm start
```

**What a successful start looks like:** Metro prints a QR code and sits waiting
on port **8081**. Press **a** in that terminal to open the app on the phone. The
sign-in screen appears, and the same seeded accounts work.

> `npm start` opens the **development build** — the custom Baylo app already
> installed on the phone. `npm run start:go` opens **Expo Go** instead, which
> cannot do location, Google sign-in, or anything else native. Use Expo Go only
> on purpose, never by accident.

---

## 2. What branch am I on, and does that matter?

**What a branch is:** a branch is one named version of the project's files. You
can keep several side by side — one with the new organisations feature, one
without — and "checking out" a branch swaps the files in your folder over to that
version. Your folder only ever holds one branch's files at a time.

**How to check, right now:**

```powershell
cd D:\BAYLO\baylo
git branch --show-current
```

`git status` tells you the same thing, plus which files you have edited.

**Does it matter for running the app?** Yes, but only in the simple sense:

> **Running the app uses whatever is checked out in that folder right now.**
> That is all. It has nothing to do with what has been merged into `main`, what
> has been pushed to GitHub, or what anyone else is working on. If the files are
> sitting in your folder, they are what runs.

Two things that catch people out:

- **Each repo has its own branch.** `baylo/` and `baylo-mobile/` are checked out
  independently — one can be on a different branch from the other. Check both.
  Right now both happen to be on `orgs-and-perishables`.
- **Switching branches can change the database shape.** If the branch you switch
  to has a different `prisma/schema.prisma`, run `npx prisma generate` and
  restart the dev server, or you get confusing 500 errors. See section 5.

---

## 3. What branches exist, and which should I work from?

### Work from `orgs-and-perishables` — in **both** repos.

That is where the newest work is (23 September 2026, in both repos), it is what
is checked out right now, and it already contains everything the other branches
contain.

### `baylo/` (the API)

| Branch | Where it lives | What is on it |
|---|---|---|
| **`orgs-and-perishables`** | local only — never pushed | **Newest, most complete.** Organisation accounts and perishable listings, plus the raw-SQL schema fix and the achievements-display fix. 11 commits ahead of `main`. **Use this one.** |
| `main` | local + GitHub | The stable base. Has the organisations/perishables *schema*, but not the feature work built on it. Your local copy is **2 commits ahead** of GitHub — those two have not been pushed. |
| `bracket-trading` | local + GitHub | Value brackets, the premium gate, listing value review and appeals (18 Sep). Already merged into `main`. |
| `postgres-migration` | local only | The move from MySQL to Supabase Postgres (16 Sep). Already merged into `main`. Historical now. |
| `home-feed-trust-tier` | local + GitHub | Older home-feed work, likes and comments, trust tiers (5 Sep). Already merged into `main`. |
| `mysql-fallback` | local + GitHub | **The escape hatch.** The last version that ran on local MySQL/XAMPP instead of Supabase. Only touch it if Supabase is unreachable and you must work offline — it needs a different `DATABASE_URL` and its own `npx prisma generate`. |
| `origin/ci/scheduled-backups` | GitHub only | Automated encrypted database backups. Nothing to run locally. |

### `baylo-mobile/` (the phone app)

| Branch | Where it lives | What is on it |
|---|---|---|
| **`orgs-and-perishables`** | local only — never pushed | **Newest.** Organisation identity and perishable details on the listing screen. 9 commits ahead of `main`. **Use this one.** |
| `main` | local + GitHub | The stable base, last touched 19 Sep. |
| `bracket-trading` | local + GitHub | Status lines, comment replies, notification routing, trade summary (up to 21 Sep). **Not** fully merged into mobile `main` — 4 commits live only here. |
| `auth-fixes-and-video` | local + GitHub | The feed social row and the overflow menu. Merged into `main`. |
| `master` | local only | Very old — the original login redesign. Ignore it. |

**Worth knowing:** `orgs-and-perishables` exists **only on this laptop**, in both
repos. It is not on GitHub. If this machine dies, that work is gone.

---

## 4. What has to be running or configured before it starts?

### Installed on this machine

- **Node.js 20.9+** (you have 22.20.0) and **npm 10+**. Check with `node -v`.
- **`adb`** on your PATH, for the phone only. `adb --version` should answer.
- **No database to install or start.** No XAMPP, no MariaDB, nothing. The
  database is hosted at Supabase and reached over the internet — so if your Wi-Fi
  is down, the app does not work.

### Services it talks to (all hosted, none of them local)

| Service | Used for | If it is unavailable |
|---|---|---|
| Supabase (Postgres) | everything | the app cannot do anything useful |
| Cloudinary | listing photos | uploads fail, the rest works |
| Pusher | live messages and notifications | chat does not update by itself |
| Anthropic (Claude) | photo category suggestions, duplicate checks | valuation still works — that half is plain arithmetic |
| Gmail SMTP | verification emails | emails silently do not send; **login still works** |

### `baylo/.env` — names only, no values

This file is deliberately **not in git**. If it is missing, copy `.env.example`
to `.env`. Only the first two are genuinely required to start.

**Required**

| Name | What it is for |
|---|---|
| `DATABASE_URL` | The Supabase connection string used by migrations and scripts (port 5432, the session pooler). |
| `AUTH_SECRET` | The key that signs login sessions. Yours alone — generate it, never share it. |

**Strongly recommended**

| Name | What it is for |
|---|---|
| `DATABASE_POOL_URL` | The same database on port 6543, used by the running app. Without it, logins can queue for 30–80 seconds after a hard restart. |
| `NEXTAUTH_URL` | The address the web app believes it lives at. Leave the default locally. |

**Capabilities — each one only breaks its own feature if left blank**

| Name | What it is for |
|---|---|
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Photo upload and hosting. |
| `PUSHER_APP_ID`, `PUSHER_SECRET`, `NEXT_PUBLIC_PUSHER_KEY`, `NEXT_PUBLIC_PUSHER_CLUSTER` | Realtime messaging and notifications. |
| `ANTHROPIC_API_KEY` | Claude photo classification and the AI half of duplicate detection. Bills per call. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | "Continue with Google" on the web. |
| `GOOGLE_NATIVE_CLIENT_IDS` | The phone app's Google sign-in. Must be set here *and* in the mobile `.env`, or it 401s no matter how right the app looks. |
| `EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORT`, `EMAIL_SMTP_USER`, `EMAIL_SMTP_PASS`, `EMAIL_FROM`, `EMAIL_LOGO_URL` | Verification emails. Fine to leave blank — the seeded accounts are already verified. |
| `SWAP_CODE_KEY` | Encrypts the 6-digit in-person swap confirmation codes. |
| `ID_VERIFICATION_DEV_AUTO_APPROVE` | Dev shortcut that approves submitted IDs instantly. **Must be `"0"` before any demo**, and must appear exactly once in the file — a duplicate further down silently wins. |
| `PHASH_THRESHOLD`, `DUPLICATE_ACTION` | Tuning for duplicate-photo detection. |
| `TRUST_PROXY` | Production only, for running behind Cloudflare. Leave it off locally. |

### `baylo-mobile/.env` — three public values

| Name | What it is for |
|---|---|
| `EXPO_PUBLIC_API_URL` | Your laptop's address on the network, e.g. `http://192.168.1.10:3000`. **Never `localhost`** — on a phone, `localhost` means the phone. |
| `EXPO_PUBLIC_PUSHER_KEY`, `EXPO_PUBLIC_PUSHER_CLUSTER` | Realtime messages. |

`EXPO_PUBLIC_API_URL` is baked into the app when it builds, so editing the file
needs `npx expo start --clear` to take effect. Easier: use the **gear icon on the
sign-in screen**, which overrides it instantly with no rebuild.

### Missing vs. broken — how to tell them apart

| What you see | What it means |
|---|---|
| The server exits immediately with an error naming a variable | **Missing config.** Something required is not in `.env`. |
| The server says Ready, but one feature fails (upload, chat, email) | **Missing optional config** for that one feature. Everything else is fine. |
| The server says Ready, but *every* page errors | **Broken.** Usually the Prisma client — see section 5. |
| The phone shows a spinner forever | **Wrong address**, not a code problem, nine times out of ten. |

---

## 5. If something looks broken, check these three first

These are failures that have actually happened in this project, not generic
advice.

### 1. Did you change the schema or switch branches? → regenerate, then restart

A running dev server holds on to the database client it started with. After
**any** change to `prisma/schema.prisma`, and after **any** branch switch that
changes it, you need both steps:

```powershell
npx prisma generate
# then stop the dev server (Ctrl+C) and start it again.
# regenerating alone is NOT enough — the running server never notices.
```

**The symptom to recognise:** a route returns a 500, and what comes back is an
HTML error page instead of JSON. It looks exactly like the route is broken. It is
not — it is reading an outdated client. This has cost hours more than once.

### 2. Dev server acting strange? → kill it properly, and delete `.next`

Two specific traps in this project:

- **Next 16 allows only one dev server per folder.** A second one prints
  `Another next dev server is already running` and exits, whatever port you gave
  it. Stop the first one before starting another.
- **Every API route suddenly 404s.** That happens when an aborted start left the
  route list half-written. The server still says "Ready" and lies to you:

  ```powershell
  Remove-Item -Recurse -Force .next
  npm run dev
  ```

### 3. Phone problem? → it is almost always the address

```powershell
cd D:\BAYLO\baylo-mobile
npm run phone:show      # prints the address the phone is ACTUALLY using
```

Then tap the **gear** on the sign-in screen and press **Test**. A **400 is a
pass** — it means something on the other end read the request at all. A timeout
or "connection refused" means the address is wrong, or the API was started with
`npm run dev` instead of `npm run dev:lan`.

Also: do not mix connection methods. `adb reverse` plus wireless debugging plus a
laptop hotspot, all at once, is what has broken this setup repeatedly. Use the
path `npm run phone` sets up and leave it alone.

### Bonus: when it is a script failing, not the app

- **`REFUSING TO RUN: ... DATABASE_URL points at schema 'public'`** — not a bug,
  it is the safety guard. Scripts that write rows refuse to touch the live
  database. Run them against a scratch schema instead:
  `.\scripts\scratch.ps1 -Run scripts\<name>.ts`.
- **A `verify-*.ts` harness fails** — on a fresh setup that is usually
  environmental rather than a real regression: the 3-registrations-per-hour rate
  limit, a missing local mail sink, or a leftover harness process from an earlier
  run. Rule those out before assuming the feature is broken.

---

## Where to look next

- `SETUP.md` (this folder) — full setup, migrations, backups, scratch schemas.
- `../baylo-mobile/SETUP.md` — phone connection in depth, Google sign-in, EAS builds.
- `README.md` — what the product actually is, for when someone asks.
