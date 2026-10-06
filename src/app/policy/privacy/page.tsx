import { MIN_AGE } from "@/lib/age"
import { REFRESH_TOKEN_TTL_DAYS } from "@/lib/auth-tokens"
import { OPERATOR_NAME, SUPPORT_EMAIL } from "@/lib/support"
import { PolicyDocument, PolicySection } from "@/components/PolicyDocument"

/**
 * /policy/privacy — what Baylo collects, why, who else handles it, and how to
 * get it corrected or erased.
 *
 * ── WRITTEN FROM THE CODE, NOT FROM A TEMPLATE ──────────────────────────────
 *
 * Each statement below describes something this codebase does, checked on
 * 3 Oct 2026. If the behaviour changes, this page has to change with it — the
 * places to re-read are named beside the claims that depend on them:
 *
 *   ID photo deleted after the decision     @/lib/id-verification-image
 *   ID number stored only as a hash         IdVerification.idNumberHash
 *   business document deleted after review  @/lib/org-document
 *   photos re-encoded, location data gone   @/lib/image-sanitize
 *   pickup point shown imprecisely          @/lib/item-visibility
 *   what account deletion erases            api/user/delete-account.ts
 *   photos sent to Anthropic                api/ai/identify, api/ai/phash
 *   device location never sent here         the app's src/api has no lat/lng
 *
 * A DRAFT until POLICY_IS_DRAFT in @/lib/support is set to false. It has not
 * been reviewed by anyone qualified to give legal advice, and the Data Privacy
 * Act section in particular needs that review before a store release.
 *
 * Public and shell-less, like /policy/trading — see the note there.
 */
export const metadata = { title: "Baylo privacy policy" }

