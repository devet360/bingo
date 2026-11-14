-- Marketing surfaces (banners/popups), promotional bonuses with wagering,
-- referral rake commissions, and the external game-provider seam.

-- ─────────────────────────────── ENUMS ───────────────────────────────────────
CREATE TYPE "CampaignKind" AS ENUM ('BANNER', 'POPUP');
CREATE TYPE "CampaignAudience" AS ENUM ('ALL', 'PLAYERS', 'AGENTS');
CREATE TYPE "BonusKind" AS ENUM ('PROMO_CODE', 'ADMIN_GRANT');
CREATE TYPE "BonusStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'EXPIRED', 'CANCELLED');
CREATE TYPE "ProviderKind" AS ENUM ('NATIVE', 'AGGREGATOR');
CREATE TYPE "ProviderSessionStatus" AS ENUM ('OPEN', 'CLOSED', 'EXPIRED');

ALTER TYPE "AccountCode" ADD VALUE IF NOT EXISTS 'BONUS';
ALTER TYPE "AccountCode" ADD VALUE IF NOT EXISTS 'BONUS_EXPENSE';
ALTER TYPE "LedgerKind" ADD VALUE IF NOT EXISTS 'BONUS_GRANT';
ALTER TYPE "LedgerKind" ADD VALUE IF NOT EXISTS 'BONUS_CONVERT';
ALTER TYPE "LedgerKind" ADD VALUE IF NOT EXISTS 'BONUS_FORFEIT';
ALTER TYPE "LedgerKind" ADD VALUE IF NOT EXISTS 'AFFILIATE_COMMISSION';
ALTER TYPE "LedgerKind" ADD VALUE IF NOT EXISTS 'PROVIDER_BET';
ALTER TYPE "LedgerKind" ADD VALUE IF NOT EXISTS 'PROVIDER_WIN';
ALTER TYPE "LedgerKind" ADD VALUE IF NOT EXISTS 'PROVIDER_ROLLBACK';

-- ─────────────────────────────── WALLET ──────────────────────────────────────
ALTER TABLE "Wallet" ADD COLUMN "bonus" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "Wallet" DROP CONSTRAINT IF EXISTS "Wallet_balances_non_negative";
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_balances_non_negative"
  CHECK ("available" >= 0 AND "escrow" >= 0 AND "locked" >= 0 AND "bonus" >= 0);

