-- Achievement definitions are editable catalog rows; unlocks are immutable user facts.
CREATE TYPE "AchievementCriterion" AS ENUM ('VERIFIED_ACCOUNT', 'ID_VERIFIED', 'FIRST_LISTING', 'COMPLETED_TRADES');

CREATE TABLE "Achievement" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "icon" TEXT NOT NULL DEFAULT 'trophy',
  "criterion" "AchievementCriterion" NOT NULL,
  "threshold" INTEGER NOT NULL DEFAULT 1,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Achievement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Achievement_key_key" ON "Achievement"("key");

CREATE TABLE "UserAchievement" (
  "id" TEXT NOT NULL,
  "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userId" TEXT NOT NULL,
  "achievementId" TEXT NOT NULL,
  CONSTRAINT "UserAchievement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UserAchievement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "UserAchievement_achievementId_fkey" FOREIGN KEY ("achievementId") REFERENCES "Achievement"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "UserAchievement_userId_achievementId_key" ON "UserAchievement"("userId", "achievementId");
CREATE INDEX "UserAchievement_userId_idx" ON "UserAchievement"("userId");
CREATE INDEX "UserAchievement_achievementId_idx" ON "UserAchievement"("achievementId");
