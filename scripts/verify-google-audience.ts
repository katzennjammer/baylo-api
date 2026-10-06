// Checks the audience rule behind POST /api/auth/google/token.
// Pure logic, no database, no network.
// Run:  npx tsx scripts/verify-google-audience.ts
import {
  googleAudiencePolicy,
  isConfigured,
  isTrustedGoogleAudience,
} from "../src/lib/google-audience"

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${String(actual)}, want ${String(expected)})`}`)
}

const policy = googleAudiencePolicy({
  GOOGLE_CLIENT_ID: "999-webclient.apps.googleusercontent.com",
  GOOGLE_NATIVE_CLIENT_IDS: " 111-listed.apps.googleusercontent.com ,",
  GOOGLE_TRUSTED_PROJECTS: "519487980064, 28732296862, not-a-number",
})

check("configured", isConfigured(policy), true)
check("non-numeric project entries are dropped", policy.trustedProjects.join(","), "519487980064,28732296862")

// Exact ids keep working exactly as before.
check("web client id", isTrustedGoogleAudience("999-webclient.apps.googleusercontent.com", policy), true)
check("listed native id (trimmed)", isTrustedGoogleAudience("111-listed.apps.googleusercontent.com", policy), true)

// Any client minted in a trusted project.
check("new Android client in trusted project", isTrustedGoogleAudience("519487980064-p1aystore9.apps.googleusercontent.com", policy), true)
check("dev client in second trusted project", isTrustedGoogleAudience("28732296862-hgscabc123.apps.googleusercontent.com", policy), true)

// Everything else is refused.
check("client from an untrusted project", isTrustedGoogleAudience("123456789-other.apps.googleusercontent.com", policy), false)
check("trusted prefix, foreign domain", isTrustedGoogleAudience("519487980064-x.apps.googleusercontent.com.evil.example", policy), false)
check("trusted prefix, wrong domain", isTrustedGoogleAudience("519487980064-anything.evil.example", policy), false)
check("project number is a prefix of another", isTrustedGoogleAudience("5194879800641-x.apps.googleusercontent.com", policy), false)
check("uppercase suffix (not a real client id)", isTrustedGoogleAudience("519487980064-ABC.apps.googleusercontent.com", policy), false)
check("aud as array", isTrustedGoogleAudience(["519487980064-x.apps.googleusercontent.com"], policy), false)
check("aud missing", isTrustedGoogleAudience(undefined, policy), false)
check("aud empty string", isTrustedGoogleAudience("", policy), false)

// Fail closed with nothing configured.
const empty = googleAudiencePolicy({})
check("empty config is not configured", isConfigured(empty), false)
check("empty config trusts nothing", isTrustedGoogleAudience("519487980064-x.apps.googleusercontent.com", empty), false)

// Projects only, no exact ids: still configured.
const projectsOnly = googleAudiencePolicy({ GOOGLE_TRUSTED_PROJECTS: "519487980064" })
check("projects-only config is configured", isConfigured(projectsOnly), true)

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
