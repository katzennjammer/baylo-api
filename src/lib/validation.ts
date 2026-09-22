import { z } from "zod"
import { NextResponse } from "next/server"
import { MAX_ITEM_HUBS } from "@/lib/safe-zones"
import { MAX_AGE, MIN_AGE, isAdult, parseDateOfBirth } from "@/lib/age"

/**
 * Request body schemas.
 *
 * Before this, every route destructured `await req.json()` directly, so the
 * shape a handler assumed and the shape it could actually receive were unrelated
 * — `valueLeaves: -5000` stored a negative price, `offeredLeaves: -1000000`
 * inflated a balance, and a numeric `password` reached `.length` and threw a 500.
 * The rule now is that a handler never sees an unparsed body.
 *
 * Two conventions worth keeping:
 *   - Bounds are inclusive of what the DB can hold. `valueLeaves` is an INT
 *     column, so the schema stops at INT_MAX rather than letting Prisma throw
 *     and the catch-all turn it into a 500.
 *   - Text columns get explicit length caps. `@db.Text` is 64 KB and every
 *     comment/message route was previously unbounded.
 */

/** MySQL signed INT upper bound — the real ceiling on any Int column. */
const INT_MAX = 2147483647

const MAX_TITLE = 200
const MAX_DESCRIPTION = 5000
const MAX_MESSAGE = 5000
const MAX_COMMENT = 2000
const MAX_WANTED = 500
const MAX_ADDRESS = 500
const MAX_NAME = 100
const MAX_BIO = 1000
const MAX_LOCATION = 200
const MAX_URL = 2048
/**
 * How many categories a listing may say it is looking for.
 *
 * Six of twenty. A cap rather than a formality: this list is what the
 * event-triggered matcher reads, and an owner who selects all twenty has
 * subscribed to a notification for every listing posted on Baylo. Small enough
 * that "looking for" stays a preference, large enough for a real answer.
 */
const MAX_LOOKING_FOR = 6

export const CATEGORY_VALUES = [
  "ELECTRONICS", "CLOTHING", "BAGS", "BEAUTY", "ACCESSORIES", "FURNITURE",
  "BOOKS", "GAMING", "SPORTS", "BIKES", "TOYS", "TOOLS", "MUSIC", "ART",
  "COLLECTIBLES", "PETS", "PLANTS", "FOOD", "SERVICES", "OTHER",
] as const

export const CONDITION_VALUES = ["NEW", "LIKE_NEW", "GOOD", "FAIR", "POOR"] as const

/**
 * The enums, checked rather than cast. Both were previously passed to Prisma
 * behind an `as never`, which silences the compiler without checking anything —
 * an invalid value reached the database driver.
 */
export const categorySchema = z.enum(CATEGORY_VALUES)
export const conditionSchema = z.enum(CONDITION_VALUES)

/**
 * A Leaf amount: a non-negative integer inside the INT column's range, with 0
 * normalised to null.
 *
 * Negative is the value that mattered — it skipped the `> 0` balance guard on
 * offers and then INFLATED availableLeaves, because that function subtracts the
 * sum of pending offers from the balance. Above INT_MAX, Prisma threw and the
 * catch-all turned it into a 500. Both are now rejected at the boundary.
 *
 * 0 is accepted and mapped to null rather than refused, because that is what
 * the shipped clients already send for "no value": the post wizard initialises
 * `valueLeaves` to 0, and the old `valueLeaves ? ... : null` silently did this
 * same coercion. Refusing 0 would 400 every listing posted without a value from
 * a client that cannot be updated in this change. Callers meaning "no amount"
 * may send either null or 0; a real amount is >= 1.
 */
export const leafAmountSchema = z
  .number()
  .int()
  .min(0, "Leaf amounts cannot be negative")
  .max(INT_MAX)
  .transform((v) => (v === 0 ? null : v))

/** Latitude/longitude, range-checked. */
const latSchema = z.number().min(-90).max(90)
const lngSchema = z.number().min(-180).max(180)

/** Trimmed, non-empty after trimming, length-capped. */
const text = (max: number) => z.string().trim().min(1).max(max)
const optionalText = (max: number) =>
  z.string().trim().max(max).nullish().transform((v) => (v ? v : null))

// ── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Passwords: 8 characters, and a string.
 *
 * The type check is not pedantry — `register` called `password.length` on an
 * unvalidated value, so `{"password": 12345678}` threw and became a 500.
 */
