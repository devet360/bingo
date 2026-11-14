-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('PLAYER', 'AGENT', 'SUPER_ADMIN', 'SUPPORT');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'BANNED', 'DELETED');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ClientPlatform" AS ENUM ('TELEGRAM_MINI_APP', 'IOS', 'ANDROID', 'WEB', 'AGENT_PORTAL');

-- CreateEnum
CREATE TYPE "OtpChannel" AS ENUM ('SMS', 'EMAIL', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('LOGIN', 'LINK_PHONE', 'LINK_EMAIL', 'PASSWORD_RESET', 'WITHDRAWAL_CONFIRM');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "AgentTier" AS ENUM ('BRONZE', 'SILVER', 'GOLD', 'PLATINUM');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('MOBILE_MONEY', 'BANK_TRANSFER', 'CASH', 'CARD', 'CRYPTO');

-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('PENDING', 'PROCESSING', 'CREDITED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('ESCROWED', 'SETTLED', 'CANCELLED', 'EXPIRED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "AccountOwnerKind" AS ENUM ('USER', 'AGENT', 'PLATFORM');

-- CreateEnum
CREATE TYPE "AccountCode" AS ENUM ('AVAILABLE', 'ESCROW', 'LOCKED', 'FLOAT', 'FLOAT_ESCROW', 'COMMISSION', 'RAKE', 'COMMISSION_EXPENSE', 'TREASURY', 'SUSPENSE');

-- CreateEnum
CREATE TYPE "LedgerKind" AS ENUM ('AGENT_FLOAT_TOP_UP', 'AGENT_FLOAT_CASH_OUT', 'AGENT_FLOAT_ADJUSTMENT', 'DEPOSIT', 'DEPOSIT_COMMISSION', 'WITHDRAWAL_ESCROW', 'WITHDRAWAL_SETTLEMENT', 'WITHDRAWAL_COMMISSION', 'WITHDRAWAL_REFUND', 'WITHDRAWAL_FEE', 'CARD_PURCHASE', 'ROUND_PAYOUT', 'ROUND_REFUND', 'MANUAL_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "CommissionKind" AS ENUM ('DEPOSIT', 'WITHDRAWAL');

-- CreateEnum
CREATE TYPE "FloatRequestDirection" AS ENUM ('TOP_UP', 'CASH_OUT');

-- CreateEnum
CREATE TYPE "FloatRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BingoVariant" AS ENUM ('US_75', 'UK_90');

-- CreateEnum
CREATE TYPE "WinPattern" AS ENUM ('HORIZONTAL', 'VERTICAL', 'DIAGONAL', 'FOUR_CORNERS', 'FULL_HOUSE');

-- CreateEnum
CREATE TYPE "RoomStatus" AS ENUM ('OPEN', 'MAINTENANCE', 'CLOSED');

-- CreateEnum
CREATE TYPE "RoundStatus" AS ENUM ('WAITING', 'LOCKED', 'PLAYING', 'CLAIM_VERIFICATION', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CardStatus" AS ENUM ('ACTIVE', 'WON', 'LOST', 'REFUNDED');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('PENDING', 'VALID', 'INVALID', 'PAID');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('DEPOSIT_CREDITED', 'DEPOSIT_REJECTED', 'WITHDRAWAL_SETTLED', 'WITHDRAWAL_EXPIRED', 'COMMISSION_PAID', 'ROUND_RESULT', 'AGENT_ALERT', 'SYSTEM');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "telegramId" BIGINT,
    "telegramUsername" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "passwordHash" TEXT,
    "displayName" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "countryCode" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'PLAYER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "kycReviewedAt" TIMESTAMP(3),
    "referralCode" TEXT NOT NULL,
    "referredById" UUID,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "platform" "ClientPlatform" NOT NULL,
    "deviceId" TEXT,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpCode" (
    "id" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "channel" "OtpChannel" NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentProfile" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "agentCode" TEXT NOT NULL,
    "status" "AgentStatus" NOT NULL DEFAULT 'PENDING',
    "tier" "AgentTier" NOT NULL DEFAULT 'BRONZE',
    "region" TEXT NOT NULL,
    "city" TEXT,
    "district" TEXT,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "ratingAvg" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "completedDeposits" INTEGER NOT NULL DEFAULT 0,
    "completedWithdrawals" INTEGER NOT NULL DEFAULT 0,
    "depositCommissionBps" INTEGER NOT NULL DEFAULT 300,
    "withdrawalCommissionBps" INTEGER NOT NULL DEFAULT 200,
    "perTxnLimit" BIGINT,
    "dailyDepositLimit" BIGINT,
    "dailyWithdrawalLimit" BIGINT,
    "floatAvailable" BIGINT NOT NULL DEFAULT 0,
    "floatEscrow" BIGINT NOT NULL DEFAULT 0,
    "commissionEarned" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "internalNote" TEXT,
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentPaymentAccount" (
    "id" UUID NOT NULL,
    "agentProfileId" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "provider" TEXT,
    "accountName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "instructions" TEXT,
    "minAmount" BIGINT,
    "maxAmount" BIGINT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentPaymentAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRating" (
    "id" UUID NOT NULL,
    "agentProfileId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "depositId" UUID,
    "score" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentFloatRequest" (
    "id" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "agentProfileId" UUID NOT NULL,
    "direction" "FloatRequestDirection" NOT NULL,
    "amount" BIGINT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "externalRef" TEXT,
    "proofUrl" TEXT,
    "status" "FloatRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" UUID,
    "reviewNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentFloatRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" UUID NOT NULL,
    "ownerKind" "AccountOwnerKind" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "code" "AccountCode" NOT NULL,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionLedger" (
    "id" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "kind" "LedgerKind" NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "memo" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" BIGSERIAL NOT NULL,
    "ledgerId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "balanceAfter" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCommission" (
    "id" UUID NOT NULL,
    "agentProfileId" UUID NOT NULL,
    "kind" "CommissionKind" NOT NULL,
    "depositId" UUID,
    "withdrawalId" UUID,
    "baseAmount" BIGINT NOT NULL,
    "bps" INTEGER NOT NULL,
    "amount" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentCommission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionRule" (
    "id" UUID NOT NULL,
    "tier" "AgentTier" NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "depositBps" INTEGER NOT NULL DEFAULT 300,
    "withdrawalBps" INTEGER NOT NULL DEFAULT 200,
    "minAmount" BIGINT,
    "maxAmount" BIGINT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "available" BIGINT NOT NULL DEFAULT 0,
    "escrow" BIGINT NOT NULL DEFAULT 0,
    "locked" BIGINT NOT NULL DEFAULT 0,
    "lifetimeDeposited" BIGINT NOT NULL DEFAULT 0,
    "lifetimeWithdrawn" BIGINT NOT NULL DEFAULT 0,
    "lifetimeWagered" BIGINT NOT NULL DEFAULT 0,
    "lifetimeWon" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepositRequest" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "playerId" UUID NOT NULL,
    "agentProfileId" UUID,
    "paymentAccountId" UUID,
    "method" "PaymentMethod" NOT NULL,
    "amount" BIGINT NOT NULL,
    "creditedAmount" BIGINT,
    "status" "DepositStatus" NOT NULL DEFAULT 'PENDING',
    "receiptUrl" TEXT,
    "externalRef" TEXT,
    "playerNote" TEXT,
    "agentNote" TEXT,
    "processedById" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepositRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WithdrawalRequest" (
    "id" UUID NOT NULL,
    "payoutCode" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "playerId" UUID NOT NULL,
    "agentProfileId" UUID NOT NULL,
    "paymentAccountId" UUID,
    "method" "PaymentMethod" NOT NULL,
    "amount" BIGINT NOT NULL,
    "fee" BIGINT NOT NULL DEFAULT 0,
    "netAmount" BIGINT NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'ESCROWED',
    "playerNote" TEXT,
    "agentNote" TEXT,
    "processedById" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WithdrawalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BingoRoom" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "variant" "BingoVariant" NOT NULL,
    "stakePerCard" BIGINT NOT NULL,
    "maxCardsPerPlayer" INTEGER NOT NULL DEFAULT 4,
    "minPlayersToStart" INTEGER NOT NULL DEFAULT 2,
    "rakeBps" INTEGER NOT NULL DEFAULT 1000,
    "allowedPatterns" "WinPattern"[],
    "status" "RoomStatus" NOT NULL DEFAULT 'OPEN',
    "purchaseWindowSecs" INTEGER NOT NULL DEFAULT 15,
    "lockWindowSecs" INTEGER NOT NULL DEFAULT 5,
    "drawIntervalMs" INTEGER NOT NULL DEFAULT 3500,
    "claimWindowSecs" INTEGER NOT NULL DEFAULT 20,
    "autoDaubEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BingoRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BingoRound" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "roundNumber" INTEGER NOT NULL,
    "status" "RoundStatus" NOT NULL DEFAULT 'WAITING',
    "variant" "BingoVariant" NOT NULL,
    "stakePerCard" BIGINT NOT NULL,
    "rakeBps" INTEGER NOT NULL,
    "allowedPatterns" "WinPattern"[],
    "serverSeed" TEXT NOT NULL,
    "serverSeedHash" TEXT NOT NULL,
    "clientSeed" TEXT,
    "clientSeedCount" INTEGER NOT NULL DEFAULT 0,
    "nonce" INTEGER NOT NULL DEFAULT 0,
    "rngVersion" TEXT NOT NULL DEFAULT 'hmac-sha256-fisher-yates-v1',
    "ballOrder" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "drawnBalls" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "currentBall" INTEGER,
    "cardsSold" INTEGER NOT NULL DEFAULT 0,
    "uniquePlayers" INTEGER NOT NULL DEFAULT 0,
    "grossPot" BIGINT NOT NULL DEFAULT 0,
    "rakeAmount" BIGINT NOT NULL DEFAULT 0,
    "prizePool" BIGINT NOT NULL DEFAULT 0,
    "winningPattern" "WinPattern",
    "claimsOpenAt" TIMESTAMP(3),
    "claimsCloseAt" TIMESTAMP(3),
    "purchaseClosesAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "lastDrawAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "seedRevealedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BingoRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BingoCard" (
    "id" UUID NOT NULL,
    "roundId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "cardIndex" INTEGER NOT NULL,
    "stake" BIGINT NOT NULL,
    "variant" "BingoVariant" NOT NULL,
    "cells" JSONB NOT NULL,
    "markedNumbers" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "autoDaub" BOOLEAN NOT NULL DEFAULT false,
    "clientSeed" TEXT,
    "idempotencyKey" TEXT,
    "status" "CardStatus" NOT NULL DEFAULT 'ACTIVE',
    "wonPattern" "WinPattern",
    "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BingoCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BingoClaim" (
    "id" UUID NOT NULL,
    "roundId" UUID NOT NULL,
    "cardId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "pattern" "WinPattern" NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'PENDING',
    "drawnSnapshot" INTEGER[],
    "rejectionReason" TEXT,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validatedAt" TIMESTAMP(3),

    CONSTRAINT "BingoClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoundWinner" (
    "id" UUID NOT NULL,
    "roundId" UUID NOT NULL,
    "cardId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "pattern" "WinPattern" NOT NULL,
    "payout" BIGINT NOT NULL,
    "isSplitPot" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoundWinner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" BIGSERIAL NOT NULL,
    "actorId" UUID,
    "actorRole" "UserRole",
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemConfig" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemConfig_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");

-- CreateIndex
CREATE INDEX "User_role_status_idx" ON "User"("role", "status");

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuthSession_refreshTokenHash_key" ON "AuthSession"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "AuthSession_userId_revokedAt_idx" ON "AuthSession"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "OtpCode_identifier_purpose_createdAt_idx" ON "OtpCode"("identifier", "purpose", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentProfile_userId_key" ON "AgentProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentProfile_agentCode_key" ON "AgentProfile"("agentCode");

-- CreateIndex
CREATE INDEX "AgentProfile_status_isOnline_region_idx" ON "AgentProfile"("status", "isOnline", "region");

-- CreateIndex
CREATE INDEX "AgentProfile_tier_status_idx" ON "AgentProfile"("tier", "status");

-- CreateIndex
CREATE INDEX "AgentPaymentAccount_agentProfileId_isActive_idx" ON "AgentPaymentAccount"("agentProfileId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "AgentPaymentAccount_agentProfileId_method_accountNumber_key" ON "AgentPaymentAccount"("agentProfileId", "method", "accountNumber");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRating_depositId_key" ON "AgentRating"("depositId");

-- CreateIndex
CREATE INDEX "AgentRating_agentProfileId_createdAt_idx" ON "AgentRating"("agentProfileId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentFloatRequest_idempotencyKey_key" ON "AgentFloatRequest"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AgentFloatRequest_status_createdAt_idx" ON "AgentFloatRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AgentFloatRequest_agentProfileId_createdAt_idx" ON "AgentFloatRequest"("agentProfileId", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerAccount_code_idx" ON "LedgerAccount"("code");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_ownerKind_ownerId_code_key" ON "LedgerAccount"("ownerKind", "ownerId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionLedger_idempotencyKey_key" ON "TransactionLedger"("idempotencyKey");

-- CreateIndex
CREATE INDEX "TransactionLedger_refType_refId_idx" ON "TransactionLedger"("refType", "refId");

-- CreateIndex
CREATE INDEX "TransactionLedger_createdAt_idx" ON "TransactionLedger"("createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_accountId_id_idx" ON "LedgerEntry"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_ledgerId_accountId_key" ON "LedgerEntry"("ledgerId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCommission_depositId_key" ON "AgentCommission"("depositId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCommission_withdrawalId_key" ON "AgentCommission"("withdrawalId");

-- CreateIndex
CREATE INDEX "AgentCommission_agentProfileId_createdAt_idx" ON "AgentCommission"("agentProfileId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionRule_tier_method_key" ON "CommissionRule"("tier", "method");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_key" ON "Wallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DepositRequest_idempotencyKey_key" ON "DepositRequest"("idempotencyKey");

-- CreateIndex
CREATE INDEX "DepositRequest_agentProfileId_status_createdAt_idx" ON "DepositRequest"("agentProfileId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "DepositRequest_playerId_status_idx" ON "DepositRequest"("playerId", "status");

-- CreateIndex
CREATE INDEX "DepositRequest_status_expiresAt_idx" ON "DepositRequest"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "DepositRequest_code_idx" ON "DepositRequest"("code");

-- CreateIndex
CREATE UNIQUE INDEX "WithdrawalRequest_idempotencyKey_key" ON "WithdrawalRequest"("idempotencyKey");

-- CreateIndex
CREATE INDEX "WithdrawalRequest_agentProfileId_status_createdAt_idx" ON "WithdrawalRequest"("agentProfileId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "WithdrawalRequest_playerId_status_idx" ON "WithdrawalRequest"("playerId", "status");

-- CreateIndex
CREATE INDEX "WithdrawalRequest_status_expiresAt_idx" ON "WithdrawalRequest"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "WithdrawalRequest_payoutCode_idx" ON "WithdrawalRequest"("payoutCode");

-- CreateIndex
CREATE UNIQUE INDEX "BingoRoom_code_key" ON "BingoRoom"("code");

-- CreateIndex
CREATE INDEX "BingoRoom_status_variant_idx" ON "BingoRoom"("status", "variant");

-- CreateIndex
CREATE INDEX "BingoRound_status_createdAt_idx" ON "BingoRound"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BingoRound_roomId_roundNumber_key" ON "BingoRound"("roomId", "roundNumber");

-- CreateIndex
CREATE UNIQUE INDEX "BingoCard_idempotencyKey_key" ON "BingoCard"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BingoCard_roundId_status_idx" ON "BingoCard"("roundId", "status");

-- CreateIndex
CREATE INDEX "BingoCard_userId_purchasedAt_idx" ON "BingoCard"("userId", "purchasedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BingoCard_roundId_userId_cardIndex_key" ON "BingoCard"("roundId", "userId", "cardIndex");

-- CreateIndex
CREATE INDEX "BingoClaim_roundId_status_idx" ON "BingoClaim"("roundId", "status");

-- CreateIndex
CREATE INDEX "BingoClaim_cardId_idx" ON "BingoClaim"("cardId");

-- CreateIndex
CREATE UNIQUE INDEX "RoundWinner_cardId_key" ON "RoundWinner"("cardId");

-- CreateIndex
CREATE INDEX "RoundWinner_roundId_idx" ON "RoundWinner"("roundId");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentProfile" ADD CONSTRAINT "AgentProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPaymentAccount" ADD CONSTRAINT "AgentPaymentAccount_agentProfileId_fkey" FOREIGN KEY ("agentProfileId") REFERENCES "AgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRating" ADD CONSTRAINT "AgentRating_agentProfileId_fkey" FOREIGN KEY ("agentProfileId") REFERENCES "AgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRating" ADD CONSTRAINT "AgentRating_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRating" ADD CONSTRAINT "AgentRating_depositId_fkey" FOREIGN KEY ("depositId") REFERENCES "DepositRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentFloatRequest" ADD CONSTRAINT "AgentFloatRequest_agentProfileId_fkey" FOREIGN KEY ("agentProfileId") REFERENCES "AgentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentFloatRequest" ADD CONSTRAINT "AgentFloatRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionLedger" ADD CONSTRAINT "TransactionLedger_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_ledgerId_fkey" FOREIGN KEY ("ledgerId") REFERENCES "TransactionLedger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCommission" ADD CONSTRAINT "AgentCommission_agentProfileId_fkey" FOREIGN KEY ("agentProfileId") REFERENCES "AgentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCommission" ADD CONSTRAINT "AgentCommission_depositId_fkey" FOREIGN KEY ("depositId") REFERENCES "DepositRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCommission" ADD CONSTRAINT "AgentCommission_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "WithdrawalRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositRequest" ADD CONSTRAINT "DepositRequest_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositRequest" ADD CONSTRAINT "DepositRequest_agentProfileId_fkey" FOREIGN KEY ("agentProfileId") REFERENCES "AgentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositRequest" ADD CONSTRAINT "DepositRequest_paymentAccountId_fkey" FOREIGN KEY ("paymentAccountId") REFERENCES "AgentPaymentAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositRequest" ADD CONSTRAINT "DepositRequest_processedById_fkey" FOREIGN KEY ("processedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_agentProfileId_fkey" FOREIGN KEY ("agentProfileId") REFERENCES "AgentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_paymentAccountId_fkey" FOREIGN KEY ("paymentAccountId") REFERENCES "AgentPaymentAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_processedById_fkey" FOREIGN KEY ("processedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BingoRound" ADD CONSTRAINT "BingoRound_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "BingoRoom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BingoCard" ADD CONSTRAINT "BingoCard_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "BingoRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BingoCard" ADD CONSTRAINT "BingoCard_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BingoClaim" ADD CONSTRAINT "BingoClaim_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "BingoRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BingoClaim" ADD CONSTRAINT "BingoClaim_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "BingoCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BingoClaim" ADD CONSTRAINT "BingoClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoundWinner" ADD CONSTRAINT "RoundWinner_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "BingoRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoundWinner" ADD CONSTRAINT "RoundWinner_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "BingoCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoundWinner" ADD CONSTRAINT "RoundWinner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
