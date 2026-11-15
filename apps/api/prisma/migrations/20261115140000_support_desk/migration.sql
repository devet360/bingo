-- Support desk: the player ↔ staff chat opened from the dedicated support bot.
-- NotificationType gains a value but does not use it here: adding an enum value
-- and referencing it in the same transaction is rejected by PostgreSQL.

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SUPPORT_MESSAGE';

CREATE TYPE "SupportTicketStatus" AS ENUM ('OPEN', 'PENDING', 'RESOLVED', 'CLOSED');
CREATE TYPE "SupportTopic" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'ACCOUNT', 'PAYMENTS', 'OTHER');
CREATE TYPE "SupportMessageAuthor" AS ENUM ('PLAYER', 'STAFF', 'BOT', 'SYSTEM');

CREATE TABLE "SupportTicket" (
  "id"                  UUID NOT NULL,
  "code"                TEXT NOT NULL,
  "playerId"            UUID NOT NULL,
  "telegramChatId"      BIGINT NOT NULL,
  "topic"               "SupportTopic" NOT NULL DEFAULT 'OTHER',
  "status"              "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
  "locale"              TEXT NOT NULL DEFAULT 'en',
  "subject"             TEXT NOT NULL DEFAULT 'Support request',
  "assigneeId"          UUID,
  "claimedAt"           TIMESTAMP(3),
  "resolvedAt"          TIMESTAMP(3),
  "unreadForStaff"      INTEGER NOT NULL DEFAULT 0,
  "unreadForPlayer"     INTEGER NOT NULL DEFAULT 0,
  "lastMessageAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastPlayerMessageAt" TIMESTAMP(3),
  "lastStaffMessageAt"  TIMESTAMP(3),
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupportTicket_code_key" ON "SupportTicket" ("code");
CREATE INDEX "SupportTicket_status_lastMessageAt_idx" ON "SupportTicket" ("status", "lastMessageAt");
CREATE INDEX "SupportTicket_playerId_lastMessageAt_idx" ON "SupportTicket" ("playerId", "lastMessageAt");
CREATE INDEX "SupportTicket_assigneeId_status_idx" ON "SupportTicket" ("assigneeId", "status");
-- One live conversation per player: the bot continues it instead of opening more.
CREATE UNIQUE INDEX "SupportTicket_one_active_per_player"
  ON "SupportTicket" ("playerId")
  WHERE "status" IN ('OPEN', 'PENDING');

ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_playerId_fkey"
  FOREIGN KEY ("playerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_assigneeId_fkey"
  FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "SupportMessage" (
  "id"                UUID NOT NULL,
  "ticketId"          UUID NOT NULL,
  "author"            "SupportMessageAuthor" NOT NULL,
  "authorUserId"      UUID,
  "body"              TEXT NOT NULL,
  "mediaAssetId"      UUID,
  "telegramMessageId" BIGINT,
  "deliveredAt"       TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportMessage_body_present"
    CHECK (length(btrim("body")) > 0 OR "mediaAssetId" IS NOT NULL)
);

CREATE INDEX "SupportMessage_ticketId_createdAt_idx" ON "SupportMessage" ("ticketId", "createdAt");
CREATE INDEX "SupportMessage_authorUserId_createdAt_idx" ON "SupportMessage" ("authorUserId", "createdAt");

ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_authorUserId_fkey"
  FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_mediaAssetId_fkey"
  FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