export const passwordSchema = z.string().min(8, "Password must be at least 8 characters").max(200)

/**
 * Email, normalised the same way on every path that accepts one.
 *
 * `register` stored whatever it was sent while `/api/auth/token` and the Google
 * exchange both lowercased before lookup, so an account created as `Bob@x.com`
 * could never log in on the native client.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(320)
  .pipe(z.email("Enter a valid email address"))

/**
 * Date of birth, as a bare calendar date.
 *
 * TWO SEPARATE REFUSALS, and they are separate on purpose. The shape check
 * ("that is not a real past date") is a validation error and belongs in
 * `issues` against the field. The AGE check is not a validation error — it is a
 * decision about the account — and it is deliberately NOT done here, because a
 * 400 with `issues[0].message` is the wrong answer to "you are sixteen": the
 * clients answer that with a whole screen, and they need a stable `code` to
 * branch on rather than a message that may be reworded. The routes do the age
 * check and answer UNDER_18; see /api/auth/register.
 *
 * The format is `YYYY-MM-DD` and nothing else. `@/lib/age` explains why a
 * timestamp is not accepted, and it is the only place the calendar arithmetic
 * lives.
 */
export const dateOfBirthSchema = z
  .string()
  .trim()
  .max(10, "Use the format YYYY-MM-DD")
  .refine(
    (value) => parseDateOfBirth(value) !== null,
    `Enter a real date of birth as YYYY-MM-DD, no earlier than ${MAX_AGE} years ago`,
  )

export const registerSchema = z.object({
  name: text(MAX_NAME),
  email: emailSchema,
  password: passwordSchema,
  dateOfBirth: dateOfBirthSchema,
})

/** POST /api/auth/date-of-birth — the Google flow's second step. */
export const dateOfBirthBodySchema = z.object({ dateOfBirth: dateOfBirthSchema })

/**
 * The one answer both routes give to an under-age date.
 *
 * A named helper rather than two copies, because the shape is what the clients
 * branch on: `code === "UNDER_18"` is what puts the rejection screen on the
 * phone, and a route that answered 400 with a different code would silently
 * degrade to a red line under a field. 403 rather than 400 — the request is
 * well formed and the answer is still no.
 */
export function underAgeResponse(): NextResponse {
  return NextResponse.json(
    {
      error: `You must be ${MIN_AGE} or older to use Baylo`,
      code: "UNDER_18",
    },
    { status: 403 },
  )
}

/** True when a validated `YYYY-MM-DD` clears the age gate. */
export function clearsAgeGate(dateOfBirth: string): boolean {
  const parts = parseDateOfBirth(dateOfBirth)
  return parts !== null && isAdult(parts)
}

export const forgotPasswordSchema = z.object({ email: emailSchema })

export const resetPasswordSchema = z.object({
  token: z.string().min(1).max(200),
  password: passwordSchema,
})

/**
 * The email verification token.
 *
 * Used for both transports: the `?token=` query param on the GET link and the
 * JSON body the native client POSTs. One schema so the two cannot drift.
 *
 * 32 CSPRNG bytes hex-encode to 64 characters; the bound is deliberately
 * generous rather than exact, so changing the encoding later does not 400 every
 * shipped client at once. Nothing downstream trusts the shape anyway — the
 * value is hashed and looked up by unique index, so a wrong one is simply a
 * miss.
 */
export const verifyEmailSchema = z.object({
  token: z.string().trim().min(1).max(200),
})

// ── Items ────────────────────────────────────────────────────────────────────

const itemPickupFields = {
  localPickup: z.boolean().optional(),
  pickupLat: latSchema.nullish(),
  pickupLng: lngSchema.nullish(),
  pickupAddress: z.string().trim().max(MAX_ADDRESS).nullish(),
}

/**
 * The Safe-Zone hubs this listing is offered at.
 *
 * SHAPE ONLY. This schema bounds the array and the length of an id; it does NOT
 * establish that any of these hubs exist or are open, because zod cannot ask
 * the database. resolveHubIds() in @/lib/safe-zones is the authority on both,
 * and every write path calls it — a hub id is a foreign key the client chooses,
 * and an unchecked one either breaks on the constraint or leaves a listing
 * claiming a meeting place that does not exist.
 *
 * OMITTED AND `[]` MEAN DIFFERENT THINGS ON THE UPDATE PATH, and the routes
 * depend on it: omitted leaves the existing associations alone, `[]` clears
 * them. Same convention as `localPickup`.
 *
 * The cap is bounded here as well as in resolveHubIds() — both read
 * MAX_ITEM_HUBS, so they cannot drift — because rejecting an over-long array
 * before it reaches a query is cheaper than after.
 */
