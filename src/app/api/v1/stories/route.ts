import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok, unauthenticated, notFound, forbidden, conflict, fail } from "@/lib/v1/envelope"
import { parseJsonBody } from "@/lib/v1/body"
import { parseQuery } from "@/lib/v1/query"
import { enforceRateLimit } from "@/lib/rate-limit-config"
import { ORG_CONTEXT_HEADER, resolveActingIdentity } from "@/lib/organizations"
import { STORY_CAPTION_MAX, createListingStory, listStoryRow } from "@/lib/stories"

export const dynamic = "force-dynamic"

/**
 * GET  /api/v1/stories — the stories row at the top of Community.
 * POST /api/v1/stories — share one of your own AVAILABLE listings for 24 h.
 *
 * The rules are in @/lib/stories; see liveStoryWhere() for what "live" means.
 *
 * SHOPS POST THEIR OWN STORIES (16 Nov 2026). Acting as a shop (X-Baylo-Org,
 * owner only), a POST shares one of the SHOP's listings under the shop's
 * name; only a VERIFIED shop may (see createListingStory). GET puts the
 * acting account's own circle first; blocks still follow the person.
 */

const querySchema = z.strictObject({})

const bodySchema = z.strictObject({
  itemId: z.string().min(1).max(64),
  caption: z
    .string()
    .trim()
    .max(STORY_CAPTION_MAX, `caption cannot exceed ${STORY_CAPTION_MAX} characters`)
    .optional(),
})

export async function GET(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()

  const parsed = parseQuery(req, querySchema)
  if (!parsed.ok) return parsed.response

  const acting = await resolveActingIdentity(prisma, session.user.id, req.headers.get(ORG_CONTEXT_HEADER))
  const ownId = acting.ok ? acting.acting.actingUserId : session.user.id
  const authors = await listStoryRow(prisma, session.user.id, new Date(), undefined, ownId)
  return ok({ authors })
}

export async function POST(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const acting = await resolveActingIdentity(prisma, session.user.id, req.headers.get(ORG_CONTEXT_HEADER))
  if (!acting.ok) return fail("ORG_CONTEXT_REFUSED", "You are not a member of that organisation")
  // The shop's story in shop mode, the person's otherwise.
  const authorId = acting.acting.actingUserId

  // Rate limits stay on the PERSON, like every limiter.
  const limited = enforceRateLimit("storyCreate", session.user.id)
  if (limited) return limited

  const parsed = await parseJsonBody(req, bodySchema)
  if (!parsed.ok) return parsed.response

  const result = await createListingStory(prisma, authorId, parsed.data)
  if (result.ok) {
    return ok({ id: result.storyId, expiresAt: result.expiresAt })
  }

  switch (result.reason) {
    case "LISTING_NOT_SHAREABLE":
      return notFound("That listing can't be shared")
    case "ALREADY_SHARED":
      return conflict("This listing is already in your story", {
        code: "ALREADY_SHARED",
        storyId: result.storyId,
      })
    case "DAILY_CAP":
      // RATE_LIMITED, in the envelope, with the figures: the phone can say
      // "You can share again at 3:40 PM" without parsing a sentence.
      return fail("RATE_LIMITED", `You can share up to ${result.cap} stories a day`, {
        code: "DAILY_CAP",
        cap: result.cap,
        retryAt: result.retryAt,
      })
    case "PERSONAL_ONLY":
      return forbidden("Only verified shops can share stories. Your shop's verification isn't approved yet.", { code: "PERSONAL_ONLY" })
  }
}
