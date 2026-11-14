-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "telegramSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "phoneVerifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Notification_telegramSentAt_createdAt_idx" ON "Notification"("telegramSentAt", "createdAt");
