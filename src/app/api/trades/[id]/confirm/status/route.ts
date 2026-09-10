import { NextRequest, NextResponse } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { MAX_CODE_ATTEMPTS } from "@/lib/swap-code"
import { openCode } from "@/lib/swap-code-seal"

/**
 * GET /api/trades/[id]/confirm/status — whose turn it is, and YOUR OWN code.
 *
 * ══ THE TWO BOOLEANS DO NOT MEAN WHAT THEY ARE CALLED ═══════════════════════
 *
 * A code row is marked `used` by the person who TYPED IT IN, not by the person
 * it belongs to — `confirm/submit` marks the PARTNER's row when a submission
 * verifies. So `senderSubmitted` is `senderCode.used`, which means the SENDER'S
 * CODE HAS BEEN CONSUMED, i.e. the RECEIVER has done their part.
 *
 * The names are wrong and are kept, because a shipped client reads them. The
 * mobile client untangles it once, in `confirmSides()`, and every screen reads
 * that instead. Renaming here would be a silent inversion on any client that did
 * not update in the same breath, which on this endpoint means showing somebody
 * "waiting for them" when it is their turn.
 *
 * ══ `code` — THE CALLER'S OWN, AND NEVER THE PARTNER'S ══════════════════════
 *
 * WHY IT IS HERE AT ALL. Two people stand next to each other at a mall. One
 * reads their code out, the other types it in. Before this field the reader had
 * to leave the app and find an email to do that, which made the most complete
 * feature in the product unusable from the client it was designed for.
 *
 * WHAT IS RETURNED. The row keyed `(tradeId, viewerId)` and nothing else. The
 * partner's row is fetched — the two booleans need it — and its `codeSealed` is
 * never opened. That asymmetry is the whole security property of this endpoint
 * and it is worth stating plainly:
 *
 *     YOUR OWN CODE IS THE ONE YOUR PARTNER TYPES IN.
 *     IT IS NOT THE ONE YOUR ACCOUNT SUBMITS.
 *
 * So a stolen access token yields a secret that cannot be spent by the thief:
 * completing a trade consumes BOTH codes, and the other one is only obtainable
 * from the other person. The full threat model, including what an attacker does
 * gain, is written out in @/lib/swap-code-seal — this route is the place those
 * mitigations are actually applied, and there are three:
 *
 *   1. OWN ROW ONLY, above.
 *   2. LIVE AND UNBURNED ONLY. An expired code and a code burned by
 *      MAX_CODE_ATTEMPTS are both un-typeable; there is nothing to do with
 *      either, so neither is handed out. This also means the field going null
 *      is a real signal to the client that the pair needs reissuing.
 *   3. FAIL CLOSED. No key, a rotated key, a tampered row: all `null`, never a
 *      guess and never an error. `codeAvailable` says whether the null is
 *      "this deployment does not do this" or "this particular code is not
 *      readable", so the client can tell a configuration from a state.
 *
 * NO RATE LIMIT ON THIS ROUTE, deliberately. The client polls it every two
 * seconds while the screen is open — the other person is typing in front of you
 * and a stale "waiting for them" is the one wrong answer that makes two people
 * stare at two phones. A budget that survives that poll would not constrain an
 * attacker who already holds the token, and one that constrains the attacker
 * would break the meeting. The secret returned is the caller's own and already
 * in their inbox; the thing worth rate-limiting is `confirm/submit`, which is
 * where guesses are spent, and that is limited already.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await resolveSession()
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const { id: tradeId } = await params
    const myId = session.user.id

    const trade = await prisma.tradeRequest.findUnique({
      where:  { id: tradeId },
      select: { senderId: true, receiverId: true, status: true },
    })

    if (!trade) return NextResponse.json({ error: "Trade not found" }, { status: 404 })
    if (trade.senderId !== myId && trade.receiverId !== myId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    if (trade.status === "COMPLETED") {
      // Both codes are spent. There is nothing left to read out, so `code` is
      // null here for the same reason it is null for a burned one: not secrecy,
      // just that it has no use.
      return NextResponse.json({
        started: true,
        senderSubmitted: true,
        receiverSubmitted: true,
        completed: true,
        code: null,
        codeAvailable: false,
      })
    }

    const codes = await prisma.swapConfirmationCode.findMany({
      where:  { tradeId },
      // `codeSealed` is selected for BOTH rows because the query is keyed on the
      // trade, and it is OPENED for exactly one — see `mine` below. Selecting
      // only the viewer's would need a second query for the booleans.
      select: { userId: true, used: true, expiresAt: true, attempts: true, codeSealed: true },
    })

    const senderCode   = codes.find((c) => c.userId === trade.senderId)
    const receiverCode = codes.find((c) => c.userId === trade.receiverId)

    // THE VIEWER'S OWN ROW. The partner's is in `codes` and is never passed to
    // openCode() — the AAD would refuse it anyway, since the seal is bound to
    // (tradeId, userId), but the refusal is not what is relied on here. The
    // lookup is by the viewer's own id and that is the guarantee.
    const mine = codes.find((c) => c.userId === myId)

    const live = !!mine && mine.expiresAt.getTime() > Date.now()
    const unburned = !!mine && mine.attempts < MAX_CODE_ATTEMPTS
    const readable = live && unburned && !!mine?.codeSealed

    return NextResponse.json({
      started:           codes.length === 2,
      senderSubmitted:   senderCode?.used   ?? false,
      receiverSubmitted: receiverCode?.used ?? false,
      completed:         (trade.status as string) === "COMPLETED",

      /**
       * The caller's own code, in plain digits, or null.
       *
       * Null is not an error and the client must render it: a deployment with no
       * SWAP_CODE_KEY, a row written before the seal existed, a rotated key, or
       * a code that has expired or been burned all land here. The email that
       * `confirm/start` sends is the fallback in every one of those cases.
       */
      code: readable ? openCode(mine!.codeSealed, tradeId, myId) : null,

      /**
       * Whether a readable copy was expected to exist at all.
       *
       * Lets the client distinguish "this build of the server does not hand
       * codes back" from "your code has expired" — two very different sentences
       * to put in front of somebody standing at a hub.
       */
      codeAvailable: readable,

      /** Guesses the PARTNER has left against this viewer's code. */
      attemptsRemaining: mine ? Math.max(0, MAX_CODE_ATTEMPTS - mine.attempts) : null,

      /** When this viewer's code stops being typeable. ISO, or null. */
      expiresAt: mine?.expiresAt.toISOString() ?? null,
    })
  } catch (err) {
    console.error("[confirm/status]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
