import { NextRequest } from "next/server"
import { z } from "zod"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok, unauthenticated, notFound, forbidden, conflict, fail } from "@/lib/v1/envelope"
import { parseJsonBody } from "@/lib/v1/body"
import { parseQuery } from "@/lib/v1/query"
import { enforceRateLimit } from "@/lib/rate-limit-config"
import { ORG_CONTEXT_HEADER } from "@/lib/organizations"
import { STORY_CAPTION_MAX, createListingStory, listStoryRow } from "@/lib/stories"

export const dynamic = "force-dynamic"

/**
 * GET  /api/v1/stories — the stories row at the top of Community.
 * POST /api/v1/stories — share one of your own AVAILABLE listings for 24 h.
 *
 * The rules are in @/lib/stories; see liveStoryWhere() for what "live" means.
 *
 * PERSONAL ACCOUNTS ONLY (v1). A POST carrying X-Baylo-Org is refused with
 * FORBIDDEN / PERSONAL_ONLY rather than quietly posted as the person: the
 * phone sent it while acting as a shop, and a story appearing under the
 * person's face would be the wrong author either way. GET ignores the header;
 * the row is the person's view whichever context the phone is in.
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

  const authors = await listStoryRow(prisma, session.user.id)
  return ok({ authors })
}

export async function POST(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const authorId = session.user.id

  if (req.headers.get(ORG_CONTEXT_HEADER)) {
    return forbidden("Stories are for personal accounts", { code: "PERSONAL_ONLY" })
  }

  const limited = enforceRateLimit("storyCreate", authorId)
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
      return forbidden("Stories are for personal accounts", { code: "PERSONAL_ONLY" })
  }
}
