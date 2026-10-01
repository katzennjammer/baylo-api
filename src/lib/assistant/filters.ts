import { z } from "zod"
import { BUSINESS_CATEGORIES } from "@/app/api/v1/organizations/route"
import { BRACKET_COUNT, bracketRange } from "@/lib/brackets"
import { CATEGORY_VALUES, CONDITION_VALUES } from "@/lib/validation"
import { MAX_CATEGORIES, browseQuerySchema } from "@/lib/v1/browse-query"

/**
 * The search assistant's filters, and the one door they leave through.
 *
 * The model answers in THIS vocabulary -- brackets, not Leaves -- and
 * toBrowseSearch() is the only way its answer becomes something a client can
 * send to GET /api/v1/browse. Everything the assistant is allowed to do is
 * therefore visible in two places: the schema below and the function under it.
 *
 * ── BRACKETS ONLY, NEVER LEAVES ─────────────────────────────────────────────
 *
 * There is no Leaves field for the model to fill. "Under 50 Leaves" arrives as
 * maxBracket 1 and leaves as the bracket's own ceiling (100), which is the rule
 * the phone's FilterSheet follows and for the same reason: a range that could
 * land on any number lets someone narrow it until a listing drops out and read
 * that listing's exact value off the edge. A model told firmly not to emit a
 * figure is a request; a schema with nowhere to put one is a guarantee.
 *
 * ── NO BOUNDS IN THE MODEL SCHEMA, CLAMPS HERE ──────────────────────────────
 *
 * Structured outputs cannot express `minimum`/`maximum` (the SDK strips them
 * and re-checks client-side, which turns a model saying "bracket 11" into a
 * parse failure and a dead turn). So the schema only fixes the SHAPE, and
 * every number and list is clamped below. A bad bracket costs a clamp, not a
 * conversation.
 */

export const ASSISTANT_ACTIONS = ["search", "clarify", "decline"] as const

/** What the model fills in, and what the client echoes back on the next turn. */
export const assistantFiltersSchema = z.strictObject({
  categories: z.array(z.enum(CATEGORY_VALUES)),
  q: z.string().nullable(),
  minBracket: z.number().int().nullable(),
  maxBracket: z.number().int().nullable(),
  condition: z.enum(CONDITION_VALUES).nullable(),
  orgsOnly: z.boolean(),
  businessCategories: z.array(z.enum(BUSINESS_CATEGORIES)),
  perishable: z.boolean().nullable(),
  sort: z.enum(["recent", "nearest"]),
})

export type AssistantFilters = z.infer<typeof assistantFiltersSchema>

/** The model's whole answer. `output_config.format` is built from this. */
export const assistantOutputSchema = z.strictObject({
  action: z.enum(ASSISTANT_ACTIONS),
  reply: z.string(),
  filters: assistantFiltersSchema,
})

export type AssistantOutput = z.infer<typeof assistantOutputSchema>

/** The empty filter set: the unfiltered feed. */
export const NO_FILTERS: AssistantFilters = {
  categories: [],
  q: null,
  minBracket: null,
  maxBracket: null,
  condition: null,
  orgsOnly: false,
  businessCategories: [],
  perishable: null,
  sort: "recent",
}

/**
 * The browse filters, in the field names the phone's `BrowseFilters` already
 * uses, with Leaf bounds already derived from brackets.
 */
export interface BrowseSearch {
  categories: string[]
  q: string | null
  condition: string | null
  minLeaves: number | null
  maxLeaves: number | null
  orgsOnly: boolean
  businessCategories: string[]
  perishable: boolean | null
  sort: "recent" | "nearest"
}

/** `q` is a substring match; see normaliseQ(). */
const MAX_Q_WORDS = 2
const MAX_Q_CHARS = 40

/**
 * `q` as browse can actually use it.
 *
 * Browse matches `q` as ONE case-insensitive substring of the title, the
 * description or a shop's name. "red mountain bike for my kid" is not a
 * substring of anything, so a sentence in `q` is an empty grid that looks like
 * "there are no bikes". The prompt says so; this makes sure of it -- at most
 * two words, letters and digits only.
 */
export function normaliseQ(raw: string | null): string | null {
  if (raw == null) return null
  const words = raw
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_Q_WORDS)
  const q = words.join(" ").slice(0, MAX_Q_CHARS).trim()
  return q === "" ? null : q
}

