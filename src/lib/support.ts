/**
 * Who a user writes to, and whether the legal pages are final.
 *
 * ONE PLACE, because "Contact support" is said in a dozen refusal messages
 * across this codebase and none of them says how. The pages under /policy read
 * these two values; nothing else should spell the address out.
 */

/**
 * The address on the public site footer (SiteFooter.tsx). CONFIRM THE MAILBOX
 * EXISTS AND IS READ before the Play Store release: every "contact support"
 * in the app ends here.
 */
export const SUPPORT_EMAIL = "hello@baylo.ph"

/** The team that runs Baylo, as the pages name it. */
export const OPERATOR_NAME = "LoomLoop Labs"

/**
 * TRUE WHILE THE TERMS AND THE PRIVACY POLICY ARE DRAFTS.
 *
 * Both pages were written from what the code does (3 Oct 2026) and have not
 * been reviewed by the team, the adviser, or anyone qualified to give legal
 * advice. While this is true each page opens with a notice saying so. Set it
 * to false, and fill in POLICY_EFFECTIVE_DATE, only once they have been
 * reviewed and approved.
 */
export const POLICY_IS_DRAFT = true

/** Shown as "Effective <date>" once POLICY_IS_DRAFT is false. */
export const POLICY_EFFECTIVE_DATE = "—"
