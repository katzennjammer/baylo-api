import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { parseBody } from "@/lib/validation"
import { isAllowedImageUrl } from "@/lib/safe-image-url"
import { ok, unauthenticated, invalid, notFound } from "@/lib/v1/envelope"
import { isOrgOwner } from "@/lib/organizations"

export const dynamic = "force-dynamic"

/**
 * PATCH /api/v1/organizations/[id] — the storefront's own settings. OWNER only.
 *
 * ── WHAT IS EDITABLE HERE, AND WHAT IS NOT ──────────────────────────────────
 *
 *   logoUrl       the square logo
 *   bannerUrl     the wide cover image across the top of the storefront
 *   description   the shop's tagline, under the category line
 *
 * NOT the name, the category or the DTI number. Those three are what the
 * business-document review checked, and an org that could rename itself after
 * its badge landed would carry a checkmark earned under a different name.
 * Changing them is a re-review, which does not exist yet.
 *
 * ── THE IMAGES ARE PUBLIC, SO THEY TAKE THE PUBLIC PATH ─────────────────────
 *
 * Unlike the business document, a logo and a banner exist to be seen by
 * everyone. They go up through POST /api/upload exactly as a listing photo or
 * a person's avatar does, and arrive here as the URL that route returned. The
 * URL is held to isAllowedImageUrl() — our own Cloudinary cloud, https — so a
 * storefront cannot be made to hotlink an arbitrary third-party host into every
 * viewer's app.
 *
 * ── THE LOGO IS ALSO WRITTEN TO THE BACKING ROW'S AVATAR ────────────────────
 *
 * createOrganization() seeds User.avatar from the logo, and every surface that
 * renders an account by its User row — a message thread, a review, a
 * connections list — reads `avatar`. Updating one without the other would show
 * the new logo on the storefront and the old one in every conversation. Both
 * are written in one transaction.
 *
 * 404 rather than 403 for a non-owner, matching the members route: a 403
 * confirms the organisation exists to somebody with no business knowing.
 */

const MAX_DESCRIPTION = 500

/** A URL, or null to clear it. Omitted means "leave it alone". */
const imageField = z.union([z.string().trim().max(2048), z.null()]).optional()

const patchSchema = z.strictObject({
  logoUrl: imageField,
  bannerUrl: imageField,
  description: z.union([z.string().trim().max(MAX_DESCRIPTION), z.null()]).optional(),
})

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const { id: organizationId } = await params

  if (!(await isOrgOwner(prisma, organizationId, session.user.id))) {
    return notFound("Organisation not found")
  }

  const parsed = await parseBody(req, patchSchema)
  if (!parsed.ok) return parsed.response
  const { logoUrl, bannerUrl, description } = parsed.data

  if (logoUrl === undefined && bannerUrl === undefined && description === undefined) {
    return invalid("Send logoUrl, bannerUrl or description.")
  }

  // An empty string clears, the same as null — a client that sends back an
  // emptied field should not have to know which of the two we meant.
  const logo = logoUrl === undefined ? undefined : logoUrl || null
  const banner = bannerUrl === undefined ? undefined : bannerUrl || null
  for (const [field, value] of [["logoUrl", logo], ["bannerUrl", banner]] as const) {
    if (value) {
      const check = isAllowedImageUrl(value)
      if (!check.ok) return invalid(`${field}: upload the image through /api/upload first.`)
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const org = await tx.organization.update({
      where: { id: organizationId },
      data: {
        ...(logo !== undefined ? { logoUrl: logo } : {}),
        ...(banner !== undefined ? { bannerUrl: banner } : {}),
        ...(description !== undefined ? { description: description || null } : {}),
      },
      select: { id: true, orgUserId: true, logoUrl: true, bannerUrl: true, description: true },
    })
    if (logo !== undefined) {
      await tx.user.update({ where: { id: org.orgUserId }, data: { avatar: logo } })
    }
    return org
  })

  return ok({
    organizationId: updated.id,
    logoUrl: updated.logoUrl,
    bannerUrl: updated.bannerUrl,
    description: updated.description,
  })
}
