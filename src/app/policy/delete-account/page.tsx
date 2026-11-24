import { OPERATOR_NAME, SUPPORT_EMAIL } from "@/lib/support"
import { PolicyDocument, PolicySection } from "@/components/PolicyDocument"

/**
 * /policy/delete-account — how to delete a Baylo account, with or without the
 * app. Google Play asks for a web link that does this (21 Oct 2026); the app's
 * own Settings button is not enough on its own, because someone who has
 * already uninstalled Baylo cannot reach it.
 *
 * No form and no API route: an email from the account's own address is the
 * proof of ownership, and staff run the same deleteAccount() the app does.
 * The deleted-vs-kept lists follow api/user/delete-account.ts -- change them
 * together, and the privacy policy's "How long we keep it" with them.
 *
 * Public and shell-less, like /policy/trading — see the note there.
 */
export const metadata = { title: "Delete your Baylo account" }

/** How long an emailed request may take. Said once here, so the page cannot disagree with itself. */
const EMAIL_REQUEST_DAYS = 7

export default function DeleteAccountPage() {
  return (
    <PolicyDocument title="Delete your Baylo account">
      <p>
        Baylo is run by {OPERATOR_NAME}. You can delete your Baylo account at any time, from the app
        or without it.
      </p>

      <PolicySection id="in-app" title="In the app">
        <p>
          Open Settings, then &quot;Delete account&quot;, and confirm. If you signed up with a
          password, you will be asked for it. The account is deleted straight away.
        </p>
      </PolicySection>

      <PolicySection id="by-email" title="Without the app">
        <p>
          Send an email to{" "}
          <a href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Delete my account")}`}>
            {SUPPORT_EMAIL}
          </a>{" "}
          with the subject <strong>Delete my account</strong>.
        </p>
        <ul>
          <li>
            Send it from the email address your Baylo account uses, so we know the request is yours.
            We cannot act on a request from any other address.
          </li>
          <li>We will delete the account within {EMAIL_REQUEST_DAYS} days and reply to confirm.</li>
        </ul>
      </PolicySection>

      <PolicySection id="deleted" title="What is deleted">
        <ul>
          <li>Your name, email address, date of birth, password, profile photo, bio and location.</li>
          <li>Your listings, and any pickup location on them.</li>
          <li>Your follows, likes and notifications.</li>
          <li>Your ID verification records.</li>
          <li>Your push notification token, and every place you are signed in.</li>
          <li>
            Messages and comments you wrote are replaced with &quot;[deleted]&quot;, and the text of
            reviews you wrote is removed.
          </li>
          <li>
            Offers you sent that are still waiting are declined, and trades not yet completed are
            cancelled.
          </li>
        </ul>
      </PolicySection>

      <PolicySection id="kept" title="What is kept">
        <p>
          An anonymous record of your account remains, with the history of Leaves and completed
          trades, so that other people&apos;s records and balances stay correct. It no longer shows
          your name, email or anything else that says who you were, and it is kept for as long as
          Baylo runs.
        </p>
      </PolicySection>

      <PolicySection id="more" title="More">
        <p>
          The <a href="/policy/privacy">privacy policy</a> says what Baylo collects and why. For
          anything else, write to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>
      </PolicySection>
    </PolicyDocument>
  )
}
