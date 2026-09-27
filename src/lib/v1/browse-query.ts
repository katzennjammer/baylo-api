import { z } from "zod"
import { BUSINESS_CATEGORIES } from "@/app/api/v1/organizations/route"
import { CATEGORY_VALUES, conditionSchema } from "@/lib/validation"
import { paginationShape } from "@/lib/v1/query"

/**
 * The query schema of GET /api/v1/browse, on its own.
 *
 * It lives here rather than in the route so that ONE schema defines what a
 * browse search is. The search assistant (POST /api/v1/assistant) turns a
 * conversation into browse filters and validates them with this exact object
 * before they reach a client: a filter the assistant can produce is, by
 * construction, a filter browse accepts, and a new browse filter is available
 * to it the moment it is added here.
 */

export const MAX_RADIUS_KM = 200

/** MySQL signed INT upper bound — the real ceiling on Item.valueLeaves. */
export const INT_MAX = 2147483647

/**
 * How many categories one request may name.
 *
 * Browsing two or three at once is the normal thing to want; browsing all
 * twenty is not a filter, it is the unfiltered feed with a longer URL. The cap
 * also bounds the `IN (...)` list, so a caller cannot hand the planner an
 * arbitrarily long disjunction.
 */
export const MAX_CATEGORIES = 5

/**
 * `category` accepts one value or a COMMA-SEPARATED list: `?category=BOOKS` and
 * `?category=BOOKS,GAMING` are both valid.
 *
 * COMMA-SEPARATED AND NOT A REPEATED PARAMETER, and that is forced rather than
 * chosen: parseQuery() rejects `?category=A&category=B` outright — a repeated
 * parameter is refused before zod ever sees it, because resolving one by a
 * first-or-last rule is a guess about what the caller meant. So the list has to
 * arrive inside a single value.
 *
 * Parsed with superRefine rather than a bare `.transform` so that a bad member
 * names ITSELF in the error. "Unknown category: BOOSK" is actionable;
 * "invalid category" sends a client author looking through all five.
 */
const categoryListSchema = z
  .string()
  .trim()
  .min(1)
  // 20 enum names plus separators cannot exceed this; a longer string is not a
  // category list and is refused before it is split.
  .max(400)
  .transform((raw) => [...new Set(raw.split(",").map((c) => c.trim()).filter(Boolean))])
  .superRefine((list, ctx) => {
    if (list.length === 0) {
      ctx.addIssue({ code: "custom", message: "category cannot be empty" })
      return
    }
    if (list.length > MAX_CATEGORIES) {
      ctx.addIssue({
        code: "custom",
        message: `at most ${MAX_CATEGORIES} categories (got ${list.length})`,
      })
    }
    for (const c of list) {
      if (!(CATEGORY_VALUES as readonly string[]).includes(c)) {
        ctx.addIssue({ code: "custom", message: `Unknown category: ${c}` })
      }
    }
  })
  .transform((list) => list as (typeof CATEGORY_VALUES)[number][])

export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number]

/**
 * `businessCategory`: the sub-filter under the Organizations pill, in the same
 * comma-separated shape as `category` and for the same reason. The values are
 * Organization.businessCategory -- a fact about the SHOP, not the item -- so a
 * sari-sari store's rice is found by Organizations + Sari-sari store, by Food,
 * and by both at once.
 */
const businessCategoryListSchema = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .transform((raw) => [...new Set(raw.split(",").map((c) => c.trim()).filter(Boolean))])
  .superRefine((list, ctx) => {
    if (list.length === 0) {
      ctx.addIssue({ code: "custom", message: "businessCategory cannot be empty" })
      return
    }
    for (const c of list) {
      if (!(BUSINESS_CATEGORIES as readonly string[]).includes(c)) {
        ctx.addIssue({ code: "custom", message: `Unknown businessCategory: ${c}` })
      }
    }
  })
  .transform((list) => list as BusinessCategory[])

/** A Leaf bound: a non-negative integer inside the column's range. */
const leafBound = z.coerce
  .number()
  .int("must be a whole number")
  .min(0, "cannot be negative")
  .max(INT_MAX)

export const browseQuerySchema = z
  .strictObject({
    ...paginationShape,
    category: categoryListSchema.optional(),
    condition: conditionSchema.optional(),
    minLeaves: leafBound.optional(),
    maxLeaves: leafBound.optional(),
    q: z.string().trim().min(1).max(100).optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radiusKm: z.coerce.number().positive().max(MAX_RADIUS_KM).optional(),
    sort: z.enum(["recent", "nearest"]).optional().default("recent"),
    /**
     * The "Organizations" pill: show only listings posted by an organisation.
     *
     * A BOOLEAN FILTER AND NOT A CATEGORY. It sits in the same pill row as the
     * category chips and looks like one, but it cannot be one -- `category` is
     * the item taxonomy and "organisation" is a fact about the POSTER. Folding
     * it into that list would mean a listing could be FOOD or it could be
     * Organizations, and a sari-sari store's rice would have to be one or the
     * other.
     *
     * So it composes rather than replaces: Organizations + Food is
     * organisations' food listings, which is the useful query and the one a
     * user picking both pills plainly means.
     */
    orgsOnly: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => v === "true"),
    businessCategory: businessCategoryListSchema.optional(),
    /**
     * Perishable listings only (`true`) or standard listings only (`false`);
     * absent means both. Item.isPerishable, a fact the POSTER sets -- food,
     * flowers, produce with a 6- or 24-hour trade window.
     *
     * NOT THE FOOD CATEGORY. Most FOOD is perishable, but a jar of honey is FOOD
     * and standard, and a bouquet is perishable and PLANTS. The two compose the
     * way orgsOnly and `category` do: perishable + FOOD is fresh food.
     *
     * Tri-state on purpose: `false` is a real filter ("nothing that expires
     * tonight"), not the same as leaving it off.
     */
    perishable: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === "true")),
  })
  .refine((v) => v.sort !== "nearest" || (v.lat !== undefined && v.lng !== undefined), {
    message: "sort=nearest requires lat and lng",
  })
  .refine((v) => v.radiusKm === undefined || (v.lat !== undefined && v.lng !== undefined), {
    message: "radiusKm requires lat and lng",
  })
  // A business category is a kind of SHOP, so it only means something with the
  // Organizations pill on. Refused rather than implying the pill: a client that
  // sends one without the other has lost track of its own filter state, and a
  // grid that quietly turned org-only would hide that.
  .refine((v) => v.businessCategory === undefined || v.orgsOnly, {
    message: "businessCategory requires orgsOnly=true",
  })
  // An inverted range returns nothing, silently and forever. Refusing it says
  // so once instead of leaving a client to wonder why the list is empty.
  .refine(
    (v) => v.minLeaves === undefined || v.maxLeaves === undefined || v.minLeaves <= v.maxLeaves,
    { message: "minLeaves cannot be greater than maxLeaves" },
  )

export type BrowseQuery = z.output<typeof browseQuerySchema>
