import pusher from "./pusher"

/**
 * The ONE way a route sends a realtime event.
 *
 * ── WHY EVERY TRIGGER GOES THROUGH HERE ─────────────────────────────────────
 *
 * Every event Baylo sends tells a phone that something it could also learn by
 * refetching has changed. The write that event announces is the outcome the
 * caller asked for, and it is already saved by the time the event is sent. A
 * Pusher failure must therefore never become the HTTP response: until 11 Oct
 * 2026 the trade cancel, the trade decline and the web typing route awaited
 * Pusher bare, so with Pusher unreachable the user cancelled a trade, got a
 * 500, and was refused when they tried again ("cannot be cancelled").
 *
 * ── TWO WAYS PUSHER FAILS, AND WHY `.catch()` WAS NOT ENOUGH ────────────────
 *
 *   rejected  a wrong secret, no network, a Pusher outage: the promise rejects
 *   thrown    a missing secret (or an invalid channel name): trigger() throws
 *             BEFORE it returns a promise, so a `.catch()` chained onto the
 *             call never runs, and neither does a Promise.allSettled() the call
 *             sits inside, because the array literal throws first
 *
 * Most routes had `.catch(() => {})`, which covers the first case only. This
 * helper is try/await, which covers both.
 *
 * ── AWAITED, BUT BOUNDED AND NEVER THROWING ─────────────────────────────────
 *
 * Callers await it so the route does not return before the event is at least
 * sent. The wait is bounded by the client's `timeout` in ./pusher, so a network
 * that hangs instead of refusing delays a response by seconds, not by the OS
 * TCP timeout. Failures are LOGGED: a silent catch makes "Pusher is down" look
 * exactly like "nobody was listening".
 *
 * scripts/verify-pusher-safe.ts refuses any `pusher.trigger(` outside this file.
 */
export async function notifyUser(userId: string, event: string, payload: unknown): Promise<void> {
  const channel = `private-user-${userId}`
  try {
    await pusher.trigger(channel, event, payload)
  } catch (e) {
    const status = (e as { status?: unknown } | null)?.status
    // Pusher says WHY in the response body ("Message quota exceeded",
    // "Invalid channel name"...). Without it every refusal reads the same.
    const body = (e as { body?: unknown } | null)?.body
    console.warn(
      `[realtime] ${event} -> ${channel} failed${typeof status === "number" ? ` (HTTP ${status})` : ""}: ` +
        (e instanceof Error ? e.message : String(e)) +
        (typeof body === "string" && body.trim() ? ` -- ${body.trim().slice(0, 200)}` : ""),
    )
  }
}
