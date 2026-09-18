import { gone } from "@/lib/v1/envelope"

export const dynamic = "force-dynamic"

/**
 * GONE — Deferred Points Agreements ended on 16 Sep 2026.
 *
 * A DPA let the party receiving the better item promise the Leaves difference
 * and pay it off by a deadline. Bracket trading replaced the whole idea: an
 * offer must now be within one bracket either way, and the one-bracket gap is
 * settled immediately by a BRIDGING FEE from whoever moves up (see
 * @/lib/trade-rules). There is no gap left to defer, so there is nothing for
 * these routes to create, accept, extend or settle.
 *
 * ── WHY A 410 AND NOT A DELETED FILE ────────────────────────────────────────
 *
 * Shipped APKs still call them. A deleted route answers 404, which a client
 * reads as "wrong URL" and a person reads as "something is broken" -- both of
 * which invite a retry that can never work. 410 says the endpoint existed and
 * has been withdrawn, and the message says what to do instead. The stubs come
 * out when the last build that calls them is gone.
 *
 * The TABLE is untouched. `DeferredContract` keeps its one FULFILLED row and
 * its CONTRACT_PAY / CONTRACT_COLLECT ledger pair, so the reconciliation and
 * every backup still round-trip. Nothing writes to it any more.
 */
const MESSAGE =
  "Deferred agreements have been replaced by bracket trading. Offers are now within one " +
  "bracket either way, and a one-bracket difference is settled at once with a bridging fee. " +
  "Update the app to make an offer."

const META = { replacedBy: "bridging-fee", since: "2026-09-16" }

export async function POST() {
  return gone(MESSAGE, META)
}
