import type { NextAuthConfig } from "next-auth"

// Minimal config safe for Edge runtime (no DB/Node.js-only imports).
// Used only by proxy.ts to verify JWT tokens.
// Full auth config with providers and DB callbacks lives in auth.ts.
export const authConfig = {
  providers: [],
  pages: { signIn: "/auth/login" },
  session: { strategy: "jwt" as const, maxAge: 30 * 24 * 60 * 60 },
  callbacks: {
    // Surfaces the sign-in-time role claim (see the jwt callback in auth.ts)
    // as `req.auth.user.role` so src/proxy.ts can keep the retired web pages
    // to staff (ADMIN and MODERATOR). A copy, not the live column -- read the note in auth.ts before
    // trusting it for anything beyond that.
    session({ session, token }) {
      if (typeof token?.role === "string") {
        ;(session.user as { role?: string }).role = token.role
      }
      return session
    },
  },
} satisfies NextAuthConfig
