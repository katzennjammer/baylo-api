<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Branches: the defense server runs `integration/defense`

The defense server runs `integration/defense` in BOTH repos (this API and baylo-mobile).

- Finished features merge INTO `integration/defense` with `git merge --no-ff` (a real merge commit). No rebase, no force-push.
- `main` is merged later, with the team. Do not merge `integration/defense` into `main`, or `main` into it, on your own.

## Schema changes (freeze lifted 28 Nov 2026)

The pre-defense schema freeze (11 Oct – 28 Nov 2026) is over: the owner lifted it for the post-defense revisions. The database is now **29 tables + 1 view** (`ItemWantedCategorySummary`); the newest migration is `20261128000000_bracket_scheme`.

- Schema changes still need the owner's OK first. Keep migrations additive where possible and say what they change.
- `npx tsx scripts/verify-schema-freeze.ts` pins the model count, field counts and newest migration. When an approved change lands, re-pin it in the same commit. Run it before every commit that touches `prisma/`.
