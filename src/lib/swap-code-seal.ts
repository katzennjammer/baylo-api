import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "crypto"

/**
 * Reversible storage for a swap confirmation code, so the OWNER can be shown it.
 *
 * ══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
 *
 * `confirm/start` used to put the plaintext code in an email and a bcrypt hash
 * in the database, and nowhere else. On the web that was survivable — the person
 * confirming a swap is at a desk with their inbox open. On the phone it is not:
 * two people standing next to each other at a mall both have to leave the app,
 * find an email, and read a number out of it. The most complete feature in the
 * product was unusable from the client it was designed for.
 *
 * So the code has to be recoverable by its owner. The bcrypt hash cannot do
 * that — one-way is the whole point of it — which leaves three options, and it
 * is worth writing down why this is the one:
 *
 *   PLAINTEXT COLUMN            One `SELECT` away for anyone who reaches the
 *                               database: a dump, a stolen backup, a read-only
 *                               replica credential, an injection. Every live
 *                               code in the system, in one query. Rejected.
 *
 *   DETERMINISTIC REGENERATION  HMAC(key, tradeId|userId|salt). Nothing secret
 *                               at rest at all, which is genuinely better — but
 *                               regenerating a burned pair needs a salt that
 *                               changes per issuance, so it costs a column
 *                               anyway, and it replaces the CSPRNG that
 *                               `confirm/start` deliberately reaches for. Its
 *                               key-compromise story is identical to this one.
 *
 *   SEALED COLUMN (this)        AES-256-GCM under a key that lives in the
 *                               environment and never in the database. A dump
 *                               is inert without it. `randomInt()` stays the
 *                               source of the code, so the reasoning in
 *                               `confirm/start` about not drawing two codes from
 *                               a recoverable PRNG stream still holds.
 *
 * ══ THE HASH IS NOT REPLACED ════════════════════════════════════════════════
 *
 * `codeHash` stays exactly as it was and is still what `confirm/submit`
 * verifies against. Nothing about the guess budget, the burn, or the
 * constant-time comparison changes. The sealed copy is additive and is read on
 * exactly one path — the owner asking for their own code — so a bug here cannot
 * make a wrong code verify.
 *
 * That also means the two secrets protect different things and an attacker
 * needs both to gain anything: the database alone yields a bcrypt hash and a
 * ciphertext; the key alone yields nothing at all.
 *
 * ══ WHAT AN ATTACKER WITH A STOLEN ACCESS TOKEN GAINS ═══════════════════════
 *
 * Bounded, and worth being precise about, because "a code readable from the API
 * is a code a stolen token can read" is true and is the real cost here.
 *
 *   THEY GET THE VICTIM'S OWN CODE. That is the code the PARTNER types in. It
 *   is not the code the victim's own account submits, and `confirm/status`
 *   never returns the partner's — see the note on the route. So a stolen token
 *   cannot complete a trade by itself: completion needs both codes consumed,
 *   and the other one is only obtainable from the other person.
 *
 *   THEY ALREADY HAD IT. The same secret is mailed to the same person at the
 *   moment it is issued. An attacker holding a session token has, in almost
 *   every realistic path to holding one, at least as much access to that
 *   mailbox. This endpoint matches an exposure that already existed rather than
 *   opening a new one.
 *
 *   THE HARM IT ENABLES IS COLLUSION, WHICH THE FEATURE ALREADY PERMITS. Two
 *   people who want to record a meeting that did not happen simply read their
 *   codes to each other over the phone. `resolveMeetupHub()` says the same
 *   thing about the Safe-Zone claim in its own comment: this is pre-committed
 *   mutual self-attestation, not verification. Nothing here observes the world.
 *
 *   IT DOES NOT WIDEN THE GUESS SURFACE. The partner's code is still a 1-in-10⁶
 *   secret bounded by `MAX_CODE_ATTEMPTS`, unchanged.
 *
 * The residual risk is therefore: a stolen token lets an attacker learn a
 * short-lived secret about a trade that account is already party to, which
 * cannot be spent without the counterparty. Set against a feature that is
 * otherwise unusable on mobile, that is the right trade — but it IS a trade,
 * and the mitigations below are the price of it.
 *
 * ══ MITIGATIONS APPLIED AT THE ROUTE ════════════════════════════════════════
 *
 *   1. OWN ROW ONLY. The route selects by `(tradeId, viewerId)` and never opens
 *      a seal it did not fetch under the viewer's own id.
 *   2. LIVE ONLY. An expired or burned code is not returned. There is nothing
 *      to do with one, so there is no reason to hand it out.
 *   3. AAD BINDS THE CIPHERTEXT TO ITS ROW. `tradeId|userId` is authenticated
 *      additional data, so an attacker with database WRITE access cannot move a
 *      sealed value from one row to another and have it open — GCM's tag check
 *      fails. Without this, row-swapping would be a way to read someone else's
 *      code using your own session.
 *   4. FAIL CLOSED. No key, a malformed key, or a seal that will not open
 *      returns `null`, never a guess and never an error the client acts on. The
 *      mobile client already renders the null case — it points the reader at the
 *      email — so a deployment that never sets `SWAP_CODE_KEY` keeps exactly the
 *      behaviour it has today.
 *
 * ══ OPERATIONS ═════════════════════════════════════════════════════════════
 *
 * `SWAP_CODE_KEY` is 32 bytes, hex (64 chars) or base64. Generate one with:
 *
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * ROTATING IT INVALIDATES EVERY LIVE SEAL, and that is a 15-minute problem
 * rather than a data-loss one: unopenable seals return `null`, the affected
 * clients fall back to the email line, and the next `confirm/start` seals under
 * the new key. Nothing has to be re-encrypted and no migration is needed. The
 * `v1.` prefix is there so a future scheme can coexist rather than requiring a
 * flag day.
 */