const itemHubField = {
  hubIds: z
    .array(z.string().trim().min(1).max(64))
    .max(MAX_ITEM_HUBS, `A listing can be offered at at most ${MAX_ITEM_HUBS} Safe-Zone hubs`)
    .optional(),
}

/**
 * ONE HASH PER PHOTO, ALIGNED WITH `images` BY INDEX.
 *
 * Nullable entries are load-bearing and are not a slack schema: the phash route
 * answers `{ hash: null, status: "passed" }` when it could not fetch or decode
 * an image, so a photo can legitimately reach here with no hash beside a photo
 * that has one. Dropping the nulls client-side would slide every later hash one
 * position to the left and attach it to the wrong image.
 *
 * `imageHash` beside it is the lead photo's, still accepted and still written,
 * because the web listing wizard sends only that. See the note in the schema.
 */
const imageHashesField = z
  .array(z.string().trim().max(128).nullable())
  .max(10)
  .optional()

/**
 * The categories the owner will take in return. NOT PERISHABLE-ONLY.
 *
 * Bounded at MAX_LOOKING_FOR because it is the matcher's input and an
 * unbounded list is a subscription to the whole marketplace — every category
 * selected is every new listing notifying this owner. The cap is what keeps
 * "looking for" a preference rather than a firehose.
 *
 * Omitted and `[]` are the same thing here, unlike `hubIds`: there is no
 * association to leave alone, and Postgres cannot store a null array anyway.
 */
const itemLookingForField = {
  lookingForCategories: z
    .array(categorySchema)
    .max(MAX_LOOKING_FOR, `Pick at most ${MAX_LOOKING_FOR} categories to look for`)
    .optional(),
}

/**
 * The perishable block, validated as a UNIT rather than as four loose fields.
 *
 * The refinements below are the difference between a schema that describes the
 * shape and one that describes the feature. A bare "2" with no unit is not a
 * quantity; a `tradeWithinHours` on a standard item is a window nothing will
 * ever close, and the expiry sweep selects on `isPerishable` so that row would
 * simply never expire while looking like it should. Both are refused here
 * rather than silently dropped, because a client sending them believes
 * something that is not true.
 */
const itemPerishableFields = {
  isPerishable: z.boolean().optional(),
  quantity: z.number().positive().finite().max(1_000_000).nullish(),
  quantityUnit: z.enum(["KG", "PCS", "LITERS"]).nullish(),
  tradeWithinHours: z.union([z.literal(6), z.literal(24)]).nullish(),
}

/**
 * Shared by create and update — see the note on itemPerishableFields.
 *
 * The parameter is typed to the four fields it actually reads rather than to
 * the whole schema, so it composes onto any object carrying them and TypeScript
 * still checks that it does. `z.ZodTypeAny` alone erases the shape and turns
 * every one of these predicates into `any`.
 */
interface PerishableShape {
  isPerishable?: boolean | undefined
  quantity?: number | null | undefined
  quantityUnit?: "KG" | "PCS" | "LITERS" | null | undefined
  tradeWithinHours?: 6 | 24 | null | undefined
}

function refinePerishable<T extends z.ZodType<PerishableShape>>(schema: T) {
  return schema
    .refine((v) => v.quantity == null || v.quantityUnit != null, {
      message: "Pick a unit for that quantity",
      path: ["quantityUnit"],
    })
    .refine((v) => v.quantityUnit == null || v.quantity != null, {
      message: "Enter a quantity for that unit",
      path: ["quantity"],
    })
    .refine(
      (v) =>
        v.isPerishable === true ||
        (v.tradeWithinHours == null && v.quantity == null && v.quantityUnit == null),
      {
        message: "Quantity and trade-within only apply to a perishable listing",
        path: ["isPerishable"],
      },
    )
    .refine((v) => v.isPerishable !== true || v.tradeWithinHours != null, {
      message: "Choose how long you can trade this within",
      path: ["tradeWithinHours"],
    })
}

