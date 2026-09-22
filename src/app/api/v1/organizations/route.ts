import { NextRequest } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { enforceRateLimit } from "@/lib/rate-limit-config"
import { sanitizeImage } from "@/lib/image-sanitize"
import { ok, unauthenticated, invalid, conflict, forbidden } from "@/lib/v1/envelope"
import { activeOrgsFor, createOrganization } from "@/lib/organizations"
import { uploadOrgDocument } from "@/lib/org-document"

export const dynamic = "force-dynamic"

/**
 * /api/v1/organizations — create one, and list the ones I may act as.
 *
 * ── MULTIPART, FOR THE REASON /api/v1/id-verification IS ────────────────────
 *
 * The business document goes straight from this request into an
 * `authenticated`-type Cloudinary asset. Routing it through POST /api/upload
 * first — which every LISTING photo does — would write a DTI registration
 * carrying somebody's home address to a world-readable URL and leave it there
 * for the whole time it sat in the review queue, and leave it there forever if
 * the applicant then abandoned the form and no row was ever created to point
 * at it. See the header of @/lib/org-document.
 *
 * ── THE ORDER OF THE CHECKS IS THE DESIGN ───────────────────────────────────
 *
 * Everything that can refuse runs BEFORE the upload, so a refused application
 * never puts a business registration onto a third party's servers:
 *
 *   401  no session
 *   429  the shared upload budget
 *   403  this account is itself an organisation's backing row
 *   409  already an owner of an organisation
 *   400  bad name / category / missing file / too large / not an image
 *   ---- only now is anything uploaded ----
 */

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_NAME = 120

export const BUSINESS_CATEGORIES = [
  "SARI_SARI",
  "FOOD_AND_BEVERAGE",
  "AGRICULTURE",
  "HANDICRAFT",
  "APPAREL",
  "ELECTRONICS_REPAIR",
  "SERVICES",
  "RETAIL",
  "COOPERATIVE",
  "NONPROFIT",
  "OTHER",
] as const

export const BUSINESS_CATEGORY_LABEL: Record<(typeof BUSINESS_CATEGORIES)[number], string> = {
  SARI_SARI: "Sari-sari store",
  FOOD_AND_BEVERAGE: "Food & beverage",
  AGRICULTURE: "Agriculture & farming",
  HANDICRAFT: "Handicraft",
  APPAREL: "Apparel",
  ELECTRONICS_REPAIR: "Electronics & repair",
  SERVICES: "Services",
  RETAIL: "Retail",
  COOPERATIVE: "Cooperative",
  NONPROFIT: "Non-profit",
  OTHER: "Other",
}

/**
 * GET — the organisations this person may act as, plus the vocabulary the
 * creation form needs.
 *
 * The taxonomy travels WITH the response rather than being compiled into the
 * client, the same call /api/v1/id-verification makes: a shipped mobile build
 * that hard-codes eleven business categories is one that has to go through the
 * Play Store the day a twelfth is accepted.
 */
export async function GET() {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()

  const organizations = await activeOrgsFor(prisma, session.user.id)

  // Invitations waiting on an answer. Listed SEPARATELY from `organizations`
  // and never merged into it: a PENDING row is not a permission, and an org in
  // the switcher that every write path then refuses is worse than no entry.
  const invitations = await prisma.organizationMember.findMany({
    where: { userId: session.user.id, status: "PENDING" },
    select: {
      id: true,
      invitedAt: true,
      organization: { select: { id: true, name: true, logoUrl: true } },
    },
    orderBy: { invitedAt: "desc" },
  })

  return ok({
    organizations,
    invitations: invitations.map((i) => ({
      membershipId: i.id,
      invitedAt: i.invitedAt,
      organization: i.organization,
    })),
    businessCategories: BUSINESS_CATEGORIES.map((v) => ({
      value: v,
      label: BUSINESS_CATEGORY_LABEL[v],
    })),
    limits: { maxNameLength: MAX_NAME, maxImageBytes: MAX_IMAGE_BYTES },
  })
}

/** POST — register an organisation. The caller becomes its first OWNER. */
export async function POST(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const userId = session.user.id

  // Before formData(), which buffers the whole body into memory — a limit
  // applied after it has already paid the cost it was meant to avoid.
  const limited = enforceRateLimit("upload", userId)
  if (limited) return limited

  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: { isOrgAccount: true },
  })
  // An organisation cannot found an organisation. The backing row has no way
  // to reach this endpoint today — it cannot log in — but the rule belongs
  // where it is enforced rather than where it is currently unreachable.
  if (me?.isOrgAccount) {
    return forbidden("An organisation account cannot create another organisation.")
  }

  // ONE ORGANISATION PER FOUNDER, for now. Not a technical limit — the schema
  // allows a person to own several — but a deliberate one: an account that can
  // mint organisations at will is an account that can mint listing identities
  // at will, and every one of them is a fresh, unreviewed profile. Raising this
  // is a product decision that should come with a reason.
  const existingOwnership = await prisma.organizationMember.findFirst({
    where: { userId, role: "OWNER", status: "ACTIVE" },
    select: { organization: { select: { id: true, name: true } } },
  })
  if (existingOwnership) {
    return conflict("You already run an organisation on this account.", {
      organization: existingOwnership.organization,
    })
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return invalid("Send this as multipart/form-data with name, businessCategory and file.")
  }

  const name = String(form.get("name") ?? "").trim()
  if (name.length < 2 || name.length > MAX_NAME) {
    return invalid(`Enter the business name — between 2 and ${MAX_NAME} characters.`)
  }

  const categoryRaw = String(form.get("businessCategory") ?? "")
  if (!(BUSINESS_CATEGORIES as readonly string[]).includes(categoryRaw)) {
    return invalid(`"${categoryRaw}" is not a business category we accept.`)
  }

  const file = form.get("file")
  if (!(file instanceof File)) {
    return invalid("Attach a photo of your DTI/SEC registration or barangay permit.")
  }
  if (file.size > MAX_IMAGE_BYTES) return invalid("The document must be under 10 MB.")

  // The declared MIME type is not consulted. sanitizeImage() decodes the actual
  // bytes — that IS the content check — and re-encodes without metadata. A
  // permit photographed at the shop carries the shop's coordinates in EXIF.
  let sanitized: { buffer: Buffer }
  try {
    sanitized = await sanitizeImage(Buffer.from(await file.arrayBuffer()))
  } catch {
    return invalid("That file is not an image we can read. Send a JPEG or PNG photo.")
  }

  let document: { url: string; publicId: string }
  try {
    document = await uploadOrgDocument(sanitized.buffer)
  } catch (err) {
    console.error(
      "[organizations] document upload failed:",
      err instanceof Error ? err.message : "unknown error",
    )
    return invalid("We could not store that document. Try again in a moment.")
  }

  const created = await createOrganization({
    founderUserId: userId,
    name,
    businessCategory: categoryRaw,
    businessDocUrl: document.url,
    businessDocPublicId: document.publicId,
  })

  // PENDING, and the org can already post and trade. What it does not have yet
  // is the checkmark — see the note on orgBadge(). Saying so here is what stops
  // the client rendering this as a wall.
  return ok(
    {
      organizationId: created.organizationId,
      name,
      verificationStatus: "PENDING",
      verified: false,
      notice:
        "Your organisation is live and can post and trade now. " +
        "The verified badge appears once we have checked your document.",
    },
    { created: true },
  )
}
