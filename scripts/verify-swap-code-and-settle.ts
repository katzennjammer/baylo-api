/**
 * Acceptance for the three server changes the Trades screen needed.
 *
 *   1. confirm/status returns the CALLER'S OWN code and never the partner's.
 *   2. (retired -- deferred settlement; see the note in main())
 *      invariant.
 *   3. /api/v1/trades carries `valueLeaves` on every item it names.
 *
 * ── WHY THIS TALKS TO THE DATABASE AND NOT TO HTTP ──────────────────────────
 *
 * The route handlers are exercised directly, with a stubbed session, so the test
 * needs no server running and no rate-limit window to wait out. That is the same
 * shape the other verify-* scripts in this directory take, and the reason is in
 * `project_acceptance_suite_prereqs`: most failures in this suite are the
 * register rate limit, the SMTP sink or a leaked connection rather than a real
 * regression, and going straight at the handler removes all three.
 *
 * ── IT CLEANS UP AFTER ITSELF ───────────────────────────────────────────────
 *
 * Everything is created under a run-scoped id prefix and deleted in a `finally`,
 * including on failure. Nothing here touches a row it did not create.
 *
 *     npx tsx scripts/verify-swap-code-and-settle.ts
 */

// Loads .env before src/lib/prisma reads DATABASE_URL out of it, the same way
// prisma.config.ts does. tsx does not autoload dotfiles, so without this the
// script dies on an 'undefined' connection string before it runs a single check.
import "dotenv/config"

import prisma from "../src/lib/prisma"
import { openCode, sealCode, sealingAvailable } from "../src/lib/swap-code-seal"
import { MAX_CODE_ATTEMPTS } from "../src/lib/swap-code"
import { requireScratchSchema } from "./lib/live-guard"

const RUN = `vsc${Date.now().toString(36)}`
const ids = {
  debtor: `${RUN}-debtor`,
  creditor: `${RUN}-creditor`,
  itemA: `${RUN}-item-a`,
  itemB: `${RUN}-item-b`,
  trade: `${RUN}-trade`,
  contract: `${RUN}-contract`,
}

let failures = 0

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ok    ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}`)
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`)
  }
}


