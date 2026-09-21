ALTER TABLE "Message" ADD COLUMN "systemEventKey" TEXT;

CREATE UNIQUE INDEX "Message_systemEventKey_key"
ON "Message"("systemEventKey");