import { after } from "next/server"

/**
 * Best-effort work that must outlive the response. On a serverless host an
 * unawaited promise can be frozen mid-flight once the response is sent;
 * `after()` keeps the function alive until it settles (waitUntil on Vercel).
 * Outside a request -- a tsx script -- after() throws, and the work simply
 * runs, exactly as `void` always did.
 *
 * Pass a promise that already handles its own rejection: this does not catch.
 */
export function runInBackground(work: Promise<unknown>): void {
  try {
    after(work)
  } catch {
    void work
  }
}
