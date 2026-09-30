/**
 * The origin that links in emails are built from.
 *
 * ── WHY NOT JUST NEXTAUTH_URL ────────────────────────────────────────────────
 *
 * Until 30 Sep 2026 every emailed link was `${NEXTAUTH_URL}/…`, and
 * NEXTAUTH_URL is `http://localhost:3000` in development. The requests that
 * send those emails come from the phone, and on the phone `localhost` is the
 * phone: the reset button and the verify button in every email went nowhere.
 * Hardcoding the LAN IP into NEXTAUTH_URL does not fix it either — the address
 * moves between the Wi-Fi, the laptop hotspot and whatever the gear on the
 * login screen was last set to — and NEXTAUTH_URL also drives the web sign-in
 * callbacks, which want localhost.
 *
 * The one party that always knows an address the phone can reach is the
 * request itself: its Host header is whatever the app dialled. So:
 *
 *   1. APP_PUBLIC_URL, when set, wins, and nothing is read from the request.
 *      A real deployment sets it and is done.
 *   2. Otherwise the request's Host, but ONLY a loopback or private-LAN one.
 *      A reset link built from an arbitrary Host header is the classic
 *      password-reset poisoning hole: an attacker asks for a reset for your
 *      address with `Host: evil.example` and you receive a genuine Baylo email
 *      that hands your token to evil.example. A private address cannot be
 *      registered by anyone, which is why it is the only kind accepted here.
 *   3. Otherwise NEXTAUTH_URL, as before.
 *
 * Forwarded headers (X-Forwarded-Host and friends) are never read, for the
 * same reason as rule 2.
 */

function isPrivateHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

function configured(name: string): string | null {
  const value = (process.env[name] ?? "").trim().replace(/\/+$/, "")
  return /^https?:\/\//i.test(value) ? value : null
}

export function publicBaseUrl(req?: Request): string {
  const pinned = configured("APP_PUBLIC_URL")
  if (pinned) return pinned

  const host = req?.headers.get("host")
  if (host) {
    try {
      const url = new URL(`http://${host}`)
      // `host` must be exactly a host[:port] — anything that parses with a
      // path, credentials or a different host than it spells is refused.
      if (url.host === host.toLowerCase() && isPrivateHost(url.hostname)) {
        return url.origin
      }
    } catch {
      // Unparseable Host header: fall through.
    }
  }

  return configured("NEXTAUTH_URL") ?? ""
}
