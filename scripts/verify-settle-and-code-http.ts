/**
 * The two NEW ROUTES, driven over HTTP with a real Bearer token.
 *
 *   GET  /api/trades/[id]/confirm/status   returns the caller's own code
 *   POST /api/v1/contracts/[id]/settle     moves Leaves, and refuses correctly
 *
 * `verify-swap-code-and-settle.ts` covers the libraries these sit on — the seal,
 * `payContract()`, the ledger invariant. This covers the parts only a request
 * can reach: session resolution, the body schema, the status codes, the `meta`
 * a client branches on, and the response shapes.
 *
 * BOTH SIDES OF THE CODE ASYMMETRY ARE TESTED WITH TWO REAL SESSIONS. One token
 * per participant, each asking the same endpoint about the same trade, each
 * getting their own digits and neither getting the other's. That property is the
 * whole security argument for returning the code at all, so it is checked from
 * the outside rather than trusted from the inside.
 *
 * Run (from baylo/, with a dev server on BASE):
 *
 *     npx next dev -p 3100
 *     npx tsx scripts/verify-settle-and-code-http.ts
 */

import "dotenv/config"

import prisma from "../src/lib/prisma"
import { signAccessToken } from "../src/lib/auth-tokens"
import { sealCode, sealingAvailable } from "../src/lib/swap-code-seal"

const BASE = process.env.ACCEPT_BASE ?? "http://127.0.0.1:3100"

