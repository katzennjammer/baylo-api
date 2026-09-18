import pusher from "./pusher"

/**
 * The realtime side of the meetup plan.
 *
 * ── WHY A SEPARATE EVENT ────────────────────────────────────────────────────
 *
 * Until 17 Sep 2026 the two meetup routes wrote the row and created a
 * Notification, and that was all. The proposer's phone invalidated its own
 * caches; the partner's phone learned nothing until its next pull, its next
 * foregrounding, or a screen mount more than 30s after the list was last
 * read. Two people arranging Saturday over the app were each looking at a
 * different Saturday for up to a minute, and a tester filed it as "the other
 * trader can't see the meetup".
 *
 * Messages already solve this with `new-message` on the recipient's private
 * channel. This is the same mechanism for the plan, and it is its OWN event
 * rather than a reuse of `trade-status-changed`: that one means the STATUS
 * column moved, and the clients that bind it treat it as "re-read everything
 * about this trade, the codes included". A plan changing moves no status and
 * a client should be free to answer it more cheaply.
 *
 * ── CHANNEL ─────────────────────────────────────────────────────────────────
 *
 * `private-user-<id>`, the recipient's own. /api/pusher/auth authorises that
 * channel by exact equality with the caller's session id, so the only phone
 * that can subscribe to it is the partner's. Nothing sensitive rides in the
 * payload anyway — an id and a word — because the client's job on receipt is
 * to refetch, not to render.
 *
 * ── FIRE AND FORGET ─────────────────────────────────────────────────────────
 *
 * The plan is written before this is called, and the write is the outcome the
 * caller asked for. A Pusher outage must not turn a successful arrangement
 * into a 500 the client will retry, which would write the same plan twice and
 * re-notify. So the promise is awaited (the route should not return before
 * the trigger is at least sent) but never allowed to throw.
 */

export const MEETUP_CHANGED_EVENT = "meetup-changed"

export type MeetupChangedPayload = {
  tradeId: string
  /** What happened to the plan: a proposal (or counter), or an agreement. */
  kind: "proposed" | "agreed"
  /** Who did it. The client already knows which side it is on. */
  actorId: string
}

export async function notifyMeetupChanged(userId: string, payload: MeetupChangedPayload): Promise<void> {
  await pusher.trigger(`private-user-${userId}`, MEETUP_CHANGED_EVENT, payload).catch(() => {
    // See the header. The plan is saved; the partner's next refetch will show it.
  })
}
