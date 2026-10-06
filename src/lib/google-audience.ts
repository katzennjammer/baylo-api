/**
 * Which Google OAuth clients may sign a user in to this backend.
 *
 * A Google ID token's `aud` is the OAuth client id the token was issued to.
 * Google signs tokens for EVERY app on the platform with the same keys, so the
 * signature alone proves nothing about which app asked; the audience check is
 * what stops a token issued to an unrelated app being accepted here.
 *
 * ── TWO WAYS TO TRUST A CLIENT ─────────────────────────────────────────────────
 *
 *   exact id   GOOGLE_CLIENT_ID and GOOGLE_NATIVE_CLIENT_IDS, as before.
 *   project    GOOGLE_TRUSTED_PROJECTS: every client id minted in one of these
 *              Google Cloud projects. A client id is
 *              `<project number>-<suffix>.apps.googleusercontent.com`, and only
 *              someone with access to that project can create one, so trusting
 *              the project is trusting its owners — the same people who would
 *              otherwise paste the new id into GOOGLE_NATIVE_CLIENT_IDS.
 *
 * The project rule exists because every Android build signed with a different
 * key needs its own Android client (debug, EAS internal, Play App Signing), and
 * each one used to mean an edit here and a server restart. Adding a client
 * inside a trusted project now needs neither.
 *
 * ── WHAT IT DOES NOT LOOSEN ────────────────────────────────────────────────────
 *
 * Signature, issuer and expiry are still checked by the caller before this runs.
 * The suffix must look like a real client id suffix, so a crafted
 * `519487980064-anything.evil.example` does not match. An `aud` array is refused
 * outright: Google ID tokens carry exactly one audience, and a list would let a
 * token that ALSO names a trusted id smuggle in any other.
 *
 * Fails closed: with nothing configured, `isConfigured()` is false and the route
 * refuses rather than accepting an unchecked audience.
 */

const CLIENT_ID_PATTERN = /^(\d+)-[a-z0-9]+\.apps\.googleusercontent\.com$/

function splitList(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((s) => s.trim()).filter(Boolean))]
}

export interface GoogleAudiencePolicy {
  exactIds: string[]
  trustedProjects: string[]
}

export function googleAudiencePolicy(
  env: Record<string, string | undefined> = process.env,
): GoogleAudiencePolicy {
  return {
    exactIds: splitList([env.GOOGLE_CLIENT_ID, env.GOOGLE_NATIVE_CLIENT_IDS].filter(Boolean).join(",")),
    // Project numbers only; anything else in the list is ignored, never matched.
    trustedProjects: splitList(env.GOOGLE_TRUSTED_PROJECTS).filter((p) => /^\d+$/.test(p)),
  }
}

export function isConfigured(policy: GoogleAudiencePolicy): boolean {
  return policy.exactIds.length > 0 || policy.trustedProjects.length > 0
}

/** True when `aud` names a client this backend trusts. */
export function isTrustedGoogleAudience(aud: unknown, policy: GoogleAudiencePolicy): boolean {
  if (typeof aud !== "string") return false
  if (policy.exactIds.includes(aud)) return true
  const match = CLIENT_ID_PATTERN.exec(aud)
  return match !== null && policy.trustedProjects.includes(match[1])
}
