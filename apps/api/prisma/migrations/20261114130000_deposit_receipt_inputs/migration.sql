-- Extra lookup inputs for receipt providers that need them:
-- BOA wants the last 5 digits of an account, CBE Birr the payer phone.
ALTER TABLE "DepositRequest" ADD COLUMN     "receiptAccount" TEXT,
ADD COLUMN     "receiptPhone" TEXT;
