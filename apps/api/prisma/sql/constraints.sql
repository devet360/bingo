-- ═══════════════════════════════════════════════════════════════════════════════
-- Bingo Casino Platform — database invariants Prisma schema cannot express.
--
-- Apply AFTER `prisma migrate dev`:
--   npm run db:constraints
--
-- The script is idempotent: safe to re-run on every deploy.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────── 1. Ledger is append-only ─────────────────────────
CREATE OR REPLACE FUNCTION deny_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; correction requires a reversing entry', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "LedgerEntry_block_update" ON "LedgerEntry";
CREATE TRIGGER "LedgerEntry_block_update"
  BEFORE UPDATE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION deny_ledger_mutation();

DROP TRIGGER IF EXISTS "LedgerEntry_block_delete" ON "LedgerEntry";
CREATE TRIGGER "LedgerEntry_block_delete"
  BEFORE DELETE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION deny_ledger_mutation();

DROP TRIGGER IF EXISTS "TransactionLedger_block_update" ON "TransactionLedger";
CREATE TRIGGER "TransactionLedger_block_update"
  BEFORE UPDATE ON "TransactionLedger"
  FOR EACH ROW EXECUTE FUNCTION deny_ledger_mutation();

DROP TRIGGER IF EXISTS "TransactionLedger_block_delete" ON "TransactionLedger";
CREATE TRIGGER "TransactionLedger_block_delete"
  BEFORE DELETE ON "TransactionLedger"
  FOR EACH ROW EXECUTE FUNCTION deny_ledger_mutation();

-- ───────────────── 2. Every journal entry must net to zero at commit ──────────
CREATE OR REPLACE FUNCTION assert_ledger_balanced() RETURNS trigger AS $$
DECLARE
  total NUMERIC;
BEGIN
  SELECT COALESCE(SUM("amount"), 0) INTO total
  FROM "LedgerEntry"
  WHERE "ledgerId" = NEW."ledgerId";

  IF total <> 0 THEN
    RAISE EXCEPTION 'TransactionLedger % is unbalanced by % minor units', NEW."ledgerId", total;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "LedgerEntry_assert_balanced" ON "LedgerEntry";
CREATE CONSTRAINT TRIGGER "LedgerEntry_assert_balanced"
  AFTER INSERT ON "LedgerEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_balanced();

