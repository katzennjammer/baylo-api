import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { DEFAULT_LANDING, LANDING_COOKIE, LANDING_OPTIONS } from "../pref-keys"

export const dynamic = "force-dynamic"

/**
 * Where the console opens: the page this admin picked in Settings. The
 * wordmark and the post-login redirect both point here. The cookie is only
 * honoured when it names one of LANDING_OPTIONS, so it can never be used to
 * redirect somewhere else.
 */
export default async function AdminHomePage() {
  const chosen = (await cookies()).get(LANDING_COOKIE)?.value
  redirect(LANDING_OPTIONS.find((option) => option.href === chosen)?.href ?? DEFAULT_LANDING)
}
