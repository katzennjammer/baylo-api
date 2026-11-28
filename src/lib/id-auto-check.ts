/**
 * The automatic ID check: the RULES (28 Nov 2026). Pure, no I/O.
 *
 * The panel asked that ID validation be automatic instead of approved by an
 * admin. @/lib/id-ocr reads the photo with an open-source OCR model
 * (Tesseract, run on our own server; no paid API, nothing leaves Baylo) and
 * measures how sharp it is; this module decides from what was read.
 *
 * ── WHAT IS CHECKED ─────────────────────────────────────────────────────────
 *
 *   1  readable     enough text and a sharp enough photo (else: retake)
 *   2  document     the words printed on the selected ID type are there
 *                   ("LAND TRANSPORTATION OFFICE", "PHILHEALTH", …); another
 *                   type's words → wrong type; no government words at all →
 *                   not a government ID
 *   3  number       the number the user typed appears on the card, allowing
 *                   for OCR's usual confusions (O/0, I/1, S/5, B/8) and one
 *                   misread character on long numbers
 *   4  name         every part of the account name is on the card
 *   5  age          the date of birth on the card makes the holder 18+
 *                   (recorded whether it equals the account's)
 *   6  expiry       a licence, passport or postal ID is not past its date
 *
 * Each check is "pass", "fail" or "unknown" (could not be read). The decision:
 *   - every check passes → APPROVED
 *   - a check fails on a well-read photo → REJECTED with that reason
 *   - only unknowns → REJECTED as "retake" (blurry / unreadable)
 * The route turns a non-approval on the user's LAST attempt into PENDING for
 * an admin instead (the agreed last resort), so a misread can never lock a
 * real person out.
 *
 * Only the outcome of each check is stored (IdVerification.autoChecks), never
 * the text read from the card.
 */

export type IdTypeDb = "NATIONAL_ID" | "DRIVERS_LICENCE" | "PASSPORT" | "UMID" | "PHILHEALTH" | "POSTAL_ID" | "VOTERS_ID"
export type AutoReason =
  | "BLURRY_PHOTO"
  | "NAME_MISMATCH"
  | "EXPIRED_ID"
  | "WRONG_DOCUMENT_TYPE"
  | "NOT_GOVERNMENT_ID"
  | "NUMBER_MISMATCH"
  | "UNDERAGE"
export type CheckResult = "pass" | "fail" | "unknown"

export interface AutoCheckInput {
  text: string
  /** Tesseract's mean word confidence, 0..100. */
  ocrConfidence: number
  /** Laplacian variance of the photo (higher = sharper). See @/lib/id-ocr. */
  sharpness: number
  selectedType: IdTypeDb
  typedNumber: string
  accountName: string
  accountDob: Date | null
  today?: Date
}

export interface AutoCheckResult {
  decision: "APPROVED" | "REJECTED"
  reason: AutoReason | null
  /** 0..1, how sure the system is of `decision`. */
  confidence: number
  checks: {
    readable: CheckResult
    document: CheckResult
    number: CheckResult
    name: CheckResult
    age: CheckResult
    expiry: CheckResult | "n/a"
  }
  detail: {
    sharpness: number
    ocrConfidence: number
    textChars: number
    selectedTypeScore: number
    bestOtherType: IdTypeDb | null
    bestOtherTypeScore: number
    governmentScore: number
    numberEdits: number | null
    nameMatched: string
    dobFound: boolean
    dobMatchesAccount: boolean | null
    ageYears: number | null
    expiryFound: boolean
  }
}

// ── Thresholds (tuned on synthetic IDs; see scripts/eval-id-auto-check.ts) ──

/** Below this Laplacian variance the photo is treated as blurry. */
export const MIN_SHARPNESS = 25
/** Fewer alphanumeric characters read than this = unreadable. */
export const MIN_TEXT_CHARS = 25
/** Fuzzy phrase match counted as "present". */
export const PHRASE_PRESENT = 0.8
/** A name part counts as matched at this similarity. */
export const NAME_TOKEN_MATCH = 0.8

