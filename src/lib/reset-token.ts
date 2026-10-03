import { createHash } from "crypto"

/**
 * SHA-256 (lowercase hex) of a raw password-reset token, the only form stored
 * (AuthToken.tokenHash, schema v2). The same digest the v2 data migration
 * applied to the reset tokens that were stored in the clear, so a link mailed
 * before the migration still resolves after it.
 */
export function hashResetToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex")
}