/** Serialised form: `v1.<iv>.<tag>.<ciphertext>`, each base64url. */
const VERSION = "v1"
const IV_BYTES = 12 // 96 bits, the GCM standard nonce size
const KEY_BYTES = 32

/**
 * The key, decoded once and cached.
 *
 * `undefined` means "not read yet"; `null` means "read, and there isn't a usable
 * one". The distinction matters only so the warning below is logged once per
 * process rather than on every request.
 */
let cachedKey: Buffer | null | undefined

function key(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey

  const raw = process.env.SWAP_CODE_KEY?.trim()
  if (!raw) {
    cachedKey = null
    return null
  }

  let decoded: Buffer | null = null
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    decoded = Buffer.from(raw, "hex")
  } else {
    const b64 = Buffer.from(raw, "base64")
    if (b64.length === KEY_BYTES) decoded = b64
  }

  if (!decoded || decoded.length !== KEY_BYTES) {
    // Loud, once. A misconfigured key is indistinguishable from an absent one
    // at every call site by design, so this line is the only place it can be
    // noticed before somebody wonders why the app keeps citing the email.
    console.error(
      "[swap-code-seal] SWAP_CODE_KEY is set but is not 32 bytes of hex or base64. " +
        "Confirmation codes will not be readable in the app; the email path still works.",
    )
    cachedKey = null
    return null
  }

  cachedKey = decoded
  return cachedKey
}

/** True when a key is configured and usable. Read by the route, for `meta`. */
export function sealingAvailable(): boolean {
  return key() !== null
}

/**
 * The additional authenticated data that binds a seal to the row it belongs to.
 *
 * Not secret and not meant to be — its job is integrity, not confidentiality.
 * GCM authenticates it alongside the ciphertext, so a sealed value copied into a
 * different `(tradeId, userId)` row fails to open instead of yielding somebody
 * else's digits to whoever owns the destination row.
 */
function aad(tradeId: string, userId: string): Buffer {
  return Buffer.from(`swapcode:${tradeId}:${userId}`, "utf8")
}

/**
 * Seals a plaintext code for storage.
 *
 * Returns `null` when there is no key, which the caller stores as `null` — the
 * row is still perfectly valid, it simply has no readable copy, and the code
 * still reaches its owner by email.
 */
export function sealCode(code: string, tradeId: string, userId: string): string | null {
  const k = key()
  if (!k) return null

  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv("aes-256-gcm", k, iv)
  cipher.setAAD(aad(tradeId, userId))
  const ct = Buffer.concat([cipher.update(code, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()

  return [VERSION, b64u(iv), b64u(tag), b64u(ct)].join(".")
}

/**
 * Opens a seal. `null` for anything that is not exactly right.
 *
 * FAILS CLOSED, ALWAYS, AND SILENTLY. A wrong key, a truncated value, a tag
 * mismatch and a seal from a different row are all the same answer to the
 * caller: there is no readable code. Distinguishing them in the response would
 * tell an attacker which of those they had achieved.
 */
export function openCode(sealed: string | null, tradeId: string, userId: string): string | null {
  if (!sealed) return null
  const k = key()
  if (!k) return null

  const parts = sealed.split(".")
  if (parts.length !== 4 || parts[0] !== VERSION) return null

  try {
    const iv = unb64u(parts[1])
    const tag = unb64u(parts[2])
    const ct = unb64u(parts[3])
    if (iv.length !== IV_BYTES || tag.length !== 16) return null

    const decipher = createDecipheriv("aes-256-gcm", k, iv)
    decipher.setAAD(aad(tradeId, userId))
    decipher.setAuthTag(tag)
    const out = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8")

    // A seal that opens but holds something that is not a code is a bug
    // somewhere upstream, not a code. Refuse rather than hand it on.
    return /^\d{4,10}$/.test(out) ? out : null
  } catch {
    // `decipher.final()` throws on a tag mismatch. That is the expected path
    // for a rotated key and for a tampered row alike, and neither is an error
    // worth logging on every poll.
    return null
  }
}

/**
 * Constant-time equality, exported for tests and for any future caller that
 * wants to compare an opened code without reintroducing `===` on a secret.
 *
 * Not used by `confirm/submit`, which still goes through bcrypt against
 * `codeHash` — see the header.
 */
export function codesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

function b64u(b: Buffer): string {
  return b.toString("base64url")
}

function unb64u(s: string): Buffer {
  return Buffer.from(s, "base64url")
}
