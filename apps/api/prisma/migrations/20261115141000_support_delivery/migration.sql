-- Staff replies are queued in SupportMessage and pushed to Telegram by the
-- support bot; these columns make the retry state visible to staff.

ALTER TABLE "SupportMessage" ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SupportMessage" ADD COLUMN "deliveryError" TEXT;
