// A starting Leaf balance for the FEW demo accounts used in a live trade
// demonstration (the thesis panel), so they can pay a bridging fee.
//
//   npx tsx --tsconfig tsconfig.json --env-file=.env scripts/grant-demo-leaves.ts          # scratch
//   npx tsx --tsconfig tsconfig.json --env-file=.env scripts/grant-demo-leaves.ts --live   # after a backup
//
// ── SCOPE, ON PURPOSE ───────────────────────────────────────────────────────
//
// seed-demo-population.ts gives all sixty demo accounts 0 Leaves and marks the
// signup grant claimed, so no faucet ever pays them. This script is the one
// exception, and it is narrow by construction: the recipients are the named
// constant below, not a pattern; each must be a `demo-pop-` id at
// @baylo-demo.test; there are at most MAX_ACCOUNTS of them; and a recipient
// who already holds this grant is skipped, so re-running pays nobody twice.
//
// ── HOW IT IS RECORDED ──────────────────────────────────────────────────────
//
// Exactly the claimSignupGrant() pattern in @/lib/verification: the balance
// and ONE `SIGNUP_GRANT` ledger row move in the same transaction. It must be
// an ISSUANCE type -- scripts/lib/ledger-invariant.ts checks balances + escrow
// == issuance, and a grant under any other type reads as Leaves minted from
// nowhere. The org welcome grant reuses SIGNUP_GRANT for the same reason. The
// description is what tells this grant apart from a real signup grant.
//
// ONE DELIBERATE DIFFERENCE: lifetimeLeaves is NOT incremented. It drives the
// leaf-rank ladder and the faucet caps, and these Leaves were not earned.
// The invariant never reads it.
//
// ── WHY 100 ─────────────────────────────────────────────────────────────────
//
// A bridge costs 10 x the lower bracket, HELD from the payer when the offer is
// sent and returned only on decline/withdraw. 100 covers a B2<->3 (20), a
// B3<->4 (30) and a B4<->5 (40) outstanding at once -- a rehearsal plus the
// live run -- on the shelves these four accounts hold.
//
// ── CLEANUP ─────────────────────────────────────────────────────────────────
//
// Once a granted account has traded, its ledger rows are one side of a fee
// that another account holds the other side of. `seed-demo-population.ts
// --remove` already refuses to delete an account with ledger rows; removing
// one after a demo trade is a deliberate, separate step.

import prisma from "../src/lib/prisma"
import { requireScratchSchema } from "./lib/live-guard"
import { ledgerInvariant } from "./lib/ledger-invariant"

const GRANT_LEAVES = 100
const MAX_ACCOUNTS = 6
const DESCRIPTION = "Demo starting balance (thesis panel demo)"

/** The accounts picked for the live demo, 24 Sep 2026. Individuals only. */
const DEMO_TRADERS = [
  "demo-user-03@baylo-demo.test", // Angelica Reyes
  "demo-user-09@baylo-demo.test", // Jasmine Bautista
  "demo-user-13@baylo-demo.test", // Clarisse Cabrera
  "demo-user-16@baylo-demo.test", // Christian Salazar
]

async function main() {
  requireScratchSchema("scripts/grant-demo-leaves.ts")
  if (DEMO_TRADERS.length > MAX_ACCOUNTS) throw new Error(`refusing: ${DEMO_TRADERS.length} accounts, cap is ${MAX_ACCOUNTS}`)

  const before = await ledgerInvariant(prisma)
  console.log("\n  ledger BEFORE")
  for (const l of before.lines) console.log(`    ${l}`)
  if (!before.ok) throw new Error("refusing: the ledger is already out of balance; granting on top of that would hide it")

  const users = await prisma.user.findMany({
    where: { email: { in: DEMO_TRADERS } },
    select: { id: true, email: true, name: true, isOrgAccount: true, deletedAt: true },
  })
  for (const email of DEMO_TRADERS) {
    const u = users.find((x) => x.email === email)
    if (!u) throw new Error(`refusing: ${email} is not in this database -- run seed-demo-population.ts first`)
    if (!u.id.startsWith("demo-pop-") || !u.email.endsWith("@baylo-demo.test") || u.isOrgAccount || u.deletedAt) {
      throw new Error(`refusing: ${email} (${u.id}) is not a live individual demo account`)
    }
  }

  console.log("")
  for (const email of DEMO_TRADERS) {
    const u = users.find((x) => x.email === email)!
    const paid = await prisma.$transaction(async (tx) => {
      const already = await tx.leafTransaction.count({ where: { userId: u.id, type: "SIGNUP_GRANT", description: DESCRIPTION } })
      if (already > 0) return false
      // Balance and ledger row in one transaction, as in claimSignupGrant().
      // leaves only -- lifetimeLeaves is left alone, see the header.
      await tx.user.update({ where: { id: u.id }, data: { leaves: { increment: GRANT_LEAVES } } })
      await tx.leafTransaction.create({
        data: { userId: u.id, type: "SIGNUP_GRANT", amount: GRANT_LEAVES, description: DESCRIPTION, eventAt: new Date() },
      })
      return true
    })
    const now = await prisma.user.findUniqueOrThrow({ where: { id: u.id }, select: { leaves: true, lifetimeLeaves: true } })
    console.log(`  ${paid ? "granted" : "skipped (already granted)"}  ${email.padEnd(30)} ${u.name.padEnd(18)} leaves=${now.leaves} lifetime=${now.lifetimeLeaves}`)
  }

  const after = await ledgerInvariant(prisma)
  console.log("\n  ledger AFTER")
  for (const l of after.lines) console.log(`    ${l}`)
  console.log(`  issuance moved by ${after.issuance - before.issuance}, balances by ${after.userLeaves - before.userLeaves}\n`)
  if (!after.ok) {
    console.error("  LEDGER INVARIANT BROKEN AFTER THE GRANT")
    process.exitCode = 1
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