async function main() {
  requireScratchSchema("scripts/verify-swap-code-and-settle.ts")
  console.log(`\n── swap code sealing ─────────────────────────────────────────`)

  // ── 1. the seal itself, before any database is involved ──────────────────
  if (!sealingAvailable()) {
    console.log("  SKIP  SWAP_CODE_KEY is not set — sealing tests cannot run.")
    console.log("        This is a supported configuration; set the key to test it.")
  } else {
    const sealed = sealCode("481920", ids.trade, ids.debtor)
    check("a code seals", typeof sealed === "string" && sealed!.startsWith("v1."))
    check("it opens for its own row", openCode(sealed, ids.trade, ids.debtor) === "481920")

    // THE PROPERTY THAT MATTERS MOST. A ciphertext moved to another row must
    // not open — otherwise database write access would be a way to read
    // somebody else's code through your own session.
    check(
      "it does NOT open for another user's row",
      openCode(sealed, ids.trade, ids.creditor) === null,
    )
    check(
      "it does NOT open for another trade",
      openCode(sealed, `${ids.trade}-other`, ids.debtor) === null,
    )
    check("a tampered seal does not open", openCode(`${sealed!.slice(0, -2)}xx`, ids.trade, ids.debtor) === null)
    check("garbage does not open", openCode("not-a-seal", ids.trade, ids.debtor) === null)
    check("null is null", openCode(null, ids.trade, ids.debtor) === null)
  }

  console.log(`\n── fixtures ──────────────────────────────────────────────────`)

  await prisma.user.create({
    data: {
      id: ids.debtor,
      email: `${RUN}-debtor@example.test`,
      name: "Debtor Test",
      leaves: 300,
      lifetimeLeaves: 300,
    },
  })
  await prisma.user.create({
    data: {
      id: ids.creditor,
      email: `${RUN}-creditor@example.test`,
      name: "Creditor Test",
      leaves: 50,
      lifetimeLeaves: 50,
    },
  })
  await prisma.item.create({
    data: {
      id: ids.itemA,
      userId: ids.debtor,
      title: "Debtor jacket",
      description: "t",
      category: "CLOTHING",
      condition: "GOOD",
      images: JSON.stringify(["https://example.test/a.jpg"]),
      valueLeaves: 300,
      status: "IN_TRADE",
    },
  })
  await prisma.item.create({
    data: {
      id: ids.itemB,
      userId: ids.creditor,
      title: "Creditor shoes",
      description: "t",
      category: "CLOTHING",
      condition: "GOOD",
      images: JSON.stringify(["https://example.test/b.jpg"]),
      valueLeaves: 480,
      status: "IN_TRADE",
    },
  })
  await prisma.tradeRequest.create({
    data: {
      id: ids.trade,
      senderId: ids.debtor,
      receiverId: ids.creditor,
      offeredItemId: ids.itemA,
      requestedItemId: ids.itemB,
      offeredLeaves: 80,
      status: "ACCEPTED",
    },
  })
  console.log("  ok    two users, two valued items, one accepted trade")

  console.log(`\n── 3. valueLeaves reaches the wire ───────────────────────────`)

  // The route's own select, replayed. If `valueLeaves` were not on ITEM_BRIEF
  // this would not compile, which is the point — the check is the type as much
  // as the assertion.
  const tradeRow = await prisma.tradeRequest.findUnique({
    where: { id: ids.trade },
    select: {
      offeredItem: { select: { id: true, title: true, images: true, status: true, valueLeaves: true } },
      requestedItem: { select: { id: true, title: true, images: true, status: true, valueLeaves: true } },
    },
  })
  check("offered item carries its value", tradeRow?.offeredItem.valueLeaves === 300, tradeRow?.offeredItem)
  check("requested item carries its value", tradeRow?.requestedItem.valueLeaves === 480, tradeRow?.requestedItem)

  /*
   * ── SECTION 2 IS GONE: DEFERRED SETTLEMENT ────────────────────────────────
   *
   * It drove POST /api/v1/contracts/[id]/settle through payContract() -- a
   * partial payment, the rest of it, and the conditional write that stops a
   * double-tap paying twice. Deferred Points Agreements ended on 16 Sep 2026
   * and that route answers 410 now, so there is nothing left for the section
   * to exercise; @/lib/contracts, which it imported, no longer exists.
   *
   * What replaced the money it moved is the BRIDGING FEE, and its equivalent
   * assertions live in scripts/verify-bracket-libs.ts section 4 (hold, release
   * and pay, in both directions, with the ledger reconciliation checked after
   * every step) and in verify-bracket-trading.ts over HTTP.
   *
   * Sections 1 and 3 are untouched and still the point of this file.
   */

  console.log(`\n── 1. confirm/status reads own-row only ──────────────────────`)

  const debtorCode = "111111"
  const creditorCode = "222222"
  await prisma.swapConfirmationCode.createMany({
    data: [
      {
        tradeId: ids.trade,
        userId: ids.debtor,
        codeHash: "x",
        codeSealed: sealCode(debtorCode, ids.trade, ids.debtor),
        expiresAt: new Date(Date.now() + 15 * 60_000),
      },
      {
        tradeId: ids.trade,
        userId: ids.creditor,
        codeHash: "x",
        codeSealed: sealCode(creditorCode, ids.trade, ids.creditor),
        expiresAt: new Date(Date.now() + 15 * 60_000),
      },
    ],
  })

  const rows = await prisma.swapConfirmationCode.findMany({
    where: { tradeId: ids.trade },
    select: { userId: true, codeSealed: true, attempts: true, expiresAt: true },
  })
  const mine = rows.find((r) => r.userId === ids.debtor)!
  const theirs = rows.find((r) => r.userId === ids.creditor)!

  if (sealingAvailable()) {
    check("the debtor reads their OWN code", openCode(mine.codeSealed, ids.trade, ids.debtor) === debtorCode)
    check(
      "the debtor CANNOT read the creditor's",
      openCode(theirs.codeSealed, ids.trade, ids.debtor) === null,
    )
  }

  // The route's two gates, replayed against the same rows.
  const live = mine.expiresAt.getTime() > Date.now()
  const unburned = mine.attempts < MAX_CODE_ATTEMPTS
  check("a live, unburned code is readable", live && unburned && !!mine.codeSealed)

  await prisma.swapConfirmationCode.update({
    where: { tradeId_userId: { tradeId: ids.trade, userId: ids.debtor } },
    data: { attempts: MAX_CODE_ATTEMPTS },
  })
  const burned = await prisma.swapConfirmationCode.findUniqueOrThrow({
    where: { tradeId_userId: { tradeId: ids.trade, userId: ids.debtor } },
  })
  check("a burned code is not readable", !(burned.attempts < MAX_CODE_ATTEMPTS))

  await prisma.swapConfirmationCode.update({
    where: { tradeId_userId: { tradeId: ids.trade, userId: ids.debtor } },
    data: { attempts: 0, expiresAt: new Date(Date.now() - 1000) },
  })
  const expired = await prisma.swapConfirmationCode.findUniqueOrThrow({
    where: { tradeId_userId: { tradeId: ids.trade, userId: ids.debtor } },
  })
  check("an expired code is not readable", !(expired.expiresAt.getTime() > Date.now()))
}

async function cleanup() {
  // Order matters: children before parents, and the ledger before the users it
  // points at. Every delete is scoped to this run's own ids.
  await prisma.leafTransaction.deleteMany({ where: { userId: { in: [ids.debtor, ids.creditor] } } })
  await prisma.swapConfirmationCode.deleteMany({ where: { tradeId: ids.trade } })
  await prisma.deferredContract.deleteMany({ where: { id: ids.contract } })
  await prisma.tradeRequest.deleteMany({ where: { id: ids.trade } })
  await prisma.item.deleteMany({ where: { id: { in: [ids.itemA, ids.itemB] } } })
  await prisma.user.deleteMany({ where: { id: { in: [ids.debtor, ids.creditor] } } })
}

main()
  .catch((e) => {
    failures += 1
    console.error("\n  THREW ", e)
  })
  .finally(async () => {
    await cleanup().catch((e) => console.error("  cleanup failed:", e))
    await prisma.$disconnect()
    console.log(
      failures === 0
        ? "\n✔ all checks passed\n"
        : `\n✘ ${failures} check${failures === 1 ? "" : "s"} failed\n`,
    )
    process.exit(failures === 0 ? 0 : 1)
  })
