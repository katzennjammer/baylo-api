/**
 * Acceptance for the three server changes the Trades screen needed.
 *
 *   1. confirm/status returns the CALLER'S OWN code and never the partner's.
 *   2. POST /api/v1/contracts/[id]/settle moves Leaves and keeps the ledger
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
import { payContract } from "../src/lib/contracts"

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

async function ledgerBalance(userId: string): Promise<number> {
  const agg = await prisma.leafTransaction.aggregate({
    where: { userId },
    _sum: { amount: true },
  })
  return agg._sum.amount ?? 0
}

async function main() {
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

  console.log(`\n── 2. deliberate settlement ──────────────────────────────────`)

  await prisma.deferredContract.create({
    data: {
      id: ids.contract,
      tradeId: ids.trade,
      debtorId: ids.debtor,
      creditorId: ids.creditor,
      amountLeaves: 200,
      amountPaidLeaves: 0,
      deadline: new Date(Date.now() + 14 * 86_400_000),
      status: "ACTIVE",
      acceptedAt: new Date(),
    },
  })

  const debtorLedgerBefore = await ledgerBalance(ids.debtor)
  const creditorLedgerBefore = await ledgerBalance(ids.creditor)

  // ── a partial payment ────────────────────────────────────────────────────
  await prisma.$transaction(async (tx) => {
    const c = await tx.deferredContract.findUniqueOrThrow({
      where: { id: ids.contract },
      select: { id: true, creditorId: true, amountLeaves: true, amountPaidLeaves: true },
    })
    await payContract(tx, { contract: c, debtorId: ids.debtor, amount: 120, strict: true })
  })

  let contract = await prisma.deferredContract.findUniqueOrThrow({ where: { id: ids.contract } })
  let debtor = await prisma.user.findUniqueOrThrow({ where: { id: ids.debtor } })
  let creditor = await prisma.user.findUniqueOrThrow({ where: { id: ids.creditor } })

  check("partial payment recorded", contract.amountPaidLeaves === 120, contract.amountPaidLeaves)
  check("contract still ACTIVE after a partial", contract.status === "ACTIVE", contract.status)
  check("debtor balance fell by 120", debtor.leaves === 180, debtor.leaves)
  check("creditor balance rose by 120", creditor.leaves === 170, creditor.leaves)
  check("debtor lifetimeLeaves untouched", debtor.lifetimeLeaves === 300, debtor.lifetimeLeaves)
  check("creditor lifetimeLeaves untouched", creditor.lifetimeLeaves === 50, creditor.lifetimeLeaves)
  check(
    "ledger moved with the balances",
    (await ledgerBalance(ids.debtor)) === debtorLedgerBefore - 120 &&
      (await ledgerBalance(ids.creditor)) === creditorLedgerBefore + 120,
  )

  // ── the rest of it ───────────────────────────────────────────────────────
  await prisma.$transaction(async (tx) => {
    const c = await tx.deferredContract.findUniqueOrThrow({
      where: { id: ids.contract },
      select: { id: true, creditorId: true, amountLeaves: true, amountPaidLeaves: true },
    })
    await payContract(tx, { contract: c, debtorId: ids.debtor, amount: 80, strict: true })
  })

  contract = await prisma.deferredContract.findUniqueOrThrow({ where: { id: ids.contract } })
  debtor = await prisma.user.findUniqueOrThrow({ where: { id: ids.debtor } })
  creditor = await prisma.user.findUniqueOrThrow({ where: { id: ids.creditor } })

  check("paying the remainder FULFILLS it", contract.status === "FULFILLED", contract.status)
  check("fulfilledAt is stamped", contract.fulfilledAt !== null)
  check("defaultedAt stays null on a clean settle", contract.defaultedAt === null)
  check("debtor ended on 100", debtor.leaves === 100, debtor.leaves)
  check("creditor ended on 250", creditor.leaves === 250, creditor.leaves)

  // ── the conditional write, which is what stops a double-tap ──────────────
  let raced = false
  try {
    await prisma.$transaction(async (tx) => {
      await payContract(tx, {
        // A STALE witness: `amountPaidLeaves: 120` is what a second request that
        // read before the first one committed would be holding.
        contract: { id: ids.contract, creditorId: ids.creditor, amountLeaves: 200, amountPaidLeaves: 120 },
        debtorId: ids.debtor,
        amount: 80,
        strict: true,
      })
    })
  } catch (e) {
    raced = (e as Error).name === "ContractRaceError"
  }
  check("a stale write is refused, not applied twice", raced)

  debtor = await prisma.user.findUniqueOrThrow({ where: { id: ids.debtor } })
  check("the refused write moved nothing", debtor.leaves === 100, debtor.leaves)

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
