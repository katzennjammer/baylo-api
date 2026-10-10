// Acceptance harness: active sessions, per-device logout, replay detection.
//
// TWO MODES, ONE SET OF CHECKS.
//
//   IN-PROCESS (ACCEPT_BASE unset): no server. Route handlers are imported and
//   called directly (see scripts/lib/in-process-routes.ts):
//
//     $base = ((Get-Content .env | ? { $_ -match '^DATABASE_URL=' }) -replace '^DATABASE_URL=','' -replace '"','').Trim()
//     $env:DATABASE_URL      = "${base}?schema=scratch_sessions"
//     $env:DATABASE_POOL_URL = ""                 # the live transaction pooler: never
//     $env:PUSHER_SECRET     = "invalid-harness"  # a Pusher call fails, it does not deliver
//     $env:EMAIL_SMTP_HOST   = "127.0.0.1"; $env:EMAIL_SMTP_PORT = "9"   # dead port: no mail leaves
//     .\scripts\scratch.ps1 -Run scripts\verify-active-sessions.ts -Name scratch_sessions
//
//   HTTP (ACCEPT_BASE set): the same checks against a real server bound to the
//   SAME scratch schema as this process's DATABASE_URL, plus section 11, which
//   only HTTP can test: that Next routes the static `revoke-others` segment
//   ahead of the dynamic `[familyId]` one. scripts\run-auth-harnesses.ps1 runs
//   it this way against a server from scripts\scratch-dev-safe.ps1.
//
// Either way it is SCRATCH ONLY, and it refuses to start unless the side
// channels are disarmed in its own environment as well.
//
// What it pins:
//   1  login starts a family; the access token's sid IS that familyId
//   2  refresh rotates inside the family; the spent row is stamped usedAt
//   3  REPLAY of a spent refresh token revokes the whole family, and the
//      rotated access token from that family is refused at once
//   4  GET /api/v1/sessions lists live families only, exactly one isCurrent,
//      and nothing token-shaped leaves the route
//   5  DELETE /api/v1/sessions/:id: that device's next request is a 401; a
//      second delete is a 404
//   6  another user can neither see nor revoke your families (404)
//   7  POST revoke-others keeps the caller's family and only that
//   8  a pre-`sid` token still authenticates, is never isCurrent, and cannot
//      revoke-others (409)
//   9  password change keeps the current device, signs out the rest
//  10  password reset signs out every device
//  11  (HTTP only) /api/v1/sessions/revoke-others is the static route

import { asBearer, asAnon, jsonRequest, read } from "./lib/in-process-routes"
import { requireScratchSchema } from "./lib/live-guard"

requireScratchSchema("scripts/verify-active-sessions.ts")
{
  const refuse = (why: string) => { console.error(`\n  REFUSING: ${why}\n`); process.exit(1) }
  if (process.env.DATABASE_POOL_URL) refuse("DATABASE_POOL_URL is set (the live pooler). Set it to an empty string.")
  if (!process.env.PUSHER_SECRET?.startsWith("invalid")) refuse("PUSHER_SECRET must start with 'invalid' so nothing is broadcast.")
  if (!["127.0.0.1", "localhost"].includes(process.env.EMAIL_SMTP_HOST ?? "")) refuse("EMAIL_SMTP_HOST must be 127.0.0.1 (a local port).")
}

const BASE = process.env.ACCEPT_BASE?.replace(/\/+$/, "") || null
const P = "ZZSESS_"
// Unique per run: the server's login limit (10 per email per 15 minutes)
// outlives a run, so fixed fixture emails would 429 on a rerun. User A logs in
// 9 times in HTTP mode.
const RUN = Date.now().toString(36)
const PASSWORD = "harness-pass-1"
let pass = 0
let fail = 0

function check(name: string, cond: boolean, detail: unknown = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}   ${typeof detail === "string" ? detail : JSON.stringify(detail)}`) }
}
function head(s: string) {
  console.log(`\n── ${s} ${"─".repeat(Math.max(0, 66 - s.length))}`)
}

type Reply = { status: number; json: Record<string, unknown> }
type Call = (method: string, path: string, opts?: { bearer?: string; body?: unknown }) => Promise<Reply>

/** Over the wire, to ACCEPT_BASE. */
function httpCall(base: string): Call {
  return async (method, path, opts = {}) => {
    const headers: Record<string, string> = { accept: "application/json" }
    if (opts.body !== undefined) headers["content-type"] = "application/json"
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`
    const res = await fetch(`${base}${path}`, {
      method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> }
  }
}

/**
 * Straight into the handlers. This IS a router, so it proves nothing about
 * Next's routing -- that is section 11's job, and it runs only over HTTP.
 */
