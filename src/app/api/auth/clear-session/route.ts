import { redirect } from "next/navigation"
import { auth, signOut } from "@root/auth"
import prisma from "@/lib/prisma"
import { suspensionState, activeSuspension } from "@/lib/moderation"

export const dynamic = "force-dynamic"

/**
 * GET /api/auth/clear-session — where the page guards send a session whose
 * account is gone (deleted, suspended, or no longer in the database).
 *
 * The guards used to redirect such a session straight to /auth/login. But the
 * cookie is a signed JWT that is still valid on its own, so src/proxy.ts saw a
 * logged-in user on an /auth page and sent them back to /dashboard, whose guard
 * sent them to /auth/login again: ERR_TOO_MANY_REDIRECTS, with no way out
 * short of deleting the cookie by hand. A server component cannot delete a
 * cookie; a route handler can, so the sign-out happens here.
 *
 * It re-checks the account rather than signing out whoever arrives: a GET that
 * logged anyone out would let any page on the internet end a live session
 * with an <img> tag.
 */
export async function GET() {
  const session = await auth()
  if (session?.user?.id) {
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { deletedAt: true, suspensions: activeSuspension() },
    })
    if (user && !user.deletedAt && !suspensionState(user).suspended) redirect("/dashboard")
    await signOut({ redirectTo: "/auth/login" })
  }
  redirect("/auth/login")
}
