import { MIN_AGE } from "@/lib/age"
import { MAX_ID_SUBMISSIONS } from "@/lib/id-verification"
import { OPERATOR_NAME, SUPPORT_EMAIL } from "@/lib/support"
import { PolicyDocument, PolicySection } from "@/components/PolicyDocument"

/**
 * /policy/terms — the rules for using Baylo.
 *
 * ── WHAT THIS PAGE DOES NOT RESTATE ─────────────────────────────────────────
 *
 * Brackets, the bridging fee, the trade reward and the value-raise rule are
 * /policy/trading's, where every number is imported from the module that
 * enforces it. This page links there instead of repeating a figure that would
 * then have two places to go stale. The privacy policy is likewise linked, not
 * summarised.
 *
 * ── WRITTEN FROM THE CODE ───────────────────────────────────────────────────
 *
 * The rules below are the ones the server enforces (3 Oct 2026): the age gate
 * (@/lib/age), ID before posting (@/lib/id-verification), reports, takedowns,
 * suspensions and appeals (@/lib/moderation, @/lib/appeals), and Leaves having
 * no cash value (the closing line of /policy/trading).
 *
 * ── TWO PARTS ARE NOT FROM THE CODE, AND NEED A DECISION ────────────────────
 *
 * THE PROHIBITED LIST under "What you may list". The server knows only that a
 * listing can be reported as a "prohibited item" (@/lib/moderation); nothing
 * in the codebase says what is prohibited. The list here is a proposal for
 * the team to accept or change, not a record of an existing rule.
 *
 * THE LIABILITY AND GOVERNING-LAW SECTIONS are the ordinary shape of such
 * terms and have not been reviewed by anyone qualified to give legal advice.
 *
 * A DRAFT until POLICY_IS_DRAFT in @/lib/support is set to false.
 *
 * Public and shell-less, like /policy/trading — see the note there.
 */
export const metadata = { title: "Baylo terms of service" }

export default function TermsPage() {
  return (
    <PolicyDocument title="Terms of service" legal>
      <p>
        Baylo is a barter app run by {OPERATOR_NAME}. It lets people swap items with each other
        without money. By creating an account you agree to these terms, to the{" "}
        <a href="/policy/trading">trading policy</a> and to the{" "}
        <a href="/policy/privacy">privacy policy</a>.
      </p>

      <PolicySection id="account" title="Your account">
        <ul>
          <li>You must be {MIN_AGE} or older to use Baylo.</li>
          <li>The details you give, including your date of birth, must be true and your own.</li>
          <li>One person, one account. A shop is registered from its owner&apos;s account.</li>
          <li>Keep your password to yourself. You are responsible for what is done from your account.</li>
        </ul>
      </PolicySection>

      <PolicySection id="verification" title="Verification">
        <p>
          Before you can post an item, you must verify a government ID. A reviewer checks it. You
          have {MAX_ID_SUBMISSIONS} attempts; after that, write to us. One ID can verify one account.
        </p>
        <p>
          A shop must send a business document and be approved before it can post. Until then you
          can still post as yourself.
        </p>
      </PolicySection>

      <PolicySection id="listings" title="What you may list">
        <p>You may list only items that you own and are free to give away. You may not list:</p>
        <ul>
          <li>anything illegal to own or trade in the Philippines;</li>
          <li>weapons, drugs, alcohol, tobacco, or medicines;</li>
          <li>stolen or counterfeit goods;</li>
          <li>live animals;</li>
          <li>anything unsafe, recalled, or expired.</li>
        </ul>
        <p>
          Photos and descriptions must be your own and must show the item as it is. Food and other
          perishable items must be safe to eat and must carry a true expiry date.
        </p>
      </PolicySection>

      <PolicySection id="trading" title="Trading">
        <p>
          Trades are item for item. No money changes hands through Baylo, and you must not ask for
          or offer cash for a listing. The rules for offers, brackets and the bridging fee are in the{" "}
          <a href="/policy/trading">trading policy</a>.
        </p>
        <p>
          A trade is between you and the other person. Baylo provides the place to find each other
          and records what you agreed; it does not own, inspect, store or deliver any item, and does
          not guarantee an item&apos;s condition or that the other person will turn up.
        </p>
        <p>
          Trades are completed in person. Meet at one of the Safe Zone hubs, check the item before
          you confirm, and confirm only when you have it in your hands.
        </p>
      </PolicySection>

      <PolicySection id="leaves" title="Leaves">
        <p>
          Leaves are Baylo&apos;s trading points. They have no cash value, cannot be bought, sold or
          exchanged for money, and cannot be transferred except as the trading policy describes. We
          may correct a balance that resulted from an error or from trades that were not genuine.
        </p>
      </PolicySection>

      <PolicySection id="premium" title="Premium">
        <p>
          Premium is optional. Its price, what it includes and how long it lasts are shown in the app
          before you buy. Baylo is in beta, and the price and terms of Premium may change for new
          purchases.
        </p>
      </PolicySection>

      <PolicySection id="conduct" title="How to behave">
        <p>You must not:</p>
        <ul>
          <li>harass, threaten or deceive other people;</li>
          <li>post content that is hateful, sexual or violent;</li>
          <li>use someone else&apos;s photos, ID or identity;</li>
          <li>set up trades only to collect Leaves;</li>
          <li>try to break, overload or get around Baylo&apos;s systems or rules.</li>
        </ul>
        <p>
          You can report a listing, a person or a message in the app, and you can block anyone you
          do not want to hear from.
        </p>
      </PolicySection>

      <PolicySection id="enforcement" title="What we may do">
        <p>
          We may hide a listing, hold a listing&apos;s value for review, reverse Leaves earned from a
          trade that was not genuine, and suspend an account that breaks these terms, for a set time
          or indefinitely. If your listing is hidden or its value is not approved, you can appeal that
          decision in the app. To question a suspension, write to us.
        </p>
      </PolicySection>

      <PolicySection id="content" title="Your content">
        <p>
          What you post stays yours. You give Baylo permission to store it and show it to other
          people in the app for as long as it is posted, and to check it automatically, for example
          to suggest a category or to spot reused photos.
        </p>
      </PolicySection>

      <PolicySection id="leaving" title="Leaving">
        <p>
          You can delete your account at any time, in the app under Settings. Open offers and trades
          are cancelled and your Leaves are given up. The privacy policy says what is erased.
        </p>
      </PolicySection>

      <PolicySection id="liability" title="Our responsibility">
        <p>
          Baylo is provided as it is, and may be changed, interrupted or withdrawn. To the extent the
          law allows, {OPERATOR_NAME} is not responsible for loss or harm arising from a trade, from
          an item, or from meeting another person. Nothing here limits a right that Philippine law
          does not allow to be limited.
        </p>
      </PolicySection>

      <PolicySection id="changes" title="Changes to these terms">
        <p>
          If these terms change in a way that matters, we will say so in the app before the change
          applies. These terms are governed by the laws of the Republic of the Philippines.
        </p>
      </PolicySection>

      <PolicySection id="contact" title="Contact">
        <p>
          Questions about these terms: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>
      </PolicySection>
    </PolicyDocument>
  )
}
