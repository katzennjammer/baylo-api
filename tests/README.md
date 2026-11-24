# Unit tests (admin and API)

```bash
npm test
```

Runs every `tests/unit/*.test.ts` with Node's built-in test runner (no new test framework) and writes the
unit-testing table to `tests/report/unit-test-report.md` and `.csv`.

To put your name in the **Proponent** column:

```bash
TESTER="Surname, Given N." npm test
```

## Adding a case

```ts
const c = suite("Admin: User Suspension");
c("Suspend Account", "Admin gives no reason", "Refused (400)", async () => {
  // assertions
});
```

The four labels become the Module / Unit / Description / Expected columns. Case IDs, date, Actual Result and
PASSED/FAILED are generated. A new module name must also be added to `MODULE_ORDER` in `support/reporter.mjs`
to control table order.

## How the admin tests work

Tests import `support/admin-env.ts` first. It replaces the session, `next/headers` and the Prisma client with
fakes (Node `--experimental-test-module-mocks`), then runs the real `/api/admin/*` route handlers. Any table a
test did not fake throws `DB touched`, which is how a test proves a request was refused before reaching data.

Not covered: real database queries, Next.js rendering of admin pages, and routes outside `/api/admin`
(mobile app routes are exercised by the app's own tests only through a scripted `fetch`).
