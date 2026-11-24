import prisma from "@/lib/prisma"
import { revokeUserFamilies } from "@/lib/auth-tokens"
import { SIGNUP_GRANT_LEAVES } from "@/lib/task-constants"
import { awardTask } from "@/lib/tasks"
import type { PrismaClient } from "@/generated/prisma/client"

type TaskDb = Pick<PrismaClient, "user" | "leafTransaction" | "trade">

/**
 * The one place an account becomes verified.
 *
 * `User.isVerified` is the whole definition of "verified". It replaced the old
 * `password === null` test, which really meant "signed up with Google and never
 * set a password" — an authentication detail standing in for a trust decision,
 * with no room for any second verification route.
 *
 * Every way of verifying funnels through here: the web Google callback, the
 * native Google token exchange, and the emailed verification link. A new route
 * only has to call markVerified() — the award and the grant come with it, and
 * no logic downstream of this function needs to change.
 *
 * IT IS NOT THE GOVERNMENT-ID CHECK, and nothing here should ever be made to
 * do double duty as one. That gate lives in @/lib/id-verification, is derived
 * from IdVerification rows rather than from a flag, awards no Leaves, and
 * governs two acts this flag governs neither of. A phone-OTP route was once
 * planned as a third caller of this function; it was replaced by the ID check,
 * which is deliberately NOT plumbed through here.
 *
 * Three things happen when the flag flips, and they are deliberately separate
 * from each other:
 *
 *   1. isVerified false -> true.
 *   2. VERIFY_ACCOUNT, through the normal awardTask path — ledger row, both
 *      balances, subject to the weekly cap like any other task.
 *   3. The one-time signup grant, which is NOT a task: separately gated on
 *      signupGrantClaimed and exempt from the weekly cap.
 *
 * Idempotent by construction. Every step is individually guarded, so calling
 * this on an already-verified account is a no-op that credits nothing — 2 by
 * the task unique constraint on LeafTransaction, 3 by the signupGrantClaimed flag.
 */

export interface VerificationResult {
  /** True only on the call that actually flipped the flag. */
  flipped: boolean
  /** Leaves paid by the signup grant on this call (0 if already claimed). */
  grantAwarded: number
  /** Leaves paid by VERIFY_ACCOUNT on this call (0 if already awarded/capped). */
  taskAwarded: number
}

export async function markVerified(
  userId: string,
  /** The verification moment. Becomes `eventAt` on both ledger rows. */
  at: Date = new Date(),
): Promise<VerificationResult> {
  // 1. Flip. Conditional on the current value so `flipped` reports whether THIS
  //    call did it, rather than whether the row now says true.
  const flip = await prisma.user.updateMany({
    where: { id: userId, isVerified: false },
    data: { isVerified: true },
  })
  const flipped = flip.count === 1

  // 2. VERIFY_ACCOUNT via the normal award path. Its own transaction: an award
  //    that hits the weekly cap must not roll back the verification itself.
  //    eventAt is this moment — the account became verified now, which is a
  //    real event, unlike the account-creation stand-in reconcileTasks() has to
  //    use when backfilling an account that verified before this code existed.
  let taskAwarded = 0
  try {
    const res = await prisma.$transaction(async (tx) => {
      const awarded = await awardTask(tx as TaskDb, userId, "VERIFY_ACCOUNT", "", {
        description: "Task reward: verified your account",
        eventAt: at,
      })
      // Earned Leaves go to an open deferred agreement first — rule 4. In the
      // same transaction as the award, so the balance and the debt never
      // disagree between two commits.
      return awarded
    })
    taskAwarded = res.awarded
  } catch {
    // Best-effort, exactly like every other award site: reconcileTasks() is
    // still there to catch a miss. Verification itself must not fail over it.
  }

  // 3. The signup grant. Best-effort like step 2 (18 Nov 2026): if it fails
  //    -- a busy database timing the transaction out -- the account is still
  //    verified, and settleVerificationRewards() pays it on the next app open
  //    instead of the verify link erroring after the flag already flipped.
  let grantAwarded = 0
  try {
    grantAwarded = await claimSignupGrant(userId, at)
  } catch {
    // Left for settleVerificationRewards().
  }

  return { flipped, grantAwarded, taskAwarded }
}