const RUN = `vhttp${Date.now().toString(36)}`
const ids = {
  debtor: `${RUN}-debtor`,
  creditor: `${RUN}-creditor`,
  stranger: `${RUN}-stranger`,
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

async function call(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

async function main() {
  console.log(`Driving ${BASE}\n`)

  // ── fixtures ─────────────────────────────────────────────────────────────
  await prisma.user.create({
    data: {
      id: ids.debtor,
      email: `${RUN}-debtor@example.test`,
      name: "Dana Debtor",
      leaves: 250,
      lifetimeLeaves: 250,
      isVerified: true,
    },
  })
  await prisma.user.create({
    data: {
      id: ids.creditor,
      email: `${RUN}-creditor@example.test`,
      name: "Marco Creditor",
      leaves: 40,
      lifetimeLeaves: 40,
      isVerified: true,
    },
  })
  // A REAL user who is simply not in this trade. An id that does not exist at
  // all answers 401 (no session resolves), which would pass a naive "is it
  // refused" check for entirely the wrong reason — the token would be bad, not
  // the person.
  await prisma.user.create({
    data: {
      id: ids.stranger,
      email: `${RUN}-stranger@example.test`,
      name: "Nobody Relevant",
      leaves: 0,
      lifetimeLeaves: 0,
      isVerified: true,
    },
  })
  await prisma.item.create({
    data: {
      id: ids.itemA,
      userId: ids.debtor,
      title: "Vans",
      description: "t",
      category: "CLOTHING",
      condition: "GOOD",
      images: JSON.stringify(["https://example.test/a.jpg"]),
      valueLeaves: 440,
      status: "IN_TRADE",
    },
  })
  await prisma.item.create({
    data: {
      id: ids.itemB,
      userId: ids.creditor,
      title: "Air Max",
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
      offeredLeaves: 40,
      status: "CONFIRMING",
    },
  })
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

  // `signAccessToken` is ASYNC. Without these awaits the Authorization header
  // carries "[object Promise]" and every single request answers 401 — which
  // is a convincing-looking failure of the routes rather than of the harness.
  const debtorToken = await signAccessToken(ids.debtor)
  const creditorToken = await signAccessToken(ids.creditor)

  // ── 1. the trades payload carries values ────────────────────────────────
  console.log("── /api/v1/trades carries valueLeaves ────────────────────────")
  const trades = await call("/api/v1/trades?tab=active&limit=50", debtorToken)
  check("200", trades.status === 200, trades.status)

  const row = trades.body?.data?.trades?.find((t: any) => t.id === ids.trade)
  check("the trade came back", !!row)
  // A REAL item offered alongside 40 Leaves. This is `kind: "leaves"` by the
  // route's derivation, and the offered item still has to come through — the
  // regression this guards is the one that suppressed it.
  check("offered item survives a mixed trade", row?.offeredItem?.valueLeaves === 440, row?.offeredItem)
  check("and the trade still reads as a leaves trade", row?.kind === "leaves", row?.kind)
  check("requested item value", row?.requestedItem?.valueLeaves === 480, row?.requestedItem)

  // ── 2. confirm/status, both sides ───────────────────────────────────────
  console.log("\n── confirm/status returns YOUR OWN code ──────────────────────")

  const debtorCode = "314159"
  const creditorCode = "271828"
  await prisma.swapConfirmationCode.createMany({
    data: [
      {
        tradeId: ids.trade,
        userId: ids.debtor,
        codeHash: "not-verified-here",
        codeSealed: sealCode(debtorCode, ids.trade, ids.debtor),
        expiresAt: new Date(Date.now() + 15 * 60_000),
      },
      {
        tradeId: ids.trade,
        userId: ids.creditor,
        codeHash: "not-verified-here",
        codeSealed: sealCode(creditorCode, ids.trade, ids.creditor),
        expiresAt: new Date(Date.now() + 15 * 60_000),
      },
    ],
  })

  const asDebtor = await call(`/api/trades/${ids.trade}/confirm/status`, debtorToken)
  const asCreditor = await call(`/api/trades/${ids.trade}/confirm/status`, creditorToken)

  check("debtor gets 200", asDebtor.status === 200, asDebtor.status)
  check("creditor gets 200", asCreditor.status === 200, asCreditor.status)
  check("both codes exist", asDebtor.body?.started === true, asDebtor.body)

  if (sealingAvailable()) {
    check("debtor sees their OWN code", asDebtor.body?.code === debtorCode, asDebtor.body?.code)
    check(
      "creditor sees their OWN code",
      asCreditor.body?.code === creditorCode,
      asCreditor.body?.code,
    )

    // THE PROPERTY THE WHOLE DESIGN RESTS ON.
    //
    // Asserted against a code that is KNOWN TO BE PRESENT, not merely different.
    // `undefined !== creditorCode` is true on a 401, so the naive form of this
    // check passes hardest exactly when the endpoint is most broken.
    check(
      "debtor does NOT see the creditor's",
      typeof asDebtor.body?.code === "string" && asDebtor.body.code !== creditorCode,
      asDebtor.body?.code,
    )
    check(
      "creditor does NOT see the debtor's",
      typeof asCreditor.body?.code === "string" && asCreditor.body.code !== debtorCode,
      asCreditor.body?.code,
    )
    check("codeAvailable is true when it is", asDebtor.body?.codeAvailable === true)
  } else {
    check("no key configured — code is null", asDebtor.body?.code === null, asDebtor.body)
    check("and codeAvailable says so", asDebtor.body?.codeAvailable === false)
  }

  // A stranger must not reach it at all.
  const strangerToken = await signAccessToken(ids.stranger)
  const asStranger = await call(`/api/trades/${ids.trade}/confirm/status`, strangerToken)
  // 403 specifically. A 401 here would mean the token was rejected rather than
  // the person, which is the harness failing and not the route succeeding.
  check("a non-participant is refused", asStranger.status === 403, asStranger.status)

  // An expired code stops being readable.
  await prisma.swapConfirmationCode.update({
    where: { tradeId_userId: { tradeId: ids.trade, userId: ids.debtor } },
    data: { expiresAt: new Date(Date.now() - 1000) },
  })
  const expired = await call(`/api/trades/${ids.trade}/confirm/status`, debtorToken)
  check("an expired code is not returned", expired.body?.code === null, expired.body?.code)
  check("codeAvailable is false for it", expired.body?.codeAvailable === false)

  // ── 3. the settle route ─────────────────────────────────────────────────
  console.log("\n── POST /api/v1/contracts/[id]/settle ────────────────────────")

  // A creditor must not be able to pay their own debtor's debt.
  const wrongSide = await call(`/api/v1/contracts/${ids.contract}/settle`, creditorToken, {
    method: "POST",
    body: JSON.stringify({ amountLeaves: 10 }),
  })
  check("a creditor gets 404, not 403", wrongSide.status === 404, wrongSide.status)

  // More than is owed.
  const tooMuch = await call(`/api/v1/contracts/${ids.contract}/settle`, debtorToken, {
    method: "POST",
    body: JSON.stringify({ amountLeaves: 500 }),
  })
  check("over the debt is 400", tooMuch.status === 400, tooMuch.status)
  check("and names the outstanding figure", tooMuch.body?.meta?.outstanding === 200, tooMuch.body?.meta)

  // A partial payment.
  const partial = await call(`/api/v1/contracts/${ids.contract}/settle`, debtorToken, {
    method: "POST",
    body: JSON.stringify({ amountLeaves: 120 }),
  })
  check("a partial payment is 200", partial.status === 200, partial.body)
  check("it reports the amount", partial.body?.data?.payment?.amountLeaves === 120, partial.body?.data?.payment)
  check("it is not fulfilled yet", partial.body?.data?.payment?.fulfilled === false)
  check("it reports what is left", partial.body?.data?.payment?.remainingLeaves === 80)
  check("it reports the new balance", partial.body?.data?.viewer?.leaves === 130, partial.body?.data?.viewer)
  check("the contract comes back ACTIVE", partial.body?.data?.contract?.status === "ACTIVE")
  check("with the paid figure on it", partial.body?.data?.contract?.amountPaidLeaves === 120)

  // More than the balance covers. 130 held, 80 owed — so ask for the 80 after
  // dropping the balance below it.
  await prisma.user.update({ where: { id: ids.debtor }, data: { leaves: 50 } })
  const broke = await call(`/api/v1/contracts/${ids.contract}/settle`, debtorToken, {
    method: "POST",
    body: JSON.stringify({ amountLeaves: 80 }),
  })
  check("over the balance is 400", broke.status === 400, broke.status)
  check("with a branchable rule", broke.body?.meta?.rule === "INSUFFICIENT_LEAVES", broke.body?.meta)
  check("and both figures", broke.body?.meta?.balance === 50 && broke.body?.meta?.requested === 80, broke.body?.meta)

  const stillFifty = await prisma.user.findUniqueOrThrow({ where: { id: ids.debtor } })
  // Meaningful only because the partial payment above already moved this
  // balance once; 50 is what the refusal has to have LEFT alone, not a value
  // it started at.
  check("the refusal moved nothing", stillFifty.leaves === 50, stillFifty.leaves)

  // No amount at all = pay the remainder. Fund it first.
  await prisma.user.update({ where: { id: ids.debtor }, data: { leaves: 500 } })
  const rest = await call(`/api/v1/contracts/${ids.contract}/settle`, debtorToken, {
    method: "POST",
    body: JSON.stringify({}),
  })
  check("no amount pays the remainder", rest.status === 200 && rest.body?.data?.payment?.amountLeaves === 80, rest.body?.data?.payment)
  check("and FULFILLS it", rest.body?.data?.payment?.fulfilled === true)
  check("contract reads FULFILLED", rest.body?.data?.contract?.status === "FULFILLED")
  check("nothing left owing", rest.body?.data?.payment?.remainingLeaves === 0)

  // Paying a settled agreement.
  const again = await call(`/api/v1/contracts/${ids.contract}/settle`, debtorToken, {
    method: "POST",
    body: JSON.stringify({ amountLeaves: 10 }),
  })
  check("settling a settled one is 409", again.status === 409, again.status)
  check("with a branchable rule", again.body?.meta?.rule === "CONTRACT_NOT_OWING", again.body?.meta)

  // The creditor actually received it all.
  const creditor = await prisma.user.findUniqueOrThrow({ where: { id: ids.creditor } })
  check("the creditor received 200 in total", creditor.leaves === 240, creditor.leaves)
  check("the creditor's lifetimeLeaves is untouched", creditor.lifetimeLeaves === 40, creditor.lifetimeLeaves)
}

async function cleanup() {
  await prisma.leafTransaction.deleteMany({
    where: { userId: { in: [ids.debtor, ids.creditor, ids.stranger] } },
  })
  await prisma.swapConfirmationCode.deleteMany({ where: { tradeId: ids.trade } })
  await prisma.deferredContract.deleteMany({ where: { id: ids.contract } })
  await prisma.tradeRequest.deleteMany({ where: { id: ids.trade } })
  await prisma.item.deleteMany({ where: { id: { in: [ids.itemA, ids.itemB] } } })
  await prisma.user.deleteMany({ where: { id: { in: [ids.debtor, ids.creditor, ids.stranger] } } })
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
