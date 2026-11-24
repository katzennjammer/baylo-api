import { z } from "zod"

import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { isExpoPushToken } from "@/lib/push"
import { parseJsonBody } from "@/lib/v1/body"
import { ok, unauthenticated } from "@/lib/v1/envelope"
import { withJsonErrors } from "@/lib/v1/with-json-errors"

/**
 * The phone's Expo push token (20 Oct 2026). See @/lib/push.
 *
 *   POST   { token }  this phone now receives this account's pushes
 *   DELETE { token }  sign-out: stop, if this phone is still the one on file
 *
 * One phone per account (User.pushToken). A token is also taken OFF any other
 * account first: a shared phone that signs into a second account must stop
 * buzzing for the first.
 *
 * DELETE only clears a matching token, so signing out of an old phone does
 * not switch off the phone the person moved to.
 */

export const dynamic = "force-dynamic"

const bodySchema = z
  .object({ token: z.string().refine(isExpoPushToken, "not an Expo push token") })
  .strict()

export const POST = withJsonErrors("POST v1/push-token", async (req: Request) => {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const parsed = await parseJsonBody(req, bodySchema)
  if (!parsed.ok) return parsed.response
  const { token } = parsed.data

  await prisma.$transaction([
    prisma.user.updateMany({ where: { pushToken: token, id: { not: session.user.id } }, data: { pushToken: null } }),
    prisma.user.update({ where: { id: session.user.id }, data: { pushToken: token } }),
  ])
  return ok({ registered: true })
})

export const DELETE = withJsonErrors("DELETE v1/push-token", async (req: Request) => {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const parsed = await parseJsonBody(req, bodySchema)
  if (!parsed.ok) return parsed.response

  const { count } = await prisma.user.updateMany({
    where: { id: session.user.id, pushToken: parsed.data.token },
    data: { pushToken: null },
  })
  return ok({ cleared: count === 1 })
})