async function inProcessCall(): Promise<Call> {
  // Route modules load AFTER the hooks are in place: dynamic imports, on purpose.
  const tokenRoute = await import("../src/app/api/auth/token/route")
  const refreshRoute = await import("../src/app/api/auth/refresh/route")
  const resetRoute = await import("../src/app/api/auth/reset-password/route")
  const userRoute = await import("../src/app/api/user/route")
  const sessionsRoute = await import("../src/app/api/v1/sessions/route")
  const oneSessionRoute = await import("../src/app/api/v1/sessions/[familyId]/route")
  const othersRoute = await import("../src/app/api/v1/sessions/revoke-others/route")

  return async (method, path, opts = {}) => {
    if (opts.bearer) asBearer(opts.bearer)
    else asAnon()
    const req = jsonRequest(method, path, opts.body)
    const key = `${method} ${path}`
    const one = /^DELETE \/api\/v1\/sessions\/([^/]+)$/.exec(key)
    let res: Response
    if (key === "POST /api/auth/token") res = await tokenRoute.POST(req)
    else if (key === "POST /api/auth/refresh") res = await refreshRoute.POST(req)
    else if (key === "POST /api/auth/reset-password") res = await resetRoute.POST(req)
    else if (key === "PATCH /api/user") res = await userRoute.PATCH(req)
    else if (key === "GET /api/v1/sessions") res = await sessionsRoute.GET()
    else if (key === "POST /api/v1/sessions/revoke-others") res = await othersRoute.POST()
    else if (one) res = await oneSessionRoute.DELETE(req, { params: Promise.resolve({ familyId: decodeURIComponent(one[1]) }) })
    else throw new Error(`in-process: no handler wired for ${key}`)
    return read(res)
  }
}

