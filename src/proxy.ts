import NextAuth from "next-auth"
import { authConfig } from "@root/auth.config"
import { NextResponse } from "next/server"

const { auth } = NextAuth(authConfig)

/**
 * THIS IS THE ONLY PROXY FILE NEXT READS. Do not recreate proxy.ts at the
 * project root: Next resolves it relative to the directory that holds `app/`,
 * which here is src/, so a root-level proxy.ts is silently ignored -- no
 * error, no warning, it simply never runs. That is exactly what happened from
 * the Next 16 middleware-to-proxy rename until 11 Sep 2026: the file sat at
 * the root, dead, and /dashboard, /listings and /auth/* had no guard beyond
 * the per-page redirect() calls, and nobody knew. The tell is the dev log: a
 * live proxy prints `proxy.ts: Nms` on every matched request line.
 *
 * THE WEB APP IS RETIRED FOR USERS (11 Sep 2026). Baylo is the Android app;
 * the pages under these prefixes are kept on disk and reachable by STAFF only
 * -- ADMIN and MODERATOR, the same pair /admin admits -- so a moderator can
 * still open a listing or a profile the way the moderation queue links to it.
 * Everyone else lands on /android, one line, no shell.
 *
 * Prefix-matched, so /listings/new and /post/[id] are covered without listing
 * them. Not here on purpose: /auth (the verification and reset emails link
 * into it, for phone users who never see any other page), /admin (its own
 * guard below), /api (the phone), and / (the public landing page).
 */
const RETIRED_FOR_USERS = ["/dashboard", "/listings", "/post", "/profile", "/trust"]

const isRetired = (pathname: string) =>
  RETIRED_FOR_USERS.some((p) => pathname === p || pathname.startsWith(`${p}/`))

export default auth(function proxy(req) {
  const { pathname } = req.nextUrl
  const isLoggedIn = !!req.auth
  // A sign-in-time COPY of User.role carried in the JWT -- see the jwt callback
  // in auth.ts for what that is and is not good for. Absent on tokens issued
  // before the claim existed, which reads as "not staff" until the session
  // refresh backfills it; the safe direction to be wrong in.
  const role = (req.auth?.user as { role?: string } | undefined)?.role
  const isStaff = role === "ADMIN" || role === "MODERATOR"
  const home = isStaff ? "/dashboard" : "/android"

  if (isLoggedIn && (pathname === "/" || pathname.startsWith("/auth/"))) {
    return NextResponse.redirect(new URL(home, req.url))
  }

  if (isRetired(pathname)) {
    // Signed out: to the login page, as before. A moderator who bookmarked
    // /dashboard signs in and arrives; a user signs in and gets /android.
    if (!isLoggedIn) {
      const loginUrl = new URL("/auth/login", req.url)
      loginUrl.searchParams.set("callbackUrl", pathname)
      return NextResponse.redirect(loginUrl)
    }
    if (!isStaff) return NextResponse.redirect(new URL("/android", req.url))
  }

  // /admin is staff-only, and THIS IS NOT THE CHECK THAT ENFORCES THAT.
  //
  // The proxy runs at the edge with no database access: it can read the NextAuth
  // JWT and nothing else. The role claim above is a 30-day cached copy of a
  // permission, which is fine for keeping a retired UI closed and NOT fine for
  // deciding who may read a report -- a moderator whose access was revoked
  // would keep it until their token expired.
  //
  // So this does the one thing it can do correctly — bounce a signed-out
  // visitor to the login page instead of rendering a shell they cannot use —
  // and the real check happens twice against the database: in
  // src/app/admin/layout.tsx for the pages, and in requireRole() for every
  // /api/admin route. Deleting this block changes nothing about who can read a
  // report.
  if (!isLoggedIn && pathname.startsWith("/admin")) {
    const loginUrl = new URL("/auth/login", req.url)
    loginUrl.searchParams.set("callbackUrl", pathname)
    return NextResponse.redirect(loginUrl)
  }
})

export const config = {
  matcher: [
    "/",
    "/auth/:path*",
    "/dashboard/:path*",
    "/listings/:path*",
    "/post/:path*",
    "/profile/:path*",
    "/trust/:path*",
    "/admin/:path*",
  ],
}
