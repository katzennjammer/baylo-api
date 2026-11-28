-- Meetup counter limit (29 Nov 2026). Owner-approved after the defense: two
-- traders could counter each other's hub/time forever. Each side may now
-- counter MAX_MEETUP_COUNTERS (3) times; after that the system suggests the
-- fairest hub for both (fairMeetupHub() in @/lib/meetup) and offers a free
-- cancel.
--
-- ADDITIVE ONLY: two counters, default 0, on Trade. Existing trades start at 0.
ALTER TABLE "Trade" ADD COLUMN "meetupCountersBySender"   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Trade" ADD COLUMN "meetupCountersByReceiver" INTEGER NOT NULL DEFAULT 0;