/** Words printed on each ID type. Any one phrase present identifies it. */
export const TYPE_PHRASES: Record<IdTypeDb, string[]> = {
  NATIONAL_ID: ["PAMBANSANG PAGKAKAKILANLAN", "PHILIPPINE IDENTIFICATION", "PHILSYS"],
  DRIVERS_LICENCE: ["LAND TRANSPORTATION OFFICE", "DRIVERS LICENSE", "DRIVER S LICENSE", "NON PROFESSIONAL", "PROFESSIONAL DRIVER"],
  PASSPORT: ["PASAPORTE", "PASSPORT", "P PHL"],
  UMID: ["UNIFIED MULTI PURPOSE", "UMID"],
  PHILHEALTH: ["PHILHEALTH", "PHILIPPINE HEALTH INSURANCE"],
  POSTAL_ID: ["POSTAL IDENTITY CARD", "PHILIPPINE POSTAL", "PHLPOST"],
  VOTERS_ID: ["COMMISSION ON ELECTIONS", "COMELEC", "VOTER S IDENTIFICATION", "VOTERS IDENTIFICATION"],
}
const GOVERNMENT_PHRASES = ["REPUBLIC OF THE PHILIPPINES", "REPUBLIKA NG PILIPINAS"]
export const HAS_EXPIRY: ReadonlySet<IdTypeDb> = new Set(["DRIVERS_LICENCE", "PASSPORT", "POSTAL_ID"])

// ── Text helpers ─────────────────────────────────────────────────────────────

/** Uppercase letters/digits and single spaces; punctuation becomes a space. */
export function cleanText(s: string): string {
  return s.toUpperCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Z0-9]+/g, " ").trim()
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (!m) return n
  if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

export function similarity(a: string, b: string): number {
  const L = Math.max(a.length, b.length)
  return L === 0 ? 1 : 1 - levenshtein(a, b) / L
}

/**
 * Best similarity of `phrase` to any run of the same number of words in
 * `text` (both cleaned). Word runs ±1 word long are tried too, because OCR
 * splits and joins words.
 */
export function phraseScore(text: string, phrase: string): number {
  const words = text.split(" ").filter(Boolean)
  const p = cleanText(phrase)
  const k = p.split(" ").length
  let best = 0
  for (const len of [k - 1, k, k + 1]) {
    if (len < 1) continue
    for (let i = 0; i + len <= words.length; i++) {
      const s = similarity(words.slice(i, i + len).join(" "), p)
      if (s > best) best = s
      if (best === 1) return 1
    }
  }
  // Joined form: "LANDTRANSPORTATIONOFFICE" when OCR drops the spaces.
  const joined = p.replace(/ /g, "")
  if (joined.length >= 6) {
    const flat = words.join("")
    if (flat.includes(joined)) return 1
  }
  return best
}

/** Shape key: characters OCR confuses map to one symbol, so "C8O" ≈ "CBO". */
const SHAPE: Record<string, string> = { O: "0", Q: "0", D: "0", I: "1", L: "1", T: "1", S: "5", B: "8", Z: "2", G: "6" }
export const shapeKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/[A-Z]/g, (c) => SHAPE[c] ?? c)

/**
 * Fewest edits needed to find `needle` anywhere inside `hay` (approximate
 * substring match, Sellers' algorithm).
 */
export function substringEdits(needle: string, hay: string): number {
  const m = needle.length
  if (!m) return 0
  let prev = Array.from({ length: m + 1 }, (_, i) => i)
  let best = prev[m]
  for (let j = 1; j <= hay.length; j++) {
    const cur = [0]
    for (let i = 1; i <= m; i++) {
      cur[i] = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + (needle[i - 1] === hay[j - 1] ? 0 : 1))
    }
    if (cur[m] < best) best = cur[m]
    prev = cur
  }
  return best
}

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12,
  JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, JUNE: 6, JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
}

export interface FoundDate { date: Date; index: number }

