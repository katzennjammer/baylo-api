/**
 * Runs the automatic ID check on one submitted photo (29 Nov 2026).
 *
 * Joins @/lib/id-ocr (reads the photo) and @/lib/id-auto-check (decides).
 * Never throws: an engine failure or a slow read comes back as `ok: false`,
 * and the route sends that submission to an admin rather than guessing.
 *
 * On by default. ID_AUTO_CHECK=0 turns it off, which puts every submission
 * back in the admin queue as before (the switch-off if the check misbehaves).
 */

import { autoCheckId, type AutoCheckResult, type IdTypeDb } from "@/lib/id-auto-check"
import { measureSharpness, readIdText } from "@/lib/id-ocr"

/** The whole read must finish in this long; Vercel's function limit is set above it. */
const TIME_LIMIT_MS = 30_000

export function autoCheckEnabled(): boolean {
  return process.env.ID_AUTO_CHECK !== "0"
}

export async function runIdAutoCheck(
  image: Buffer,
  ctx: { selectedType: IdTypeDb; typedNumber: string; accountName: string; accountDob: Date | null },
): Promise<{ ok: true; result: AutoCheckResult; ms: number } | { ok: false; error: string }> {
  const t0 = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const work = Promise.all([measureSharpness(image), readIdText(image)])
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`ID check took longer than ${TIME_LIMIT_MS} ms`)), TIME_LIMIT_MS)
    })
    const [sharpness, ocr] = await Promise.race([work, timeout])
    const result = autoCheckId({
      text: ocr.text,
      ocrConfidence: ocr.confidence,
      sharpness,
      selectedType: ctx.selectedType,
      typedNumber: ctx.typedNumber,
      accountName: ctx.accountName,
      accountDob: ctx.accountDob,
    })
    return { ok: true, result, ms: Date.now() - t0 }
  } catch (err) {
    const error = err instanceof Error ? err.message : "unknown error"
    console.error("[id-auto-check] failed; the submission goes to an admin:", error)
    return { ok: false, error }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