;(async () => {
  const { default: prisma } = await import("../src/lib/prisma")
  const bcrypt = (await import("bcryptjs")).default
  const { verifyAccessToken, signAccessToken, hashRefreshToken } = await import("../src/lib/auth-tokens")
  const { hashResetToken } = await import("../src/lib/reset-token")

  if (BASE) {
    try { await fetch(`${BASE}/api/v1/hubs`) } catch {
      console.error(`\n  No server at ${BASE}. Start one with scripts\\scratch-dev-safe.ps1 first.\n`)
      process.exit(2)
    }
  }
  const call: Call = BASE ? httpCall(BASE) : await inProcessCall()
  console.log(`  mode: ${BASE ? `HTTP against ${BASE}` : "in-process (no server)"}`)

  type Pair = { accessToken: string; refreshToken: string }
  type Sess = { id: string; signedInAt: string; lastActiveAt: string; isCurrent: boolean }

  async function cleanup() {
    // AuthToken cascades from User. Every run's fixtures, not just this one's.
    await prisma.user.deleteMany({ where: { email: { startsWith: P.toLowerCase() } } })
  }
  async function mkUser(tag: string) {
    return prisma.user.create({
      data: {
        name: `${P}${tag}`, email: `${P}${RUN}_${tag}@example.com`.toLowerCase(),
        password: await bcrypt.hash(PASSWORD, 4), isVerified: true, leaves: 0,
      },
    })
  }
  async function login(email: string, password = PASSWORD): Promise<Pair> {
    const r = await call("POST", "/api/auth/token", { body: { email, password } })
    if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.json)}`)
    return r.json as unknown as Pair
  }
  const refresh = (refreshToken: string) => call("POST", "/api/auth/refresh", { body: { refreshToken } })
  async function list(accessToken: string) {
    const r = await call("GET", "/api/v1/sessions", { bearer: accessToken })
    const data = r.json.data as { sessions: Sess[] } | null
    return { status: r.status, sessions: data?.sessions ?? [], raw: r.json }
  }
  const revokeOne = (accessToken: string | undefined, familyId: string) =>
    call("DELETE", `/api/v1/sessions/${encodeURIComponent(familyId)}`, { bearer: accessToken })
  const revokeOthers = (accessToken: string) => call("POST", "/api/v1/sessions/revoke-others", { bearer: accessToken })
  const sidOf = async (accessToken: string) => (await verifyAccessToken(accessToken))?.sid ?? null
  const familyOf = async (refreshToken: string) =>
    (await prisma.authToken.findUnique({ where: { tokenHash: hashRefreshToken(refreshToken) } }))?.familyId ?? null
  const liveRows = (userId: string) =>
    prisma.authToken.count({ where: { userId, type: "REFRESH", revokedAt: null } })

  await cleanup()
  const A = await mkUser("alice")
  const B = await mkUser("bob")

  try {
    head("1  login starts a family; sid = familyId")
    const d1 = await login(A.email)
    const fam1 = await familyOf(d1.refreshToken)
    check("login wrote a REFRESH row with a familyId", !!fam1)
    check("access token sid equals that familyId", (await sidOf(d1.accessToken)) === fam1, { sid: await sidOf(d1.accessToken), fam1 })
    const d2 = await login(A.email)
    const fam2 = await familyOf(d2.refreshToken)
    check("a second login starts a different family", !!fam2 && fam2 !== fam1)

    head("2  refresh rotates inside the family")
    const r1 = await refresh(d1.refreshToken)
    check("refresh answers 200", r1.status === 200, r1)
    const d1r = r1.json as unknown as Pair
    check("rotated refresh token stays in the family", (await familyOf(d1r.refreshToken)) === fam1)
    check("rotated access token carries the same sid", (await sidOf(d1r.accessToken)) === fam1)
    const spent = await prisma.authToken.findUnique({ where: { tokenHash: hashRefreshToken(d1.refreshToken) } })
    check("the presented row is stamped usedAt, not deleted, not revoked", !!spent?.usedAt && !spent.revokedAt)
    check("the rotated access token works", (await list(d1r.accessToken)).status === 200)

    head("3  replay revokes the family, immediately")
    const replay = await refresh(d1.refreshToken)
    check("replaying a spent refresh token is a 401", replay.status === 401, replay)
    const fam1Live = await prisma.authToken.count({ where: { familyId: fam1!, revokedAt: null } })
    check("every row in the family is revoked", fam1Live === 0, { fam1Live })
    check("the family's CURRENT access token is refused at once", (await list(d1r.accessToken)).status === 401)
    check("the family's current refresh token is refused", (await refresh(d1r.refreshToken)).status === 401)
    check("the other family is untouched", (await list(d2.accessToken)).status === 200)

    head("4  list sessions")
    const d3 = await login(A.email)
    const fam3 = await familyOf(d3.refreshToken)
    const l = await list(d2.accessToken)
    const ids = l.sessions.map((s) => s.id).sort()
    check("lists exactly the two live families", JSON.stringify(ids) === JSON.stringify([fam2, fam3].sort()), ids)
    check("the replayed family is not listed", !ids.includes(fam1!))
    check("exactly one isCurrent", l.sessions.filter((s) => s.isCurrent).length === 1)
    check("isCurrent is the caller's own family", l.sessions.find((s) => s.isCurrent)?.id === fam2)
    check("this device is listed first", l.sessions[0]?.isCurrent === true)
    check("dates parse and signedInAt <= lastActiveAt",
      l.sessions.every((s) => !isNaN(Date.parse(s.signedInAt)) && Date.parse(s.signedInAt) <= Date.parse(s.lastActiveAt)))
    const rawText = JSON.stringify(l.raw)
    const hashes = (await prisma.authToken.findMany({ where: { userId: A.id }, select: { tokenHash: true } })).map((t) => t.tokenHash)
    check("no token hash or token field in the response",
      !hashes.some((h) => rawText.includes(h)) && !/tokenHash|refreshToken|accessToken|expiresAt/.test(rawText))
    check("each session has exactly id, signedInAt, lastActiveAt, isCurrent",
      l.sessions.every((s) => JSON.stringify(Object.keys(s).sort()) === JSON.stringify(["id", "isCurrent", "lastActiveAt", "signedInAt"])))
    const l3 = await list(d3.accessToken)
    check("from the other device, isCurrent flips", l3.sessions.find((s) => s.isCurrent)?.id === fam3)

    head("5  revoke one device")
    const del = await revokeOne(d2.accessToken, fam3!)
    check("DELETE answers 200", del.status === 200, del)
    check("that device's next request is a 401, immediately", (await list(d3.accessToken)).status === 401)
    check("that device's refresh token is dead", (await refresh(d3.refreshToken)).status === 401)
    check("the caller is still signed in", (await list(d2.accessToken)).status === 200)
    const again = await revokeOne(d2.accessToken, fam3!)
    check("deleting it again is a 404", again.status === 404, again)
    check("a made-up id is a 404", (await revokeOne(d2.accessToken, "no-such-family")).status === 404)
    check("no credentials is a 401", (await revokeOne(undefined, fam2!)).status === 401)

    head("6  another user's families")
    const b1 = await login(B.email)
    const bList = await list(b1.accessToken)
    check("B sees only B's own session", bList.sessions.length === 1 && bList.sessions[0].id === (await familyOf(b1.refreshToken)))
    const steal = await revokeOne(b1.accessToken, fam2!)
    check("B revoking A's family is a 404", steal.status === 404, steal)
    check("A's device survives it", (await list(d2.accessToken)).status === 200)
    check("A's family has live rows still", (await prisma.authToken.count({ where: { familyId: fam2!, revokedAt: null } })) > 0)

    head("7  revoke-others")
    const d4 = await login(A.email)
    const d5 = await login(A.email)
    const ro = await revokeOthers(d2.accessToken)
    check("revoke-others answers 200", ro.status === 200, ro)
    check("the caller still works", (await list(d2.accessToken)).status === 200)
    check("the other devices are 401", (await list(d4.accessToken)).status === 401 && (await list(d5.accessToken)).status === 401)
    const after = await list(d2.accessToken)
    check("only the caller's family is listed", after.sessions.length === 1 && after.sessions[0].id === fam2 && after.sessions[0].isCurrent)
    check("B is untouched by A's revoke-others", (await list(b1.accessToken)).status === 200)

    head("8  pre-sid access token")
    const legacy = await signAccessToken(A.id)
    check("a token without sid has sid null", (await sidOf(legacy)) === null)
    const ll = await list(legacy)
    check("it still authenticates", ll.status === 200)
    check("it is never isCurrent", ll.sessions.every((s) => !s.isCurrent))
    const lro = await revokeOthers(legacy)
    check("revoke-others from it is a 409 and revokes nothing", lro.status === 409 && (await list(d2.accessToken)).status === 200, lro)

    head("9  password change keeps the current device")
    const d6 = await login(A.email)
    const chg = await call("PATCH", "/api/user", { bearer: d2.accessToken, body: { currentPassword: PASSWORD, newPassword: "harness-pass-2" } })
    check("PATCH /api/user with a new password answers 200", chg.status === 200, chg)
    check("the device that changed it is still signed in", (await list(d2.accessToken)).status === 200)
    // d2 has never refreshed, so its original refresh token is still the head.
    check("its refresh token still rotates", (await refresh(d2.refreshToken)).status === 200)
    check("the other device is signed out", (await list(d6.accessToken)).status === 401)
    check("B is untouched", (await list(b1.accessToken)).status === 200)

    head("10 password reset signs out every device")
    const d7 = await login(A.email, "harness-pass-2")
    const raw = `${P}reset-${Date.now()}`
    await prisma.authToken.create({
      data: { type: "PASSWORD_RESET", userId: A.id, tokenHash: hashResetToken(raw), expiresAt: new Date(Date.now() + 3600_000) },
    })
    const rst = await call("POST", "/api/auth/reset-password", { body: { token: raw, password: "harness-pass-3" } })
    check("reset answers 200", rst.status === 200, rst)
    check("no REFRESH row of A's is left unrevoked", (await liveRows(A.id)) === 0, { live: await liveRows(A.id) })
    check("A's devices are 401", (await list(d7.accessToken)).status === 401)
    check("B is untouched", (await list(b1.accessToken)).status === 200 && (await liveRows(B.id)) > 0)
    const fresh = await login(A.email, "harness-pass-3")
    check("the new password logs in", !!fresh.accessToken)

    if (BASE) {
      head("11 routing: revoke-others is the static segment, not [familyId]")
      // [familyId] exports DELETE only; revoke-others exports POST only. Had
      // Next matched [familyId] for this path, the POST would be a 405 and
      // nothing would be revoked, and the DELETE would reach revokeSession()
      // with familyId "revoke-others" and come back a 404. The static segment
      // owning the path gives exactly the opposite: POST 200 carrying its own
      // `kept` field, DELETE 405.
      const other = await login(B.email) // B's second device: must survive A's call below
      const ro11 = await revokeOthers(fresh.accessToken)
      const data = ro11.json.data as { kept?: string } | null
      check("POST /api/v1/sessions/revoke-others answers 200 in the envelope", ro11.status === 200 && ro11.json.error === null, ro11)
      check("its body is the static route's: data.kept is the caller's family", data?.kept === (await sidOf(fresh.accessToken)), data)
      const del11 = await call("DELETE", "/api/v1/sessions/revoke-others", { bearer: fresh.accessToken })
      check("DELETE on that path is a 405 (static route, no DELETE), not [familyId]'s 404", del11.status === 405, { status: del11.status })
      check("the caller survived both", (await list(fresh.accessToken)).status === 200)
      check("B's devices survived A's call", (await list(b1.accessToken)).status === 200 && (await list(other.accessToken)).status === 200)
    }
  } catch (err) {
    fail++
    console.error("\n  HARNESS ERROR", err)
  } finally {
    await cleanup()
    await prisma.$disconnect()
  }

  console.log(`\n  ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
})()
