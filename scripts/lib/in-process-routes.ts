/**
 * Calls Next route handlers IN THIS PROCESS, with no server.
 *
 * Every other harness drives a `next dev` bound to a scratch schema. This one
 * exists for runs where starting a server is not on the table: the handler is
 * imported and called with a Request, the way Next would call it.
 *
 * The one thing a handler cannot do outside Next is `headers()` from
 * next/headers -- it reads Next's per-request storage, and throws without it.
 * resolveSession() is the only caller in the auth path, and all it wants is the
 * Authorization header. So two module ids are replaced, before anything loads
 * them:
 *
 *   next/headers  -> headers() returns the header set by asBearer() / asAnon();
 *                    cookies() is an empty jar.
 *   @root/auth    -> auth() returns null: the NextAuth cookie path is never
 *                    signed in. Keeps next-auth itself out of the process.
 *
 * ORDER MATTERS: import this module first, and load route modules with a
 * dynamic `await import()` after it, so they resolve through the hooks.
 * Sync hooks (module.registerHooks, Node >= 22.15) cover require() and import
 * alike, which matters because tsx loads these .ts files as CommonJS.
 */
import * as nodeModule from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { NextRequest } from "next/server"

// module.registerHooks is Node >= 22.15; the project's @types/node is 20, which
// does not declare it. Typed here rather than bumping @types/node for one script.
type ResolveResult = { url: string; format?: string; shortCircuit?: boolean }
type ResolveHook = (
  specifier: string,
  context: unknown,
  next: (specifier: string, context: unknown) => ResolveResult,
) => ResolveResult
const { registerHooks } = nodeModule as unknown as { registerHooks?: (hooks: { resolve: ResolveHook }) => void }
if (!registerHooks) throw new Error("in-process-routes needs Node >= 22.15 (module.registerHooks)")

// Real files rather than generated source: a sync `load` hook on Node 22 cannot
// hand CommonJS through to tsx, so only `resolve` is hooked.
const STUBS: Record<string, string> = {
  "next/headers": "./in-process-stubs/next-headers.cjs",
  "@root/auth": "./in-process-stubs/root-auth.cjs",
}

registerHooks({
  resolve(specifier, context, next) {
    const stub = STUBS[specifier]
    if (stub) return { url: pathToFileURL(path.join(__dirname, stub)).href, format: "commonjs", shortCircuit: true }
    return next(specifier, context)
  },
})

const g = globalThis as { __inProcessHeaders?: Headers }

/** The next handler call is signed in with this access token. */
export function asBearer(accessToken: string) {
  g.__inProcessHeaders = new Headers({ authorization: `Bearer ${accessToken}` })
}

/** The next handler call carries no credentials. */
export function asAnon() {
  g.__inProcessHeaders = new Headers()
}

/** A JSON request for a handler. The URL only has to parse. */
export function jsonRequest(method: string, path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://in-process.test${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** Status plus parsed JSON body (or {} when there is none). */
export async function read(res: Response): Promise<{ status: number; json: Record<string, unknown> }> {
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}