export default function PrivacyPolicyPage() {
  return (
    <PolicyDocument title="Privacy policy" legal>
      <p>
        Baylo is a barter app run by {OPERATOR_NAME}. This page says what information Baylo collects
        when you use it, what it is used for, who else handles it, and what you can do about it.
      </p>

      <PolicySection id="collect" title="What we collect">
        <p>
          <strong>Your account.</strong>{" "}Your name, email address and date of birth. If you sign up
          with a password, we store a scrambled (hashed) version of it, never the password itself. If
          you sign in with Google, Google gives us your name, email address and profile picture.
        </p>
        <p>
          <strong>Your profile.</strong>{" "}Anything you choose to add: a photo, a short bio and a
          location.
        </p>
        <p>
          <strong>ID verification.</strong>{" "}To post items you send a photo of a government ID, its
          type and its number. The photo is kept only until a reviewer has decided, and is then
          deleted. The ID number is stored only as a one-way hash, which lets us check that one ID
          is used for one account without keeping the number itself.
        </p>
        <p>
          <strong>Shop registration.</strong>{" "}If you register a shop: the business name, category,
          DTI registration number and a photo of a business document. The document is deleted once
          it has been reviewed.
        </p>
        <p>
          <strong>Your listings.</strong>{" "}Photos, titles, descriptions, values, the Safe Zone hubs you
          pick and, if you give one, a pickup location. Photos are re-saved when you upload them,
          which removes hidden details such as where the photo was taken.
        </p>
        <p>
          <strong>Your trading activity.</strong>{" "}Offers, trades, meet-up plans, confirmation codes,
          reviews, and your Leaves balance with the history of how it changed.
        </p>
        <p>
          <strong>What you say and do.</strong>{" "}Messages, including pictures you send in them,
          comments, likes, the people you follow, reports you file and users you block.
        </p>
        <p>
          <strong>Sign-in sessions.</strong>{" "}A record that lets this phone stay signed in for up to{" "}
          {REFRESH_TOKEN_TTL_DAYS} days, which you can end at any time by signing out.
        </p>
      </PolicySection>

      <PolicySection id="location" title="Your location">
        <p>
          If you allow it, the app uses your phone&apos;s location to show the Safe Zone hubs nearest
          to you. That happens on your phone. Your phone&apos;s location is not sent to Baylo and is
          not stored.
        </p>
        <p>
          A pickup location you add to a listing is different: you typed it in, and it is stored with
          the listing. Other people see only an approximate area. The exact point is shown only to
          you and to someone whose trade with you has been accepted.
        </p>
      </PolicySection>

      <PolicySection id="use" title="What we use it for">
        <ul>
          <li>To run your account and keep it secure.</li>
          <li>To show your listings to other people and theirs to you.</li>
          <li>To carry out offers, trades and Leaves payments, and to keep a correct record of them.</li>
          <li>To check that people are {MIN_AGE} or older and that an ID belongs to one account.</li>
          <li>To suggest a category, a condition and a value when you post an item.</li>
          <li>To catch listings that reuse someone else&apos;s photos.</li>
          <li>
            To recommend listings, based on your own trades, offers, likes, comments and listings.
            Baylo does not track what you view or search for.
          </li>
          <li>To send emails you need: verifying your address, resetting a password, trade codes.</li>
          <li>To handle reports, and to act on listings or accounts that break the rules.</li>
        </ul>
        <p>Baylo does not sell your information and does not show advertising.</p>
      </PolicySection>

      <PolicySection id="others-see" title="What other people can see">
        <p>
          Your name, photo, bio, trust level, ratings, reviews, badges, follower counts and listings
          are visible to other people using Baylo. Your email address, date of birth, ID details,
          Leaves history and messages are not.
        </p>
      </PolicySection>

      <PolicySection id="providers" title="Companies that handle information for us">
        <p>Baylo relies on these services. Each receives only what it needs to do its job.</p>
        <ul>
          <li>
            <strong>Supabase</strong>{" "}hosts the database where accounts, listings and trades are
            stored.
          </li>
          <li>
            <strong>Cloudinary</strong>{" "}stores photos: listing photos, profile photos, and ID and
            business documents until they are reviewed.
          </li>
          <li>
            <strong>Anthropic</strong>{" "}receives each listing photo so its Claude model can suggest a
            category and condition and help spot reused photos. ID photos and business documents
            are never sent to it.
          </li>
          <li>
            <strong>Pusher</strong>{" "}delivers messages and notifications to your phone as they
            happen.
          </li>
          <li>
            <strong>Google</strong>{" "}confirms who you are if you choose to sign in with Google.
          </li>
          <li>
            <strong>Our email provider</strong>{" "}sends the emails listed above.
          </li>
          <li>
            <strong>OpenStreetMap</strong>{" "}supplies the map pictures. Your phone asks it for them
            directly, so it sees your phone&apos;s internet address and which part of the map you
            are viewing.
          </li>
        </ul>
        <p>Some of these services store information outside the Philippines.</p>
      </PolicySection>

      <PolicySection id="keep" title="How long we keep it">
        <p>We keep your information for as long as you have an account.</p>
        <p>
          You can delete your account in the app, under Settings. When you do, your name, email
          address, date of birth, password, photo, bio and location are erased, your listings are removed, and your
          follows, likes, notifications and ID verification records are deleted. Messages and
          comments you wrote are replaced with &quot;[deleted]&quot;, and the text of reviews you
          wrote is removed.
        </p>
        <p>
          An anonymous record remains, with the history of Leaves and trades, so that other
          people&apos;s records and balances stay correct. It no longer shows who you were.
        </p>
      </PolicySection>

      <PolicySection id="rights" title="Your choices and rights">
        <ul>
          <li>You can see and change your profile in the app at any time.</li>
          <li>You can delete your account in the app at any time.</li>
          <li>You can turn off location access in your phone&apos;s settings; the map still works.</li>
          <li>
            Under the Philippine Data Privacy Act of 2012 you can ask what information we hold about
            you, ask us to correct or erase it, object to how it is used, and complain to the
            National Privacy Commission.
          </li>
        </ul>
        <p>
          To use any of these, write to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>
      </PolicySection>

      <PolicySection id="age" title="Age">
        <p>
          Baylo is for people aged {MIN_AGE} and over. We ask for a date of birth to check this and do
          not knowingly keep accounts for anyone younger.
        </p>
      </PolicySection>

      <PolicySection id="changes" title="Changes to this page">
        <p>
          If this policy changes in a way that matters, we will say so in the app before the change
          applies.
        </p>
      </PolicySection>

      <PolicySection id="contact" title="Contact">
        <p>
          Questions about your information: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>
      </PolicySection>
    </PolicyDocument>
  )
}
