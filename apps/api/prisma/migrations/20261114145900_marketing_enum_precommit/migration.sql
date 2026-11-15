-- PostgreSQL refuses to use an enum value in the same transaction that adds it
-- ("unsafe use of new value ... New enum values must be committed before they
-- can be used"). Prisma wraps each migration file in one transaction, so the
-- marketing migration cannot both add these values and reference
-- 'AFFILIATE_COMMISSION' in its partial index. This no-op split commits the
-- values first; the later migration's ALTER TYPE ... IF NOT EXISTS lines become
-- no-ops.

ALTER TYPE "AccountCode" ADD VALUE IF NOT EXISTS 'BONUS';
ALTER TYPE "AccountCode" ADD VALUE IF NOT EXISTS 'BONUS_EXPENSE';
ALTER TYPE "LedgerKind" ADD VALUE IF NOT EXISTS 'BONUS_GRANT';
ALTER TYPE "LedgerKind" ADD VALUE IF NOT EXISTS 'BONUS_CONVERT';
ALTER TYPE "LedgerKind" ADD VALUE IF NOT EXISTS 'BONUS_FORFEIT';
ALTER TYPE "LedgerKind" ADD VALUE IF NOT EXISTS 'AFFILIATE_COMMISSION';
ALTER TYPE "LedgerKind" ADD VALUE IF NOT EXISTS 'PROVIDER_BET';
ALTER TYPE "LedgerKind" ADD VALUE IF NOT EXISTS 'PROVIDER_WIN';
ALTER TYPE "LedgerKind" ADD VALUE IF NOT EXISTS 'PROVIDER_ROLLBACK';
