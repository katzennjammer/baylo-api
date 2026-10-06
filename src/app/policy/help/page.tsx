import { MIN_AGE } from "@/lib/age"
import { MAX_ID_SUBMISSIONS } from "@/lib/id-verification"
import { OFFER_EXPIRY_DAYS } from "@/lib/offers"
import { SUPPORT_EMAIL } from "@/lib/support"
import { PolicyDocument, PolicySection } from "@/components/PolicyDocument"

/**
 * /policy/help — where "Contact support" finally leads.
 *
 * The app tells people to contact support in several refusals (an exhausted
 * ID verification, a suspension) and until this page never said how. Settings
 * opens it; the address comes from @/lib/support, the one place it is spelled.
 *
 * Answers describe screens that exist in the app (3 Oct 2026) and name them as
 * the app does. Numbers are imported. Not a `legal` page: it promises nothing,
 * so it carries no draft notice.
 *
 * Public and shell-less, like /policy/trading — see the note there.
 */
export const metadata = { title: "Baylo help" }

export default function HelpPage() {
  return (
    <PolicyDocument title="Help">
      <p>
        Answers to common questions. If yours is not here, write to{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>

      <PolicySection id="account" title="Account">
        <p>
          <strong>I did not get the verification email.</strong>{" "}Open Settings and tap &quot;Verify
          your email&quot; to send it again. Check your spam folder, and open the link on the phone
          that has Baylo installed.
        </p>
        <p>
          <strong>I forgot my password.</strong>{" "}On the sign-in screen, tap &quot;Forgot
          password?&quot;.
        </p>
        <p>
          <strong>I signed up with Google and want a password.</strong>{" "}Open Settings, then
          &quot;Change password&quot;.
        </p>
        <p>
          <strong>How do I delete my account?</strong>{" "}Open Settings, then &quot;Delete account&quot;.
          This cannot be undone.
        </p>
      </PolicySection>

      <PolicySection id="id" title="ID verification">
        <p>
          <strong>Why do I need it?</strong>{" "}Baylo is for people aged {MIN_AGE} and over, and trades
          happen in person. A checked ID is required before you can post an item.
        </p>
        <p>
          <strong>My ID was not approved.</strong>{" "}Open Settings, then &quot;Verify your ID&quot; to
          see the reason and send it again. Use a clear, uncropped photo. You have{" "}
          {MAX_ID_SUBMISSIONS} attempts; if you have used them all, write to us.
        </p>
      </PolicySection>

      <PolicySection id="trading" title="Trading">
        <p>
          <strong>How does a trade work?</strong>{" "}You offer one of your items for someone else&apos;s.
          If they accept, the two of you agree where and when to meet, swap the items in person, and
          each confirm the trade with a code. Open Settings, then &quot;How trading works&quot; for
          the full explanation.
        </p>
        <p>
          <strong>My offer got no answer.</strong>{" "}An offer expires after {OFFER_EXPIRY_DAYS} days.
          Any bridging fee held for it is returned to you.
        </p>
        <p>
          <strong>What is the bridging fee?</strong>{" "}See the{" "}
          <a href="/policy/trading">trading policy</a>.
        </p>
        <p>
          <strong>Where should we meet?</strong>{" "}At a Safe Zone hub. Check the item before you
          confirm, and confirm only when you have it in your hands.
        </p>
      </PolicySection>

      <PolicySection id="shop" title="Shops">
        <p>
          <strong>How do I register my shop?</strong>{" "}Open Settings, then &quot;Register your
          shop&quot;. You will need your business details and a photo of a business document. The
          shop can post once it has been approved.
        </p>
        <p>
          <strong>How do I post as my shop or as myself?</strong>{" "}Open Settings and choose under
          Account.
        </p>
      </PolicySection>

      <PolicySection id="safety" title="Safety">
        <p>
          <strong>How do I report a listing?</strong>{" "}Open the listing and tap &quot;Report this
          listing&quot;.
        </p>
        <p>
          <strong>How do I block someone?</strong>{" "}Open the menu on one of their listings, or in
          your conversation with them, and choose Block. To undo it, open Settings, then
          &quot;Blocked users&quot;.
        </p>
        <p>
          <strong>My listing was hidden, or its value was not approved.</strong>{" "}Open the listing and
          tap &quot;Appeal this decision&quot;.
        </p>
        <p>
          <strong>My account was suspended.</strong>{" "}Write to us from the email address on your
          account.
        </p>
      </PolicySection>

      <PolicySection id="contact" title="Contact us">
        <p>
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. Tell us the email address on your
          account and what happened.
        </p>
        <p>
          <a href="/policy/terms">Terms of service</a>, <a href="/policy/privacy">privacy policy</a>
          , <a href="/policy/trading">trading policy</a>.
        </p>
      </PolicySection>
    </PolicyDocument>
  )
}