-- ─────────────────────────── 3. Balance sanity checks ─────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Wallet_balances_non_negative') THEN
    ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_balances_non_negative"
      CHECK ("available" >= 0 AND "escrow" >= 0 AND "locked" >= 0 AND "bonus" >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AgentProfile_balances_non_negative') THEN
    ALTER TABLE "AgentProfile" ADD CONSTRAINT "AgentProfile_balances_non_negative"
      CHECK ("floatAvailable" >= 0 AND "floatEscrow" >= 0 AND "commissionEarned" >= 0);
  END IF;

  -- The external settlement bridge and expense accounts may carry debit balances.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LedgerAccount_negative_balance_guard') THEN
    ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_negative_balance_guard"
      CHECK ("balance" >= 0 OR "code" IN ('SUSPENSE', 'COMMISSION_EXPENSE', 'BONUS_EXPENSE'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LedgerEntry_amount_non_zero') THEN
    ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_amount_non_zero"
      CHECK ("amount" <> 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AgentRating_score_range') THEN
    ALTER TABLE "AgentRating" ADD CONSTRAINT "AgentRating_score_range"
      CHECK ("score" BETWEEN 1 AND 5);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AgentProfile_bps_range') THEN
    ALTER TABLE "AgentProfile" ADD CONSTRAINT "AgentProfile_bps_range"
      CHECK ("depositCommissionBps" BETWEEN 0 AND 10000
         AND "withdrawalCommissionBps" BETWEEN 0 AND 10000);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AgentProfile_auto_deposit_limit') THEN
    ALTER TABLE "AgentProfile" ADD CONSTRAINT "AgentProfile_auto_deposit_limit"
      CHECK ("autoDepositThreshold" IS NULL OR "autoDepositThreshold" > 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AgentProfile_auto_deposit_requires_limit') THEN
    ALTER TABLE "AgentProfile" ADD CONSTRAINT "AgentProfile_auto_deposit_requires_limit"
      CHECK (NOT "autoDepositEnabled" OR "autoDepositThreshold" IS NOT NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DepositProvider_amount_range') THEN
    ALTER TABLE "DepositProvider" ADD CONSTRAINT "DepositProvider_amount_range"
      CHECK (("minAmount" IS NULL OR "minAmount" > 0)
         AND ("maxAmount" IS NULL OR "maxAmount" > 0)
         AND ("minAmount" IS NULL OR "maxAmount" IS NULL OR "minAmount" <= "maxAmount"));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ReceiptVerification_attempts_range') THEN
    ALTER TABLE "ReceiptVerification" ADD CONSTRAINT "ReceiptVerification_attempts_range"
      CHECK ("attempts" >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CommissionRule_bps_range') THEN
    ALTER TABLE "CommissionRule" ADD CONSTRAINT "CommissionRule_bps_range"
      CHECK ("depositBps" BETWEEN 0 AND 10000 AND "withdrawalBps" BETWEEN 0 AND 10000);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BingoRoom_rake_bps_range') THEN
    ALTER TABLE "BingoRoom" ADD CONSTRAINT "BingoRoom_rake_bps_range"
      CHECK ("rakeBps" BETWEEN 0 AND 10000);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BingoRoom_card_limits') THEN
    ALTER TABLE "BingoRoom" ADD CONSTRAINT "BingoRoom_card_limits"
      CHECK ("maxCardsPerPlayer" BETWEEN 1 AND 4 AND "minPlayersToStart" >= 1);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DepositRequest_amount_positive') THEN
    ALTER TABLE "DepositRequest" ADD CONSTRAINT "DepositRequest_amount_positive"
      CHECK ("amount" > 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WithdrawalRequest_amounts_positive') THEN
    ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_amounts_positive"
      CHECK ("amount" > 0 AND "fee" >= 0 AND "netAmount" >= 0 AND "fee" + "netAmount" = "amount");
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BingoCard_stake_positive') THEN
    ALTER TABLE "BingoCard" ADD CONSTRAINT "BingoCard_stake_positive"
      CHECK ("stake" > 0 AND "cardIndex" BETWEEN 0 AND 3);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BingoRound_pot_consistency') THEN
    ALTER TABLE "BingoRound" ADD CONSTRAINT "BingoRound_pot_consistency"
      CHECK ("grossPot" >= 0 AND "rakeAmount" >= 0 AND "prizePool" >= 0
         AND "grossPot" = "rakeAmount" + "prizePool");
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OtpCode_attempts_range') THEN
    ALTER TABLE "OtpCode" ADD CONSTRAINT "OtpCode_attempts_range"
      CHECK ("attempts" >= 0 AND "maxAttempts" BETWEEN 1 AND 10);
  END IF;
END $$;

-- ─────────────── 4. One journal per business event, per ledger kind ───────────
-- Card purchases are many-per-round (one journal per buyer batch); referral
-- payouts are one journal per referrer per round. Every other kind is
-- exactly-once per referenced entity, so the guard excludes those two.
DROP INDEX IF EXISTS "TransactionLedger_ref_kind_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "TransactionLedger_ref_kind_unique"
  ON "TransactionLedger" ("refType", "refId", "kind")
  WHERE "refId" IS NOT NULL AND "kind" NOT IN ('CARD_PURCHASE', 'AFFILIATE_COMMISSION');

-- At most one live round per room: prevents two sockets starting competing rounds.
CREATE UNIQUE INDEX IF NOT EXISTS "BingoRound_one_active_per_room"
  ON "BingoRound" ("roomId")
  WHERE "status" IN ('WAITING', 'LOCKED', 'PLAYING', 'CLAIM_VERIFICATION');

-- A player cannot hold two live withdrawal requests at once.
CREATE UNIQUE INDEX IF NOT EXISTS "WithdrawalRequest_one_open_per_player"
  ON "WithdrawalRequest" ("playerId")
  WHERE "status" = 'ESCROWED';

-- 6-digit namespaces are recycled: uniqueness is required only among open requests.
CREATE UNIQUE INDEX IF NOT EXISTS "DepositRequest_open_code_unique"
  ON "DepositRequest" ("code")
  WHERE "status" IN ('PENDING', 'PROCESSING');

-- A bank receipt can move money once. ReceiptVerification's unique key already
-- serialises attempts; this is the belt-and-braces constraint on the money row.
CREATE UNIQUE INDEX IF NOT EXISTS "DepositRequest_credited_receipt_unique"
  ON "DepositRequest" ("providerCode", "receiptReference")
  WHERE "receiptReference" IS NOT NULL AND "status" = 'CREDITED';

CREATE UNIQUE INDEX IF NOT EXISTS "WithdrawalRequest_open_payout_code_unique"
  ON "WithdrawalRequest" ("payoutCode")
  WHERE "status" = 'ESCROWED';

-- ───────────────────────── 5. Reconciliation helpers ─────────────────────────
CREATE OR REPLACE VIEW "v_account_balances" AS
SELECT
  a."id",
  a."ownerKind",
  a."ownerId",
  a."code",
  a."balance"                                AS "cachedBalance",
  COALESCE(SUM(e."amount"), 0)               AS "journalBalance",
  a."balance" - COALESCE(SUM(e."amount"), 0) AS "drift"
FROM "LedgerAccount" a
LEFT JOIN "LedgerEntry" e ON e."accountId" = a."id"
GROUP BY a."id";

-- Empty view = every cached balance matches the journal.
CREATE OR REPLACE VIEW "v_account_drift" AS
SELECT * FROM "v_account_balances" WHERE "drift" <> 0;
