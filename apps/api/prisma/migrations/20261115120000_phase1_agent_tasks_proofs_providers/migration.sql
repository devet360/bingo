-- Phase 1 of the payment-routing release:
--   * agent task routing with a single-task lock,
--   * player payout destinations and withdrawal payment proofs,
--   * two-phase withdrawal holds (ESCROWED -> PROCESSING -> SETTLED),
--   * provider callback audit + per-type idempotency + currency/win caps.
--
-- 'PROCESSING' is added here but first used in sql/constraints.sql, because
-- PostgreSQL cannot reference a new enum value in the transaction that adds it.

-- ─────────────────────────────── ENUMS ───────────────────────────────────────
ALTER TYPE "WithdrawalStatus" ADD VALUE IF NOT EXISTS 'PROCESSING' AFTER 'ESCROWED';

ALTER TYPE "LedgerKind" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_HOLD';
ALTER TYPE "LedgerKind" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_HOLD_RELEASE';
ALTER TYPE "LedgerKind" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_HOLD_REFUND';

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_PROCESSING';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_REFUNDED';

CREATE TYPE "AgentTaskStatus" AS ENUM ('OFFERED', 'CLAIMED', 'COMPLETED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "ProviderCallbackType" AS ENUM ('BET', 'WIN', 'ROLLBACK', 'BALANCE');
CREATE TYPE "ProviderTransactionStatus" AS ENUM ('APPLIED', 'REJECTED', 'ROLLED_BACK');

-- ─────────────────────────── AGENT AVAILABILITY ──────────────────────────────
ALTER TABLE "AgentProfile" ADD COLUMN "acceptingTasks" BOOLEAN NOT NULL DEFAULT true;

-- ────────────────────────────── AGENT TASKS ──────────────────────────────────
CREATE TABLE "AgentTask" (
  "id"             UUID NOT NULL,
  "agentProfileId" UUID NOT NULL,
  "depositId"      UUID,
  "withdrawalId"   UUID,
  "status"         "AgentTaskStatus" NOT NULL DEFAULT 'CLAIMED',
  "slaDeadline"    TIMESTAMP(3),
  "assignedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt"      TIMESTAMP(3),
  "completedAt"    TIMESTAMP(3),
  "reassignCount"  INTEGER NOT NULL DEFAULT 0,
  "note"           TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AgentTask_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentTask_depositId_key" ON "AgentTask" ("depositId");
CREATE UNIQUE INDEX "AgentTask_withdrawalId_key" ON "AgentTask" ("withdrawalId");
CREATE INDEX "AgentTask_agentProfileId_status_idx" ON "AgentTask" ("agentProfileId", "status");
CREATE INDEX "AgentTask_status_slaDeadline_idx" ON "AgentTask" ("status", "slaDeadline");

ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_agentProfileId_fkey"
  FOREIGN KEY ("agentProfileId") REFERENCES "AgentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_depositId_fkey"
  FOREIGN KEY ("depositId") REFERENCES "DepositRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_withdrawalId_fkey"
  FOREIGN KEY ("withdrawalId") REFERENCES "WithdrawalRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───────────────────────── PLAYER PAYOUT ACCOUNTS ────────────────────────────
CREATE TABLE "PlayerPayoutAccount" (
  "id"            UUID NOT NULL,
  "playerId"      UUID NOT NULL,
  "method"        "PaymentMethod" NOT NULL,
  "provider"      TEXT,
  "accountName"   TEXT NOT NULL,
  "accountNumber" TEXT NOT NULL,
  "isDefault"     BOOLEAN NOT NULL DEFAULT false,
  "isActive"      BOOLEAN NOT NULL DEFAULT true,
  "verifiedAt"    TIMESTAMP(3),
  "lastUsedAt"    TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PlayerPayoutAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlayerPayoutAccount_playerId_method_accountNumber_key"
  ON "PlayerPayoutAccount" ("playerId", "method", "accountNumber");
CREATE INDEX "PlayerPayoutAccount_playerId_isActive_idx"
  ON "PlayerPayoutAccount" ("playerId", "isActive");

ALTER TABLE "PlayerPayoutAccount" ADD CONSTRAINT "PlayerPayoutAccount_playerId_fkey"
  FOREIGN KEY ("playerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────── MEDIA ASSETS ────────────────────────────────
CREATE TABLE "MediaAsset" (
  "id"           UUID NOT NULL,
  "sha256"       TEXT NOT NULL,
  "storageKey"   TEXT NOT NULL,
  "mimeType"     TEXT NOT NULL,
  "byteSize"     INTEGER NOT NULL,
  "originalName" TEXT,
  "purpose"      TEXT NOT NULL DEFAULT 'proof',
  "uploadedById" UUID,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MediaAsset_sha256_key" ON "MediaAsset" ("sha256");
CREATE UNIQUE INDEX "MediaAsset_storageKey_key" ON "MediaAsset" ("storageKey");
CREATE INDEX "MediaAsset_uploadedById_createdAt_idx" ON "MediaAsset" ("uploadedById", "createdAt");

ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_uploadedById_fkey"
  FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ────────────────────────── WITHDRAWAL PROOFS ────────────────────────────────
ALTER TABLE "WithdrawalRequest" ADD COLUMN "payoutAccountId" UUID;
ALTER TABLE "WithdrawalRequest" ADD COLUMN "proofRequired" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "WithdrawalRequest" ADD COLUMN "holdAt" TIMESTAMP(3);

ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_payoutAccountId_fkey"
  FOREIGN KEY ("payoutAccountId") REFERENCES "PlayerPayoutAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "WithdrawalProof" (
  "id"              UUID NOT NULL,
  "withdrawalId"    UUID NOT NULL,
  "agentProfileId"  UUID,
  "submittedById"   UUID,
  "method"          "PaymentMethod" NOT NULL,
  "reference"       TEXT,
  "paidAmount"      BIGINT,
  "currency"        TEXT NOT NULL DEFAULT 'ETB',
  "senderAccount"   TEXT,
  "receiverAccount" TEXT,
  "paidAt"          TIMESTAMP(3),
  "mediaAssetId"    UUID,
  "notes"           TEXT,
  "status"          "VerificationStatus" NOT NULL DEFAULT 'PENDING',
  "message"         TEXT,
  "reviewedById"    UUID,
  "reviewedAt"      TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WithdrawalProof_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WithdrawalProof_withdrawalId_createdAt_idx" ON "WithdrawalProof" ("withdrawalId", "createdAt");
CREATE INDEX "WithdrawalProof_status_createdAt_idx" ON "WithdrawalProof" ("status", "createdAt");
CREATE INDEX "WithdrawalProof_reference_idx" ON "WithdrawalProof" ("reference");

ALTER TABLE "WithdrawalProof" ADD CONSTRAINT "WithdrawalProof_withdrawalId_fkey"
  FOREIGN KEY ("withdrawalId") REFERENCES "WithdrawalRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WithdrawalProof" ADD CONSTRAINT "WithdrawalProof_agentProfileId_fkey"
  FOREIGN KEY ("agentProfileId") REFERENCES "AgentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WithdrawalProof" ADD CONSTRAINT "WithdrawalProof_submittedById_fkey"
  FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WithdrawalProof" ADD CONSTRAINT "WithdrawalProof_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WithdrawalProof" ADD CONSTRAINT "WithdrawalProof_mediaAssetId_fkey"
  FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ───────────────────────────── PROVIDER CAPS ─────────────────────────────────
ALTER TABLE "GameProvider" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'ETB';
ALTER TABLE "GameProvider" ADD COLUMN "maxWin" BIGINT;
ALTER TABLE "ProviderGame" ADD COLUMN "maxWin" BIGINT;

-- ──────────────────────── PROVIDER CALLBACK AUDIT ────────────────────────────
CREATE TABLE "ProviderCallbackLog" (
  "id"                UUID NOT NULL,
  "providerCode"      TEXT NOT NULL,
  "type"              "ProviderCallbackType",
  "externalTxnId"     TEXT,
  "externalSessionId" TEXT,
  "signatureValid"    BOOLEAN NOT NULL,
  "httpStatus"        INTEGER,
  "amount"            BIGINT,
  "currency"          TEXT,
  "payload"           JSONB NOT NULL,
  "error"             TEXT,
  "ip"                TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProviderCallbackLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProviderCallbackLog_providerCode_createdAt_idx"
  ON "ProviderCallbackLog" ("providerCode", "createdAt");
CREATE INDEX "ProviderCallbackLog_externalTxnId_idx" ON "ProviderCallbackLog" ("externalTxnId");

ALTER TABLE "ProviderCallbackLog" ADD CONSTRAINT "ProviderCallbackLog_providerCode_fkey"
  FOREIGN KEY ("providerCode") REFERENCES "GameProvider"("code") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProviderTransaction" (
  "id"            UUID NOT NULL,
  "providerCode"  TEXT NOT NULL,
  "type"          "ProviderCallbackType" NOT NULL,
  "externalTxnId" TEXT NOT NULL,
  "userId"        UUID,
  "sessionId"     UUID,
  "gameId"        UUID,
  "amount"        BIGINT NOT NULL,
  "currency"      TEXT NOT NULL,
  "status"        "ProviderTransactionStatus" NOT NULL DEFAULT 'APPLIED',
  "ledgerId"      UUID,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProviderTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderTransaction_providerCode_externalTxnId_type_key"
  ON "ProviderTransaction" ("providerCode", "externalTxnId", "type");
CREATE INDEX "ProviderTransaction_providerCode_createdAt_idx"
  ON "ProviderTransaction" ("providerCode", "createdAt");
CREATE INDEX "ProviderTransaction_userId_createdAt_idx"
  ON "ProviderTransaction" ("userId", "createdAt");

ALTER TABLE "ProviderTransaction" ADD CONSTRAINT "ProviderTransaction_providerCode_fkey"
  FOREIGN KEY ("providerCode") REFERENCES "GameProvider"("code") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderTransaction" ADD CONSTRAINT "ProviderTransaction_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProviderTransaction" ADD CONSTRAINT "ProviderTransaction_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "ProviderSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
