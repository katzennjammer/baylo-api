# Schema v2 migrations waiting for their phase

Week 2 ships schema v2 in three phases, each its own commit, each able to stand
alone so a high-risk phase can be dropped at the go/no-go:

| Phase | Migration | Moves into `prisma/migrations/` with |
|---|---|---|
| A core   | `20261003000000_schema_v2_core`   | already there |
| B ledger | `20261003000001_schema_v2_ledger` | the Phase B commit |
| C trade  | `20261003000002_schema_v2_trade`  | the Phase C commit |

A migration in THIS folder is invisible to `prisma migrate`, so `schema.prisma`,
`prisma/migrations/` and the code always describe the same database. Phase B/C
each move their folder back and change `schema.prisma` in the same commit.
`scripts/schema-v2/build-scratch.ts` applies only the v2 migrations present in
`prisma/migrations/`. See docs/schema-v2.md, section 2e (separability).