/** Dates in the raw OCR text: 1990/01/31, 1990-01-31, 01/31/1990, JANUARY 31, 1990, 31 JAN 1990. */
export function findDates(raw: string): FoundDate[] {
  const t = raw.toUpperCase().replace(/[Oo](?=\d)|(?<=\d)[Oo]/g, "0")
  const out: FoundDate[] = []
  const push = (y: number, m: number, d: number, index: number) => {
    if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return
    const date = new Date(Date.UTC(y, m - 1, d))
    if (date.getUTCMonth() !== m - 1) return
    out.push({ date, index })
  }
  for (const r of t.matchAll(/\b(\d{4})\s?[/.-]\s?(\d{1,2})\s?[/.-]\s?(\d{1,2})\b/g)) push(+r[1], +r[2], +r[3], r.index ?? 0)
  for (const r of t.matchAll(/\b(\d{1,2})\s?[/.-]\s?(\d{1,2})\s?[/.-]\s?(\d{4})\b/g)) push(+r[3], +r[1], +r[2], r.index ?? 0)
  for (const r of t.matchAll(/\b([A-Z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/g)) if (MONTHS[r[1]]) push(+r[3], MONTHS[r[1]], +r[2], r.index ?? 0)
  for (const r of t.matchAll(/\b(\d{1,2})\s*([A-Z]{3,9})\.?,?\s*(\d{4})\b/g)) if (MONTHS[r[2]]) push(+r[3], MONTHS[r[2]], +r[1], r.index ?? 0)
  // OCR often reads a slash as 1, 4, 7 or |: "12/24/2027" -> "1212412027".
  // Tried only when no separator survived and the result is a real date.
  for (const r of t.matchAll(/\b(\d{2})[147|I](\d{2})[147|I](\d{4})\b/g)) push(+r[3], +r[1], +r[2], r.index ?? 0)
  for (const r of t.matchAll(/\b(\d{4})[147|I](\d{2})[147|I](\d{2})\b/g)) push(+r[1], +r[2], +r[3], r.index ?? 0)
  return out
}

const sameDay = (a: Date, b: Date) =>
  a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate()

function yearsBetween(from: Date, to: Date): number {
  let y = to.getUTCFullYear() - from.getUTCFullYear()
  if (to.getUTCMonth() < from.getUTCMonth() || (to.getUTCMonth() === from.getUTCMonth() && to.getUTCDate() < from.getUTCDate())) y--
  return y
}

/** The label nearest BEFORE `index` decides what a date is. */
function labelBefore(raw: string, index: number): "birth" | "expiry" | "other" {
  const before = raw.slice(Math.max(0, index - 80), index).toUpperCase()
  const b = Math.max(before.lastIndexOf("BIRTH"), before.lastIndexOf("KAPANGANAKAN"), before.lastIndexOf("DOB"))
  const e = Math.max(before.lastIndexOf("EXPIR"), before.lastIndexOf("VALID"), before.lastIndexOf("UNTIL"))
  if (b < 0 && e < 0) return "other"
  return b > e ? "birth" : "expiry"
}

/** True when the card's name labels were read, i.e. the name area was not lost by OCR. */
function nameAreaRead(text: string): boolean {
  return ["LAST NAME", "GIVEN NAMES", "APELYIDO", "PANGALAN", "SURNAME"].some((p) => phraseScore(text, p) >= PHRASE_PRESENT)
}

// ── The decision ─────────────────────────────────────────────────────────────

export function autoCheckId(input: AutoCheckInput): AutoCheckResult {
  const today = input.today ?? new Date()
  const text = cleanText(input.text)
  const textChars = text.replace(/ /g, "").length

  // 1 readable
  const blurry = input.sharpness < MIN_SHARPNESS
  const readable: CheckResult = !blurry && textChars >= MIN_TEXT_CHARS ? "pass" : "fail"

  // 2 document type
  const typeScore = (t: IdTypeDb) => Math.max(...TYPE_PHRASES[t].map((p) => phraseScore(text, p)))
  const selectedTypeScore = typeScore(input.selectedType)
  let bestOtherType: IdTypeDb | null = null
  let bestOtherTypeScore = 0
  for (const t of Object.keys(TYPE_PHRASES) as IdTypeDb[]) {
    if (t === input.selectedType) continue
    const s = typeScore(t)
    if (s > bestOtherTypeScore) { bestOtherTypeScore = s; bestOtherType = t }
  }
  const governmentScore = Math.max(...GOVERNMENT_PHRASES.map((p) => phraseScore(text, p)))
  let document: CheckResult = "unknown"
  if (selectedTypeScore >= PHRASE_PRESENT) document = "pass"
  else if (bestOtherTypeScore >= 0.85 || (readable === "pass" && governmentScore < 0.6 && bestOtherTypeScore < 0.6)) document = "fail"

  // 3 number
  const typedKey = shapeKey(input.typedNumber)
  const hayKey = shapeKey(input.text)
  const numberEdits = typedKey.length ? substringEdits(typedKey, hayKey) : null
  const allowed = typedKey.length >= 10 ? 1 : 0
  let number: CheckResult = "unknown"
  if (numberEdits !== null && numberEdits <= allowed) number = "pass"
  else if (readable === "pass" && document === "pass" && input.ocrConfidence >= 60) number = "fail"

  // 4 name
  const words = text.split(" ").filter((w) => w.length >= 2)
  const parts = cleanText(input.accountName).split(" ").filter((w) => w.length >= 2)
  const matched = parts.filter((p) => words.some((w) => similarity(w, p) >= NAME_TOKEN_MATCH))
  // All parts found = pass. NONE found on a well-read card = a different
  // person. Some found = unknown: OCR often drops a short name ("LIM", "TAN"),
  // so that is a retake, not a refusal.
  let name: CheckResult = "unknown"
  if (parts.length && matched.length === parts.length) name = "pass"
  else if (matched.length === 0 && readable === "pass" && document === "pass" && nameAreaRead(text)) name = "fail"

  // 5 + 6 dates
  const dates = findDates(input.text)
  const births = dates.filter((d) => labelBefore(input.text, d.index) === "birth")
  const expiries = dates.filter((d) => labelBefore(input.text, d.index) === "expiry")
  const plausibleBirth = (d: Date) => d < today && yearsBetween(d, today) <= 110
  const dob = (births.find((d) => plausibleBirth(d.date)) ?? dates.filter((d) => plausibleBirth(d.date)).sort((a, b) => +a.date - +b.date)[0])?.date ?? null
  const dobMatchesAccount = dob && input.accountDob ? sameDay(dob, input.accountDob) || dates.some((d) => sameDay(d.date, input.accountDob as Date)) : null
  const ageYears = dob ? yearsBetween(dob, today) : null
  let age: CheckResult = "unknown"
  if (ageYears !== null) age = ageYears >= 18 ? "pass" : "fail"
  if (age === "unknown" && input.accountDob && dates.some((d) => sameDay(d.date, input.accountDob as Date))) {
    age = yearsBetween(input.accountDob, today) >= 18 ? "pass" : "fail"
  }

  let expiry: CheckResult | "n/a" = "n/a"
  let expiryFound = false
  if (HAS_EXPIRY.has(input.selectedType)) {
    const exp = expiries[0]?.date ?? dates.filter((d) => !dob || +d.date > +dob + 10 * 365.25 * 864e5).sort((a, b) => +b.date - +a.date)[0]?.date
    expiryFound = !!exp
    expiry = exp ? (exp >= today ? "pass" : "fail") : "unknown"
  }

  const checks = { readable, document, number, name, age, expiry }
  const detail = {
    sharpness: Math.round(input.sharpness),
    ocrConfidence: Math.round(input.ocrConfidence),
    textChars,
    selectedTypeScore: Math.round(selectedTypeScore * 100) / 100,
    bestOtherType,
    bestOtherTypeScore: Math.round(bestOtherTypeScore * 100) / 100,
    governmentScore: Math.round(governmentScore * 100) / 100,
    numberEdits,
    nameMatched: `${matched.length}/${parts.length}`,
    dobFound: !!dob,
    dobMatchesAccount,
    ageYears,
    expiryFound,
  }

  const reject = (reason: AutoReason, confidence: number): AutoCheckResult => ({ decision: "REJECTED", reason, confidence, checks, detail })

  // Order: the most fundamental problem is the one the user is told about.
  if (blurry) return reject("BLURRY_PHOTO", 0.9)
  if (readable === "fail") return reject("BLURRY_PHOTO", 0.6)
  if (document === "fail") {
    if (bestOtherTypeScore >= 0.85) return reject("WRONG_DOCUMENT_TYPE", 0.85)
    return reject("NOT_GOVERNMENT_ID", 0.75)
  }
  if (document === "unknown") return reject("BLURRY_PHOTO", 0.5)
  if (age === "fail") return reject("UNDERAGE", 0.85)
  if (expiry === "fail") return reject("EXPIRED_ID", 0.85)
  if (number === "fail") return reject("NUMBER_MISMATCH", 0.8)
  if (name === "fail") return reject("NAME_MISMATCH", 0.8)
  // Approval needs every check read and passed, including the birth date:
  // an ID whose date of birth could not be read is not approved on the
  // strength of the date typed at sign-up.
  if (number !== "pass" || name !== "pass" || age !== "pass" || expiry === "unknown") return reject("BLURRY_PHOTO", 0.5)

  // Approved. Confidence rises with how clean the read was.
  const conf = Math.min(0.99, 0.75 + (input.ocrConfidence / 100) * 0.15 + (numberEdits === 0 ? 0.05 : 0) + (dobMatchesAccount ? 0.04 : 0))
  return { decision: "APPROVED", reason: null, confidence: Math.round(conf * 100) / 100, checks, detail }
}
