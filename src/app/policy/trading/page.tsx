import {
  BRIDGE_FEE_PER_BRACKET,
  MAX_BRACKET_GAP,
  TRADE_REWARD_PER_BRACKET,
  TRADE_REWARD_DAILY_CAP_LEAVES,
  TRADE_REWARD_REPEAT_PAIR_DAYS,
  TRADE_REWARD_SAME_ITEM_DAYS,
  TRADING_POLICY_VERSION,
  VALUE_RAISE_BRACKETS,
} from "@/lib/trade-rules"
import { BRACKET_CEILINGS, PREMIUM_MIN_BRACKET } from "@/lib/brackets"
import { OFFER_EXPIRY_DAYS } from "@/lib/offers"

/**
 * /policy/trading — the trading policy the consent checkbox agrees to.
 *
 * ── PUBLIC, SHELL-LESS, AND OUTSIDE proxy.ts's RETIRED LIST ─────────────────
 *
 * The phone's consent sheet links here. /trust is retired for users (proxy.ts
 * bounces a signed-in USER to /android), so the one page a user is asked to
 * read before agreeing to a fee must live somewhere that guard does not
 * cover. /policy is not in RETIRED_FOR_USERS and this page renders with no
 * shell, like /android: a document, not an app.
 *
 * ── EVERY NUMBER IS IMPORTED ────────────────────────────────────────────────
 *
 * The fee per bracket, the gap, the reward, the anti-farming windows and the
 * bracket table all come from the modules that enforce them. A policy page
 * that restated a number by hand would be the first place a rule drifted
 * from what the code does, on the page a person is told to rely on.
 *
 * ── THE VERSION IS THE ONE THE SERVER RECORDS ───────────────────────────────
 *
 * `TRADING_POLICY_VERSION` is printed at the top and is the string stamped
 * onto an offer when someone consents. Changing the wording here means
 * bumping that constant, which is what makes a stale client's consent refused
 * with "reopen the offer" rather than silently recorded against text they
 * never saw.
 */
export const metadata = { title: "Baylo trading policy" }

export default function TradingPolicyPage() {
  const rows = BRACKET_CEILINGS.map((ceiling, i) => {
    const min = i === 0 ? 1 : BRACKET_CEILINGS[i - 1] + 1
    return { bracket: i + 1, range: `${min.toLocaleString()} – ${ceiling.toLocaleString()}` }
  })
  rows.push({
    bracket: BRACKET_CEILINGS.length + 1,
    range: `${(BRACKET_CEILINGS[BRACKET_CEILINGS.length - 1] + 1).toLocaleString()} and above`,
  })

  return (
    <main
      style={{
        maxWidth: 680,
        margin: "0 auto",
        padding: "40px 24px 80px",
        fontSize: 16,
        lineHeight: 1.6,
      }}
    >
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>Trading policy</h1>
      <p style={{ color: "#666", fontSize: 13, marginTop: 0 }}>Version {TRADING_POLICY_VERSION}</p>

      <h2 id="brackets" style={{ fontSize: 20, marginTop: 32 }}>Value brackets</h2>
      <p>
        Every listing has a value in Leaves, and every value falls in one of these brackets. Other
        people see your listing&apos;s bracket, not its exact value. Trading is judged on brackets.
      </p>
      <table style={{ borderCollapse: "collapse", marginTop: 8 }}>
        <tbody>
          {rows.map((r) => (
            <tr key={r.bracket}>
              <td style={{ padding: "4px 16px 4px 0", fontWeight: 600 }}>Bracket {r.bracket}</td>
              <td style={{ padding: "4px 0" }}>{r.range} Leaves</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: 14, color: "#666" }}>
        Brackets {PREMIUM_MIN_BRACKET} and above need a premium subscription to trade for.
      </p>

      <h2 id="trading" style={{ fontSize: 20, marginTop: 32 }}>Offers and the bridging fee</h2>
      <p>
        An offer is one item for one item. The item you offer may be in the <strong>same
        bracket</strong> as the listing, <strong>one bracket below</strong> it, or{" "}
        <strong>one bracket above</strong> it. Offers {MAX_BRACKET_GAP + 1} or more brackets apart,
        in either direction, cannot be sent.
      </p>
      <p>
        When the two items are one bracket apart, the person who ends up with the higher-bracket
        item pays a <strong>bridging fee</strong> of {BRIDGE_FEE_PER_BRACKET} Leaves for each
        bracket of the lower item — which is always their own. If you offer an item one bracket
        below the listing, you pay when you send. If you are offered an item one bracket above your
        listing, you pay when you accept.
      </p>
      <ul>
        <li>The fee is <strong>held</strong> from your balance when you commit, not spent.</li>
        <li>When the swap completes, it goes to the other person.</li>
        <li>
          If the offer is declined, withdrawn, or expires unanswered after {OFFER_EXPIRY_DAYS} days,
          or the trade is cancelled before completion, it comes back to you in full.
        </li>
        <li>You must have the fee in your balance to send or accept a bridged offer.</li>
      </ul>
      <p>
        By ticking <em>&ldquo;I agree to the bridging fee and the trading policy&rdquo;</em> you
        agree to have the fee held and, on completion, paid to the other party under these terms.
        Your agreement is recorded with the date and this policy version.
      </p>

      <h2 id="reward" style={{ fontSize: 20, marginTop: 32 }}>Completing a trade</h2>
      <p>
        When both people confirm a swap, each earns {TRADE_REWARD_PER_BRACKET} Leaves for every
        bracket of the item they gave. Nothing is earned on a trade that is declined, cancelled,
        expired or disputed. To keep this fair, no reward is issued for trading with the same person
        again within {TRADE_REWARD_REPEAT_PAIR_DAYS} days, for the same item again within{" "}
        {TRADE_REWARD_SAME_ITEM_DAYS} days, or once you have earned{" "}
        {TRADE_REWARD_DAILY_CAP_LEAVES} Leaves from trades in a day. An admin may reverse a reward
        on a trade that turns out not to have been genuine.
      </p>

      <h2 id="value" style={{ fontSize: 20, marginTop: 32 }}>Setting your own value</h2>
      <p>
        Baylo suggests a value for every listing. You may lower it as far as you like, or raise it
        up to {VALUE_RAISE_BRACKETS} bracket above the suggestion&apos;s bracket. A value higher
        than that is saved as you asked, but the listing shows only to you until an admin has
        checked it.
      </p>

      <p style={{ fontSize: 14, color: "#666", marginTop: 40 }}>
        Leaves are Baylo&apos;s trading points. They have no cash value and cannot be bought, sold or
        exchanged for money.
      </p>
    </main>
  )
}
