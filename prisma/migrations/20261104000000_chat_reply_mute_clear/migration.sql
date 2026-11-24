-- Chat: swipe to reply, mute a person, delete a chat for yourself.
-- Owner-approved exception to the schema freeze (4 Nov 2026): new COLUMNS
-- only, no new table or view. The database stays at 28 tables + 1 view.
--
-- ADDITIVE ONLY. Nullable or defaulted columns, one index, no data touched.
-- Apply before deploying the code that names these columns (Prisma selects
-- every scalar column on a query without `select`).

ALTER TABLE "Message" ADD COLUMN "replyToId" TEXT;
ALTER TABLE "Message" ADD CONSTRAINT "Message_replyToId_fkey"
  FOREIGN KEY ("replyToId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Message_replyToId_idx" ON "Message"("replyToId");

ALTER TABLE "User" ADD COLUMN "mutedChatUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "User" ADD COLUMN "clearedChats" JSONB;