function clampBracket(n: number | null): number | null {
  if (n == null || !Number.isFinite(n)) return null
  return Math.min(Math.max(Math.round(n), 1), BRACKET_COUNT)
}

/**
 * The model's filters, made safe and consistent. Pure; runs on every turn,
 * including the ones that do not search, so the state the client echoes back
 * next turn is always a normalised one.
 */
export function normaliseFilters(raw: AssistantFilters, ctx: { hasLocation: boolean }): AssistantFilters {
  let minBracket = clampBracket(raw.minBracket)
  let maxBracket = clampBracket(raw.maxBracket)
  if (minBracket != null && maxBracket != null && minBracket > maxBracket) {
    ;[minBracket, maxBracket] = [maxBracket, minBracket]
  }
  // "At least bracket 1" and "at most bracket 10" bound nothing, and a bound
  // that bounds nothing still EXCLUDES unvalued listings server-side. Drop them.
  if (minBracket === 1) minBracket = null
  if (maxBracket === BRACKET_COUNT) maxBracket = null

  const businessCategories = [...new Set(raw.businessCategories)]
  return {
    categories: [...new Set(raw.categories)].slice(0, MAX_CATEGORIES),
    q: normaliseQ(raw.q),
    minBracket,
    maxBracket,
    condition: raw.condition,
    // A shop type is a kind of SHOP. Browse refuses businessCategory without
    // orgsOnly, and "something from a sari-sari store" plainly means shops.
    orgsOnly: raw.orgsOnly || businessCategories.length > 0,
    businessCategories,
    perishable: raw.perishable,
    // Nearest needs coordinates the phone may not have. Without them, recent,
    // rather than a request browse would 400.
    sort: raw.sort === "nearest" && ctx.hasLocation ? "nearest" : "recent",
  }
}

export type BrowseSearchResult =
  | { ok: true; filters: AssistantFilters; browse: BrowseSearch }
  | { ok: false; reason: string }

/**
 * The model's filters as a browse search, VALIDATED BY BROWSE'S OWN SCHEMA.
 *
 * The query string is built exactly as a client would build it and run through
 * browseQuerySchema -- the object GET /api/v1/browse parses with. Anything that
 * passes here is a request browse accepts; anything browse would refuse is
 * refused here first, and the turn fails as "assistant unavailable" rather
 * than handing the phone a search that 400s.
 */
export function toBrowseSearch(raw: AssistantFilters, ctx: { hasLocation: boolean }): BrowseSearchResult {
  const filters = normaliseFilters(raw, ctx)

  const browse: BrowseSearch = {
    categories: filters.categories,
    q: filters.q,
    condition: filters.condition,
    minLeaves: filters.minBracket != null ? bracketRange(filters.minBracket).min : null,
    maxLeaves: filters.maxBracket != null ? bracketRange(filters.maxBracket).max : null,
    orgsOnly: filters.orgsOnly,
    businessCategories: filters.orgsOnly ? filters.businessCategories : [],
    perishable: filters.perishable,
    sort: filters.sort,
  }

  const params: Record<string, string> = {}
  if (browse.categories.length > 0) params.category = browse.categories.join(",")
  if (browse.q) params.q = browse.q
  if (browse.condition) params.condition = browse.condition
  if (browse.minLeaves != null) params.minLeaves = String(browse.minLeaves)
  if (browse.maxLeaves != null) params.maxLeaves = String(browse.maxLeaves)
  if (browse.orgsOnly) params.orgsOnly = "true"
  if (browse.businessCategories.length > 0) params.businessCategory = browse.businessCategories.join(",")
  if (browse.perishable != null) params.perishable = String(browse.perishable)
  params.sort = browse.sort
  // The phone attaches its own coordinates to a nearest search; the server
  // never sees them here. A stand-in pair satisfies the schema's "nearest needs
  // lat/lng" rule so the rest of the query is still checked.
  if (browse.sort === "nearest") {
    params.lat = "0"
    params.lng = "0"
  }

  const checked = browseQuerySchema.safeParse(params)
  if (!checked.success) {
    const issue = checked.error.issues[0]
    return { ok: false, reason: `${issue?.path.join(".") || "(query)"}: ${issue?.message ?? "invalid"}` }
  }
  return { ok: true, filters, browse }
}