export const createItemSchema = refinePerishable(
  z.object({
    title: text(MAX_TITLE).optional(),
    wantedItem: text(MAX_TITLE).optional(),
    description: z.string().trim().max(MAX_DESCRIPTION).nullish(),
    category: categorySchema,
    condition: conditionSchema,
    valueLeaves: leafAmountSchema.nullish(),
    images: z.array(z.string().trim().max(MAX_URL)).max(10).optional(),
    wantedItems: optionalText(MAX_WANTED),
    imageHash: z.string().trim().max(128).nullish(),
    imageHashes: imageHashesField,
    ...itemPickupFields,
    ...itemHubField,
    ...itemLookingForField,
    ...itemPerishableFields,
  }),
).refine((v) => !!(v.title ?? v.wantedItem), {
  message: "title is required",
  path: ["title"],
})

/**
 * `isPerishable` is NOT editable here, and that is deliberate.
 *
 * The window is measured from `createdAt`, so flipping an old standard listing
 * to perishable would give it a window that expired before it was set — and
 * flipping a perishable back to standard is a way to shed a window that is
 * about to close. Either direction is a listing lying about its own clock. The
 * owner deletes and reposts, which is what "this is a different batch" means.
 *
 * `lookingForCategories` IS editable: it is a preference, it has no clock, and
 * an owner whose wants change should not have to relist to say so.
 */
export const updateItemSchema = z.object({
  title: text(MAX_TITLE).optional(),
  description: z.string().trim().max(MAX_DESCRIPTION).optional(),
  category: categorySchema.optional(),
  condition: conditionSchema.optional(),
  valueLeaves: leafAmountSchema.nullish(),
  images: z.array(z.string().trim().max(MAX_URL)).max(10).optional(),
  wantedItems: optionalText(MAX_WANTED),
  imageHash: z.string().trim().max(128).nullish(),
  imageHashes: imageHashesField,
  ...itemPickupFields,
  ...itemHubField,
  ...itemLookingForField,
})

// ── Offers, trades, messages ─────────────────────────────────────────────────

/**
 * `offeredLeaves` is the one that mattered. A negative value skipped the
 * `> 0` balance guard and then INFLATED availableLeaves, because that function
 * subtracts the sum of pending offers from the balance. leafAmountSchema makes
 * a negative unrepresentable at the boundary.
 */
/**
 * ONE item for ONE listing, since 16 Sep 2026.
 *
 * `offeredItems` (a list) and `offeredLeaves` are BOTH still named here, and
 * both are refused with a sentence rather than stripped. This is a plain
 * z.object, so an unrecognised key would be dropped silently and a shipped
 * client sending the old shape would get a 201 for an offer that said
 * something it did not mean -- the same failure `confirmSubmitSchema` refuses
 * `safeZone: true` to avoid. A client that sends a single-element
 * `offeredItems` is doing what every shipped client does, so that one case is
 * ACCEPTED and mapped onto `offeredItemId`.
 */
export const createOfferSchema = z
  .object({
    postId: z.string().min(1).max(64),
    /** The one item being offered. Preferred spelling. */
    offeredItemId: z.string().min(1).max(64).optional(),
    /** The old list. One element is accepted; more is refused below. */
    offeredItems: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          title: z.string().max(MAX_TITLE).optional(),
          imageUrl: z.string().max(MAX_URL).optional(),
        }),
      )
      .max(20)
      .optional(),
    /** Gone. Named so it can be refused; see the note above. */
    offeredLeaves: leafAmountSchema.nullish(),
    message: optionalText(MAX_MESSAGE),
    /**
     * Required for a bridge (an item one bracket below the listing), absent
     * otherwise. The route decides which case this is -- the client does not
     * get to declare that an offer is free.
     */
    consent: z
      .object({
        accepted: z.literal(true),
        policyVersion: z.string().min(1).max(32),
      })
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.offeredLeaves != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["offeredLeaves"],
        message:
          "Offers no longer carry Leaves. Offer an item in the same bracket, or one bracket below and pay the bridging fee.",
      })
    }
    if ((v.offeredItems?.length ?? 0) > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["offeredItems"],
        message: "An offer is one item for one item. Choose which item you are offering.",
      })
    }
    if (!v.offeredItemId && !v.offeredItems?.[0]?.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["offeredItemId"],
        message: "Name the item you are offering.",
      })
    }
  })
  .transform((v) => ({
    postId: v.postId,
    offeredItemId: (v.offeredItemId ?? v.offeredItems?.[0]?.id) as string,
    message: v.message,
    consent: v.consent,
  }))