/**
 * Credits SIGNUP_GRANT_LEAVES exactly once per account.
 *
 * The concurrency guard is the WHERE clause, not a read-then-write. Two
 * simultaneous verifications both issue the same conditional UPDATE; InnoDB
 * serialises them on the row, and the second one re-reads the committed value
 * and matches nothing. Only the update that reports count === 1 writes a ledger
 * row, so a double credit is not merely unlikely — it cannot be expressed.
 *
 * Reading the flag first and then updating would be the bug this avoids: both
 * requests would read false, and both would pay.
 */
async function claimSignupGrant(userId: string, at: Date): Promise<number> {
  if (SIGNUP_GRANT_LEAVES <= 0) return 0

  return prisma.$transaction(async (tx) => {
    // The flag and both balances move in ONE statement, so the claim and the
    // credit cannot come apart.
    const claimed = await tx.user.updateMany({
      where: { id: userId, isVerified: true, signupGrantClaimed: false },
      data: {
        signupGrantClaimed: true,
        leaves: { increment: SIGNUP_GRANT_LEAVES },
        lifetimeLeaves: { increment: SIGNUP_GRANT_LEAVES },
      },
    })
    if (claimed.count !== 1) return 0

    // Same transaction: the balance and the ledger row that explains it are
    // never observable apart, which is what keeps SUM(User.leaves) equal to the
    // sum of positive ledger rows.
    await tx.leafTransaction.create({
      data: {
        userId,
        type: "SIGNUP_GRANT",
        amount: SIGNUP_GRANT_LEAVES,
        description: "Signup grant",
        eventAt: at,
      },
    })

    // The grant is Leaves earned, so it settles debt like any other earning.
    // In practice a brand-new account has no contracts to settle -- a debtor
    // needs three completed trades -- but the rule is "every credit sweeps",
    // and an exception here would be one more place for that to stop being true.

    return SIGNUP_GRANT_LEAVES
  })
}

/**
 * Google proved this person owns the address; the account it matched may not
 * have. An unverified account with a password is one somebody registered by
 * typing an email, never proving it -- possibly an attacker squatting on the
 * victim's address before the victim ever arrived. Linking the Google sign-in
 * to it as-is would leave the squatter's password working on the victim's
 * account. So, before markVerified(): drop that password and end every session
 * it opened. The real owner can set a new one from the profile screen.
 *
 * Called by both Google paths (web signIn callback, native /api/auth/google/token).
 * A no-op on a verified account, which is every returning user.
 */
export async function claimUnverifiedForGoogle(userId: string): Promise<void> {
  const cleared = await prisma.user.updateMany({
    where: { id: userId, isVerified: false, password: { not: null } },
    data: { password: null },
  })
  if (cleared.count > 0) await revokeUserFamilies(userId)
}

/**
 * Pays a VERIFIED account's welcome points if verification left them unpaid
 * (18 Nov 2026).
 *
 * markVerified() flips the flag first and pays afterwards, in separate
 * statements, so a failure between them (a busy database timing out a
 * transaction) left an account showing "Verified" with no points. The email
 * link is single use, so nothing ever retried. GET /api/v1/home calls this
 * for a verified account whose `signupGrantClaimed` is still false, so the
 * points arrive the next time the app opens.
 *
 * Safe to call any number of times: the grant is claimed by a conditional
 * update and VERIFY_ACCOUNT by the task's unique ledger row, so each pays
 * once per account. Never throws. Returns the points paid on this call.
 */
export async function settleVerificationRewards(userId: string, at: Date = new Date()): Promise<number> {
  let paid = 0
  try {
    const res = await prisma.$transaction(async (tx) =>
      awardTask(tx as TaskDb, userId, "VERIFY_ACCOUNT", "", {
        description: "Task reward: verified your account",
        eventAt: at,
      }),
    )
    paid += res.awarded
  } catch {
    // Tried again on the next open.
  }
  try {
    paid += await claimSignupGrant(userId, at)
  } catch {
    // Tried again on the next open.
  }
  return paid
}
