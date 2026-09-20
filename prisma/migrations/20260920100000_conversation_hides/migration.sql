-- Hide a conversation for one viewer without deleting any Message rows.
CREATE TABLE "ConversationHide" (
    "id" TEXT NOT NULL,
    "viewerId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "hiddenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationHide_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConversationHide_viewerId_partnerId_key"
    ON "ConversationHide"("viewerId", "partnerId");
CREATE INDEX "ConversationHide_partnerId_idx"
    ON "ConversationHide"("partnerId");

ALTER TABLE "ConversationHide"
    ADD CONSTRAINT "ConversationHide_viewerId_fkey"
    FOREIGN KEY ("viewerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationHide"
    ADD CONSTRAINT "ConversationHide_partnerId_fkey"
    FOREIGN KEY ("partnerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