-- ────────────────────────────── CAMPAIGNS ────────────────────────────────────
CREATE TABLE "Campaign" (
  "id"           UUID NOT NULL,
  "kind"         "CampaignKind" NOT NULL,
  "audience"     "CampaignAudience" NOT NULL DEFAULT 'ALL',
  "locale"       TEXT NOT NULL DEFAULT 'en',
  "title"        TEXT NOT NULL,
  "body"         TEXT NOT NULL,
  "imageUrl"     TEXT,
  "linkUrl"      TEXT,
  "linkLabel"    TEXT,
  "enabled"      BOOLEAN NOT NULL DEFAULT true,
  "priority"     INTEGER NOT NULL DEFAULT 0,
  "dismissHours" INTEGER NOT NULL DEFAULT 24,
  "startsAt"     TIMESTAMP(3),
  "endsAt"       TIMESTAMP(3),
  "createdById"  UUID,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Campaign_enabled_kind_startsAt_endsAt_idx"
  ON "Campaign" ("enabled", "kind", "startsAt", "endsAt");

-- ───────────────────────── BONUS PROMOTIONS & GRANTS ─────────────────────────
CREATE TABLE "BonusPromotion" (
  "id"                 UUID NOT NULL,
  "code"               TEXT NOT NULL,
  "name"               TEXT NOT NULL,
  "percentBps"         INTEGER,
  "fixedAmount"        BIGINT,
  "maxBonus"           BIGINT,
  "minDeposit"         BIGINT,
  "wageringMultiplier" INTEGER NOT NULL DEFAULT 3,
  "expiresInDays"      INTEGER NOT NULL DEFAULT 7,
  "enabled"            BOOLEAN NOT NULL DEFAULT true,
  "startsAt"           TIMESTAMP(3),
  "endsAt"             TIMESTAMP(3),
  "maxRedemptions"     INTEGER,
  "redemptionCount"    INTEGER NOT NULL DEFAULT 0,
  "createdById"        UUID,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BonusPromotion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BonusPromotion_code_key" ON "BonusPromotion" ("code");
CREATE INDEX "BonusPromotion_enabled_startsAt_endsAt_idx"
  ON "BonusPromotion" ("enabled", "startsAt", "endsAt");

CREATE TABLE "Bonus" (
  "id"          UUID NOT NULL,
  "userId"      UUID NOT NULL,
  "promotionId" UUID,
  "grantedById" UUID,
  "kind"        "BonusKind" NOT NULL DEFAULT 'PROMO_CODE',
  "amount"      BIGINT NOT NULL,
  "wagered"     BIGINT NOT NULL DEFAULT 0,
  "target"      BIGINT NOT NULL,
  "multiplier"  INTEGER NOT NULL,
  "status"      "BonusStatus" NOT NULL DEFAULT 'ACTIVE',
  "expiresAt"   TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Bonus_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Bonus_userId_status_idx" ON "Bonus" ("userId", "status");
CREATE INDEX "Bonus_status_expiresAt_idx" ON "Bonus" ("status", "expiresAt");
CREATE INDEX "Bonus_promotionId_idx" ON "Bonus" ("promotionId");

ALTER TABLE "Bonus" ADD CONSTRAINT "Bonus_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Bonus" ADD CONSTRAINT "Bonus_grantedById_fkey"
  FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Bonus" ADD CONSTRAINT "Bonus_promotionId_fkey"
  FOREIGN KEY ("promotionId") REFERENCES "BonusPromotion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────── REFERRAL COMMISSIONS ───────────────────────────
CREATE TABLE "ReferralCommission" (
  "id"         UUID NOT NULL,
  "referrerId" UUID NOT NULL,
  "playerId"   UUID NOT NULL,
  "roundId"    UUID,
  "rakeBase"   BIGINT NOT NULL,
  "bps"        INTEGER NOT NULL,
  "amount"     BIGINT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ReferralCommission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReferralCommission_referrerId_playerId_roundId_key"
  ON "ReferralCommission" ("referrerId", "playerId", "roundId");
CREATE INDEX "ReferralCommission_referrerId_createdAt_idx"
  ON "ReferralCommission" ("referrerId", "createdAt");

ALTER TABLE "ReferralCommission" ADD CONSTRAINT "ReferralCommission_referrerId_fkey"
  FOREIGN KEY ("referrerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReferralCommission" ADD CONSTRAINT "ReferralCommission_playerId_fkey"
  FOREIGN KEY ("playerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ──────────────────────── EXTERNAL GAME PROVIDERS ───────────────────────────
CREATE TABLE "GameProvider" (
  "id"            UUID NOT NULL,
  "code"          TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "kind"          "ProviderKind" NOT NULL DEFAULT 'AGGREGATOR',
  "apiBaseUrl"    TEXT,
  "webhookSecret" TEXT,
  "enabled"       BOOLEAN NOT NULL DEFAULT false,
  "sortOrder"     INTEGER NOT NULL DEFAULT 0,
  "config"        JSONB,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "GameProvider_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GameProvider_code_key" ON "GameProvider" ("code");
CREATE INDEX "GameProvider_enabled_sortOrder_idx" ON "GameProvider" ("enabled", "sortOrder");

CREATE TABLE "ProviderGame" (
  "id"                UUID NOT NULL,
  "providerId"        UUID NOT NULL,
  "externalId"        TEXT NOT NULL,
  "name"              TEXT NOT NULL,
  "category"          TEXT,
  "thumbnailUrl"      TEXT,
  "launchUrlTemplate" TEXT,
  "minStake"          BIGINT,
  "maxStake"          BIGINT,
  "enabled"           BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"         INTEGER NOT NULL DEFAULT 0,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProviderGame_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderGame_providerId_externalId_key"
  ON "ProviderGame" ("providerId", "externalId");
CREATE INDEX "ProviderGame_providerId_enabled_sortOrder_idx"
  ON "ProviderGame" ("providerId", "enabled", "sortOrder");

ALTER TABLE "ProviderGame" ADD CONSTRAINT "ProviderGame_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "GameProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProviderSession" (
  "id"                UUID NOT NULL,
  "userId"            UUID NOT NULL,
  "providerId"        UUID NOT NULL,
  "gameId"            UUID,
  "externalSessionId" TEXT NOT NULL,
  "status"            "ProviderSessionStatus" NOT NULL DEFAULT 'OPEN',
  "launchUrl"         TEXT,
  "expiresAt"         TIMESTAMP(3) NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProviderSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderSession_externalSessionId_key"
  ON "ProviderSession" ("externalSessionId");
CREATE INDEX "ProviderSession_userId_status_idx" ON "ProviderSession" ("userId", "status");
CREATE INDEX "ProviderSession_providerId_status_idx"
  ON "ProviderSession" ("providerId", "status");

ALTER TABLE "ProviderSession" ADD CONSTRAINT "ProviderSession_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderSession" ADD CONSTRAINT "ProviderSession_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "GameProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderSession" ADD CONSTRAINT "ProviderSession_gameId_fkey"
  FOREIGN KEY ("gameId") REFERENCES "ProviderGame"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ──────────────────────── RANGE / SANITY CONSTRAINTS ────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BonusPromotion_terms_valid') THEN
    ALTER TABLE "BonusPromotion" ADD CONSTRAINT "BonusPromotion_terms_valid"
      CHECK (
        ("percentBps" IS NOT NULL) <> ("fixedAmount" IS NOT NULL)
        AND ("percentBps" IS NULL OR "percentBps" BETWEEN 1 AND 10000)
        AND ("fixedAmount" IS NULL OR "fixedAmount" > 0)
        AND ("maxBonus" IS NULL OR "maxBonus" > 0)
        AND ("minDeposit" IS NULL OR "minDeposit" >= 0)
        AND "wageringMultiplier" BETWEEN 1 AND 100
        AND "expiresInDays" BETWEEN 1 AND 365
        AND ("maxRedemptions" IS NULL OR "maxRedemptions" > 0)
        AND "redemptionCount" >= 0
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Bonus_amounts_valid') THEN
    ALTER TABLE "Bonus" ADD CONSTRAINT "Bonus_amounts_valid"
      CHECK ("amount" > 0 AND "wagered" >= 0 AND "target" > 0 AND "multiplier" BETWEEN 1 AND 100);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ReferralCommission_amounts_valid') THEN
    ALTER TABLE "ReferralCommission" ADD CONSTRAINT "ReferralCommission_amounts_valid"
      CHECK ("bps" BETWEEN 0 AND 10000 AND "rakeBase" >= 0 AND "amount" >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Campaign_window_valid') THEN
    ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_window_valid"
      CHECK ("dismissHours" >= 0 AND ("startsAt" IS NULL OR "endsAt" IS NULL OR "startsAt" < "endsAt"));
  END IF;
END $$;

-- A player holds at most one bonus under wagering at a time.
CREATE UNIQUE INDEX "Bonus_one_active_per_user"
  ON "Bonus" ("userId")
  WHERE "status" = 'ACTIVE';

-- Referral payouts are many-per-round (one per referrer), like card purchases.
DROP INDEX IF EXISTS "TransactionLedger_ref_kind_unique";
CREATE UNIQUE INDEX "TransactionLedger_ref_kind_unique"
  ON "TransactionLedger" ("refType", "refId", "kind")
  WHERE "refId" IS NOT NULL AND "kind" NOT IN ('CARD_PURCHASE', 'AFFILIATE_COMMISSION');
