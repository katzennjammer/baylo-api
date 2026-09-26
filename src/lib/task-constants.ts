// ── Task reward system ───────────────────────────────────────────────────────
// Tasks award Pasa Leaves. Every award writes a LeafTransaction row of type
// TASK_REWARD, so a user's balance is always reconstructable from the ledger.
//
// Two balances, two jobs:
//   User.leaves         — spendable, moves on trades and settlement.
//   User.lifetimeLeaves — monotonic, only ever incremented by a positive award.
//                         Ranks, badges and profile display key off this, so a
//                         user never loses rank by spending what they earned.
//
// SAFEZONE_MEETUP is repeatable (once per trade); the rest are one-time.
// Faucet limits live here too — see WEEKLY_TASK_LEAF_CAP and
// NEW_PARTNER_WINDOW_DAYS.
//
// ── VERIFIED_SWAP IS GONE (16 Sep 2026) ─────────────────────────────────────
// It paid a flat 20 Leaves per completed trade. The per-trade payout is now
// TRADE_REWARD — 2 x the bracket of the item you gave, see @/lib/trade-rules —
// and the two could not coexist: a bracket-1 bridge costs 10 Leaves, so a flat
// 20 on top of the reward would have paid 22 for the trade the fee was meant
// to price. The rows it wrote stay in TaskCompletion (the enum value survives
// in the schema for them); nothing awards it, and the backfill no longer lists
// it as eligible. What it became is FIRST_TRADE: the same 20, ONCE, for the
// first trade this account ever completes — a milestone rather than a faucet.

export type TaskKey =
  | "VERIFY_ACCOUNT"
  | "COMPLETE_PROFILE"
  | "FIRST_LISTING"
  | "FIRST_TRADE"
  | "SAFEZONE_MEETUP"

export const TASK_REWARDS: Record<TaskKey, number> = {
  VERIFY_ACCOUNT:   10,
  COMPLETE_PROFILE: 10,
  FIRST_LISTING:    15,
  FIRST_TRADE:      20,
  SAFEZONE_MEETUP:  10,
}

export const TASK_ORDER: TaskKey[] = [
  "VERIFY_ACCOUNT",
  "COMPLETE_PROFILE",
  "FIRST_LISTING",
  "FIRST_TRADE",
  "SAFEZONE_MEETUP",
]

// ── Faucet limits ────────────────────────────────────────────────────────────

// Maximum Leaves a user can earn from tasks in any rolling 7-day window.
// Enforced server-side by summing that user's positive TASK_REWARD ledger rows
// over the 7 days before the awarding event — the event's own week, not the
// week the award happens to be processed in. An award refused by the cap is
// refused permanently, since a past week can never drop back under it.
// The signup grant is NOT counted against this cap — it is one-time and
// separately gated.
export const WEEKLY_TASK_LEAF_CAP = 100

// THE REPEATABLE TASK — SAFEZONE_MEETUP — awards only when the counterparty is
// someone the user has not completed a trade with inside this window. Repeat
// trades with the same partner still complete normally, they just award
// nothing; otherwise two users could swap the same two items back and forth
// and mint Leaves forever. (VERIFIED_SWAP carried the same guard until it was
// folded into TRADE_REWARD, which has its own, tighter set — see
// @/lib/trade-rules.)
//
// SAFEZONE_MEETUP was outside this rule until 28 Aug 2026, which left exactly
// the faucet the rule exists to prevent: a colluding pair collected 10 Leaves
// each per trade, capped only by WEEKLY_TASK_LEAF_CAP, i.e. 100 Leaves each per
// week indefinitely — Guardian rank (300 lifetime) in three weeks. It had never
// actually been awarded on this database when the gap was found, so no Leaves
// were minted through it and nothing was clawed back. The enforcing set is
// PARTNER_GATED in @/lib/tasks; add every future repeatable task to it.
export const NEW_PARTNER_WINDOW_DAYS = 30

// One-time grant given at account verification — NOT at registration. That
// distinction is the entire safety property: an ungated grant at signup lets an
// attacker mint Leaves by mass-creating accounts, so the grant is gated behind
// proving control of a Google account (and later a phone number).
//
// Separately gated (User.signupGrantClaimed, one per account) and exempt from
// WEEKLY_TASK_LEAF_CAP — the exemption falls out of it being written as a
// SIGNUP_GRANT ledger row rather than a TASK_REWARD one, which is what the cap
// sums. Paid by markVerified(); see @/lib/verification.
//
// 50 → 20 on 11 Sep 2026. Note that a verifying user never sees this number on
// its own: markVerified() pays the grant AND the VERIFY_ACCOUNT task in the
// same call, so the figure that lands in their balance is
// VERIFY_CREDIT_LEAVES below (30 today). Copy that names what verifying is
// worth must quote THAT, not this — see the mailer and the mobile client.
export const SIGNUP_GRANT_LEAVES = 20

// What a user actually sees credited when they verify: the grant plus the
// one-time VERIFY_ACCOUNT reward, which markVerified() pays together. Every
// piece of user-facing copy that promises a number for verifying reads this.
export const VERIFY_CREDIT_LEAVES = SIGNUP_GRANT_LEAVES + TASK_REWARDS.VERIFY_ACCOUNT

// The verified-MSME welcome grant (24 Sep 2026), credited to the ORGANISATION'S
// own balance (its backing User row) when an admin approves its business
// document. Paid by POST /api/admin/organizations/[id].
//
// Pegged to VERIFY_CREDIT_LEAVES on purpose: a verified shop is welcomed with
// exactly what a verified person sees land (30 today), not a bigger number that
// would make registering a business a better faucet than signing up. It is gated
// the same way, behind a check a human did, and never at registration: an org's
// backing row is created with signupGrantClaimed = true so the person-side grant
// can never reach it.
//
// Written as ONE SIGNUP_GRANT ledger row, so it is cap-exempt and already
// counted as issuance by scripts/lib/ledger-invariant.ts.
export const ORG_WELCOME_LEAVES = VERIFY_CREDIT_LEAVES

// ── Recognition ranks ────────────────────────────────────────────────────────
// Ranked on lifetimeLeaves, never on the spendable balance — otherwise a user
// would drop a rank every time they traded. Display-only, ascending thresholds.
export const LEAF_RANKS = [
  { min: 0,   label: "Seedling" },
  { min: 50,  label: "Sprout" },
  { min: 150, label: "Grower" },
  { min: 300, label: "Guardian" },
] as const

export function getLeafRank(lifetimeLeaves: number): {
  label: string
  next: { label: string; toNext: number } | null
} {
  let idx = 0
  for (let i = 0; i < LEAF_RANKS.length; i++) {
    if (lifetimeLeaves >= LEAF_RANKS[i].min) idx = i
  }
  const next = LEAF_RANKS[idx + 1]
  return {
    label: LEAF_RANKS[idx].label,
    next: next ? { label: next.label, toNext: next.min - lifetimeLeaves } : null,
  }
}

export interface TaskState {
  task:          TaskKey
  done:          boolean
  count:         number   // completions (can exceed 1 for repeatable tasks)
  leavesEarned:  number
}

export interface TasksStatus {
  lifetimeLeaves: number
  leaves:         number
  googleVerified: boolean
  tasks:          TaskState[]
}
