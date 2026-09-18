ALTER TABLE "UserAchievement" ADD COLUMN "displayOrder" INTEGER;
CREATE INDEX "UserAchievement_userId_displayOrder_idx" ON "UserAchievement"("userId", "displayOrder");
