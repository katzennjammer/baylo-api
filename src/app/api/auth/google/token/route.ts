import { NextRequest, NextResponse } from "next/server"
import { createRemoteJWKSet, jwtVerify } from "jose"
import prisma from "@/lib/prisma"
import { issueTokenPair, toTokenUser } from "@/lib/auth-tokens"
import { markVerified } from "@/lib/verification"
import { suspensionState, activeSuspension, suspendedBody, notifySuspensionEnded } from "@/lib/moderation"
import { googleAudiencePolicy, isConfigured, isTrustedGoogleAudience } from "@/lib/google-audience"

/**
 * POST /api/auth/google/token — Google sign-in for the native client.
 *
 * The native app runs the Google flow itself and ends up holding an ID token.
 * It sends that here, and gets back the same pair every other token endpoint
 * returns. The web app is unaffected: it keeps redirecting through NextAuth's
 * Google provider.
 *
 * The ID token is UNTRUSTED INPUT. It is a JWT, which means anyone can write
 * one that says whatever they like — including `email: someone-elses@gmail.com`
 * — and it will parse perfectly. Only the signature makes it evidence. Every
 * one of the four checks below is load-bearing:
 *
 *   signature — against Google's published keys, fetched from their JWKS
 *               endpoint. Without it the token is a self-declaration and this
 *               endpoint is an unauthenticated "log me in as anyone" API.
 *   issuer    — must be Google. A validly-signed token from some other issuer
 *               proves nothing about a Google account.
 *   audience  — must be one of OUR client ids: listed exactly, or minted in a
 *               project named in GOOGLE_TRUSTED_PROJECTS (see
 *               @/lib/google-audience). Google signs ID tokens for every app on
 *               the platform with the same keys, so without this check a token
 *               issued to an unrelated app is accepted here verbatim.
 *   expiry    — enforced by jwtVerify.
 *
 * `email_verified` is checked separately: Google can assert an email it has not
 * itself confirmed, and an unconfirmed one must not be allowed to match an
 * existing Baylo account by address.
 */

const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"))
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"]

interface GoogleIdTokenClaims {
  aud?: unknown
  email?: string
  email_verified?: boolean | string
  name?: string
  picture?: string
}

export async function POST(req: NextRequest) {
  let body: { idToken?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const idToken = typeof body.idToken === "string" ? body.idToken.trim() : ""
  if (!idToken) return NextResponse.json({ error: "idToken is required" }, { status: 400 })

  const policy = googleAudiencePolicy()
  if (!isConfigured(policy)) {
    // Refuse rather than fall back to an unchecked audience: a missing config
    // must fail closed, because the permissive alternative is the vulnerability.
    return NextResponse.json({ error: "Google sign-in is not configured" }, { status: 500 })
  }

  let claims: GoogleIdTokenClaims
  try {
    // Signature, issuer and expiry here; the audience is checked just below,
    // because jose's `audience` option only takes an exact list and a trusted
    // PROJECT is a pattern, not a list.
    const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, { issuer: GOOGLE_ISSUERS })
    claims = payload as GoogleIdTokenClaims
  } catch {
    return NextResponse.json({ error: "Invalid Google ID token" }, { status: 401 })
  }
  if (!isTrustedGoogleAudience(claims.aud, policy)) {
    return NextResponse.json({ error: "Invalid Google ID token" }, { status: 401 })
  }

  const email = claims.email?.trim().toLowerCase()
  // Google emits this as a boolean, but has historically emitted the string
  // "true" as well; both mean verified and anything else does not.
  const emailVerified = claims.email_verified === true || claims.email_verified === "true"

  if (!email || !emailVerified) {
    return NextResponse.json({ error: "Google account has no verified email" }, { status: 401 })
  }

  // Find-or-create by email, matching the web signIn callback exactly: same
  // lookup key, same fallback name, same avatar source. Both paths must land on
  // the same account, or a user who signs in on web and then on mobile ends up
  // with two.
  const existing = await prisma.user.findUnique({
    where: { email },
    include: { suspensions: activeSuspension() },
  })

  // A verified Google ID token for this email is the proof of ownership a
  // correct password is on /api/auth/token, so the same answer is safe here.
  // Without it a suspended account was handed a token pair that every other
  // route then refused: the app signed in "successfully" into a wall of 401s,
  // with nothing anywhere saying why.
  if (existing) {
    const suspension = suspensionState(existing)
    if (suspension.suspended) return NextResponse.json(suspendedBody(suspension), { status: 403 })
    // Back after a suspension: say so, once. See notifySuspensionEnded().
    await notifySuspensionEnded(prisma, existing.id)
  }
  const user =
    existing ??
    (await prisma.user.create({
      data: {
        name: claims.name ?? "Baylo User",
        email,
        avatar: claims.picture ?? null,
      },
    }))

  // Google sign-in verifies the account, here exactly as on the web. This is
  // also what awards VERIFY_ACCOUNT and the one-time signup grant — idempotent,
  // so a returning user's second sign-in credits nothing.
  await markVerified(user.id)

  const pair = await issueTokenPair(user.id)

  /**
   * The one thing a Google ID token cannot tell this backend.
   *
   * Baylo is 18+, and Google asserts an email, a name and a picture — never an
   * age. So an account that arrived this way owes a date of birth, and the
   * native client is told so rather than left to guess: it holds this pair
   * WITHOUT installing it, asks, POSTs /api/auth/date-of-birth, and adopts the
   * session only once that is accepted.
   *
   * Reported rather than ENFORCED here, and that is deliberate. Refusing to
   * issue the pair would leave the client with no credential to answer with,
   * and the one endpoint that could set the date of birth is authenticated.
   * The write-once conditional update in that route is what makes the pair safe
   * to hand over first.
   *
   * ADDITIVE. A client that predates this field ignores it and behaves exactly
   * as it did before — which is correct for the web app, whose own signup form
   * collects the date at registration.
   */
  const needsDateOfBirth = user.dateOfBirth === null

  return NextResponse.json({ ...pair, user: toTokenUser(user), needsDateOfBirth })
}