/**
 * The receiver's decision, and -- when THEY are the one paying the bridging
 * fee -- their agreement to it.
 *
 * `consent` is required only for an accept of an offer whose item is one
 * bracket ABOVE their listing, which is the case where the receiver moves up
 * and therefore pays. The route decides that, not the client: a body that
 * carries consent for a free offer is harmless and ignored, and one that omits
 * it for a chargeable accept is refused with CONSENT_REQUIRED.
 */
export const offerActionSchema = z.object({
  action: z.enum(["accept", "decline"]),
  consent: z
    .object({
      accepted: z.literal(true),
      policyVersion: z.string().min(1).max(32),
    })
    .optional(),
})

export const createTradeSchema = z.object({
  offeredItemId: z.string().min(1).max(64),
  requestedItemId: z.string().min(1).max(64),
  message: optionalText(MAX_MESSAGE),
})

export const tradeStatusSchema = z.object({
  tradeId: z.string().min(1).max(64),
  status: z.enum(["ACCEPTED", "REJECTED"]),
})

export const tradeActionSchema = z.object({ action: z.enum(["cancel", "hide"]) })

/**
 * The swap-confirmation submission.
 *
 * `safeZoneHubId` REPLACED `safeZone: boolean`. The old field is still accepted
 * so a shipped client sending it gets a real error instead of silent
 * non-payment: this schema is a plain z.object, so an unrecognised key would be
 * stripped and the request would succeed while quietly doing less than it said.
 * The route rejects `safeZone: true` without a hub id and explains why -- see
 * the note there. Sending `safeZone: false` is harmless and ignored.
 */
export const confirmSubmitSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, "Code must be exactly 6 digits"),
  /** Deprecated. Accepted only so the route can 400 it with an explanation. */
  safeZone: z.boolean().optional(),
  /**
   * Which hub the parties met at. Validated against the table AND against both
   * traded listings' declared hubs in the route -- shape only, here.
   */
  safeZoneHubId: z.string().trim().min(1).max(64).nullish(),
})

export const createMessageSchema = z.object({
  receiverId: z.string().min(1).max(64),
  content: text(MAX_MESSAGE),
  tradeId: z.string().min(1).max(64).nullish(),
})

export const typingSchema = z.object({ receiverId: z.string().min(1).max(64) })

// ── Social ───────────────────────────────────────────────────────────────────

export const createCommentSchema = z.object({
  content: text(MAX_COMMENT),
  parentId: z.string().min(1).max(64).nullish(),
})

export const createReviewSchema = z.object({
  tradeId: z.string().min(1).max(64),
  stars: z.number().int().min(1).max(5),
  comment: optionalText(MAX_COMMENT),
})

export const followSchema = z.object({ followeeId: z.string().min(1).max(64) })

export const followActionSchema = z.object({ action: z.enum(["accept", "decline"]) })

// ── User ─────────────────────────────────────────────────────────────────────

export const updateUserSchema = z.object({
  name: text(MAX_NAME).optional(),
  bio: z.string().trim().max(MAX_BIO).optional(),
  location: z.string().trim().max(MAX_LOCATION).optional(),
  avatar: z.string().trim().max(MAX_URL).optional(),
  currentPassword: z.string().max(200).optional(),
  newPassword: passwordSchema.optional(),
})

export const deleteUserSchema = z.object({
  /** Typed confirmation, so a stray DELETE cannot erase an account. */
  confirm: z.literal("DELETE"),
  /** Required when the account has a password — proves it is the owner. */
  password: z.string().max(200).optional(),
})

// ── AI ───────────────────────────────────────────────────────────────────────

/** Shape only. The host allowlist is @/lib/safe-image-url — see the note there. */
export const imageUrlSchema = z.object({ imageUrl: z.string().min(1).max(MAX_URL) })

// ── Helper ───────────────────────────────────────────────────────────────────

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse }

/**
 * Parses a JSON body against a schema, or produces the 400 to return.
 *
 * The error body names the failing fields and nothing else — no stack, no raw
 * input echoed back.
 */
export async function parseBody<S extends z.ZodType>(
  req: Request,
  schema: S,
): Promise<ParseResult<z.infer<S>>> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }),
    }
  }

  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 10).map((i) => ({
      field: i.path.join(".") || "(body)",
      message: i.message,
    }))
    return {
      ok: false,
      response: NextResponse.json(
        { error: issues[0]?.message ?? "Invalid request body", issues },
        { status: 400 },
      ),
    }
  }

  return { ok: true, data: parsed.data }
}
