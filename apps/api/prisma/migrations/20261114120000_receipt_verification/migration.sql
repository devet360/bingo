-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'VERIFIED', 'FAILED', 'MANUAL');

-- CreateEnum
CREATE TYPE "VerificationSource" AS ENUM ('SERVER', 'CLIENT', 'RELAY');

-- AlterTable
ALTER TABLE "AgentProfile" ADD COLUMN     "autoDepositEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoDepositThreshold" BIGINT;

-- AlterTable
ALTER TABLE "DepositRequest" ADD COLUMN     "autoVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "providerCode" TEXT,
ADD COLUMN     "receiptReference" TEXT,
ADD COLUMN     "verificationMessage" TEXT,
ADD COLUMN     "verificationSource" "VerificationSource",
ADD COLUMN     "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "telegramLinkExpiresAt" TIMESTAMP(3),
ADD COLUMN     "telegramLinkToken" TEXT;

-- CreateTable
CREATE TABLE "DepositProvider" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "parser" TEXT,
    "endpoint" TEXT,
    "refPattern" TEXT,
    "refHint" TEXT,
    "accountDigits" INTEGER,
    "requiresPhone" BOOLEAN NOT NULL DEFAULT false,
    "opaqueReference" BOOLEAN NOT NULL DEFAULT false,
    "clientSide" BOOLEAN NOT NULL DEFAULT false,
    "supported" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "instructions" TEXT,
    "minAmount" BIGINT,
    "maxAmount" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepositProvider_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "ReceiptVerification" (
    "id" UUID NOT NULL,
    "providerCode" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "depositId" UUID,
    "status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "source" "VerificationSource",
    "amount" BIGINT,
    "currency" TEXT,
    "senderName" TEXT,
    "senderAccount" TEXT,
    "receiverName" TEXT,
    "receiverAccount" TEXT,
    "transactionDate" TEXT,
    "transactionStatus" TEXT,
    "message" TEXT,
    "detail" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceiptVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DepositProvider_enabled_method_sortOrder_idx" ON "DepositProvider"("enabled", "method", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptVerification_depositId_key" ON "ReceiptVerification"("depositId");

-- CreateIndex
CREATE INDEX "ReceiptVerification_status_createdAt_idx" ON "ReceiptVerification"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptVerification_providerCode_reference_key" ON "ReceiptVerification"("providerCode", "reference");

-- CreateIndex
CREATE INDEX "DepositRequest_providerCode_receiptReference_idx" ON "DepositRequest"("providerCode", "receiptReference");

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramLinkToken_key" ON "User"("telegramLinkToken");

-- AddForeignKey
ALTER TABLE "DepositRequest" ADD CONSTRAINT "DepositRequest_providerCode_fkey" FOREIGN KEY ("providerCode") REFERENCES "DepositProvider"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptVerification" ADD CONSTRAINT "ReceiptVerification_providerCode_fkey" FOREIGN KEY ("providerCode") REFERENCES "DepositProvider"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptVerification" ADD CONSTRAINT "ReceiptVerification_depositId_fkey" FOREIGN KEY ("depositId") REFERENCES "DepositRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────── Provider catalogue ──────────────────────────────
-- Every live cheki provider is seeded. `supported` mirrors the parsers that
-- ship in apps/api/src/services/receipts/parsers. `enabled` starts false for
-- the in-development ones so an admin turns them on deliberately.
INSERT INTO "DepositProvider"
  ("code","name","method","parser","endpoint","refPattern","refHint","accountDigits","requiresPhone","opaqueReference","clientSide","supported","enabled","sortOrder","instructions","minAmount","maxAmount","updatedAt")
VALUES
  ('telebirr','Telebirr','MOBILE_MONEY','telebirr','https://transactioninfo.ethiotelecom.et/receipt/{ref}','^[A-Z0-9]{10}$','10 letters or digits, e.g. DET0…',NULL,false,false,true,true,true,10,'Pay the agent''s Telebirr number, then enter the transaction number from the SMS or receipt.',100,NULL,CURRENT_TIMESTAMP),
  ('mpesa','M-Pesa Ethiopia','MOBILE_MONEY','mpesa','https://m-pesabusiness.safaricom.et/api/receipt/getReceipt?trxNo={ref}','^[A-Z0-9]{6,20}$','Transaction id from the M-Pesa SMS',NULL,false,false,true,true,true,20,'Pay the agent''s M-Pesa number, then enter the transaction id from the SMS.',100,NULL,CURRENT_TIMESTAMP),
  ('cbe','Commercial Bank of Ethiopia','BANK_TRANSFER','cbe','https://mb.cbe.com.et/api/v1/transactions/public/transaction-detail/{ref}',NULL,'FT reference or the receipt id from the link',NULL,false,true,false,true,true,30,'Transfer to the agent''s CBE account, then paste the FT reference or the receipt link.',100,NULL,CURRENT_TIMESTAMP),
  ('boa','Bank of Abyssinia','BANK_TRANSFER','boa','https://cs.bankofabyssinia.com/api/onlineSlip/getDetails/?id={ref}{account}','^[A-Z]{2}[A-Z0-9]{4,30}$','FT reference, e.g. FT25…',5,false,false,false,true,true,40,'Enter the Abyssinia reference and the last 5 digits of the receiving account.',100,NULL,CURRENT_TIMESTAMP),
  ('dashen','Dashen Bank','BANK_TRANSFER','dashen','https://receipts.dashenbanksc.com/receipt/{ref}','^[A-Z0-9]{16}$','16-character FT reference',NULL,false,false,false,true,true,50,'Enter the 16-character FT reference from the Dashen receipt.',100,NULL,CURRENT_TIMESTAMP),
  ('awash','Awash Bank','BANK_TRANSFER','awash','https://awashpay.awashbank.com:8225/-{ref}','^[A-Za-z0-9_-]{4,64}$','Share id at the end of the Awash receipt link',NULL,false,true,false,true,true,60,'Paste the Awash receipt link or its share id.',100,NULL,CURRENT_TIMESTAMP),
  ('cbebirr','CBE Birr','MOBILE_MONEY','cbebirr','https://cbepay1.cbe.com.et/aureceipt?TID={ref}&PH={phone}','^[A-Z0-9]{10,11}$','10-11 character TID from the CBE Birr receipt',NULL,true,true,false,true,true,70,'Enter the TID and the payer phone number used for the transfer.',100,NULL,CURRENT_TIMESTAMP),
  ('siinqee','Siinqee Bank','MOBILE_MONEY','siinqee','https://receipt.ebirr.com/siinqee/{ref}','^[A-Za-z0-9_-]{4,128}$','Token at the end of the receipt.ebirr.com/siinqee/ link',NULL,false,true,false,true,true,80,'Paste the full Siinqee receipt link.',100,NULL,CURRENT_TIMESTAMP),
  ('nib','Nib International Bank','MOBILE_MONEY','ebirr','https://receipt.ebirr.com/nib/{ref}','^[A-Za-z0-9_-]{4,128}$','Token at the end of the receipt.ebirr.com/nib/ link',NULL,false,true,false,true,false,90,'Paste the full Nib receipt link.',100,NULL,CURRENT_TIMESTAMP),
  ('wegagen','Wegagen Bank','MOBILE_MONEY','ebirr','https://receipt.ebirr.com/wegagen/{ref}','^[A-Za-z0-9_-]{4,128}$','Token at the end of the receipt.ebirr.com/wegagen/ link',NULL,false,true,false,true,false,100,'Paste the full Wegagen receipt link.',100,NULL,CURRENT_TIMESTAMP),
  ('ahadu','Ahadu Bank','MOBILE_MONEY','ebirr','https://receipt.ebirr.com/ahadu/{ref}','^[A-Za-z0-9_-]{4,128}$','Token at the end of the receipt.ebirr.com/ahadu/ link',NULL,false,true,false,true,false,110,'Paste the full Ahadu receipt link.',100,NULL,CURRENT_TIMESTAMP),
  ('kaafimf','KAAFI Microfinance','MOBILE_MONEY','ebirr','https://receipt.ebirr.com/kaafimf/{ref}','^[A-Za-z0-9_-]{4,128}$','Token at the end of the receipt.ebirr.com/kaafimf/ link',NULL,false,true,false,true,false,120,'Paste the full KAAFI receipt link.',100,NULL,CURRENT_TIMESTAMP),
  ('bunna','Bunna International Bank','BANK_TRANSFER','bunna','https://online.bunnabanksc.com/st_backend/api/v1/advice?data={ref}','^[A-Za-z0-9+/=_-]{16,400}$','Paste the whole Bunna receipt link',NULL,false,true,false,true,true,130,'Paste the Bunna receipt link or the token after #/receipt/.',100,NULL,CURRENT_TIMESTAMP),
  ('zamzam','ZamZam Bank','BANK_TRANSFER','zamzam','https://receipt-backend.zamzambank.com.et/api/v1/invoice/{ref}','^[0-9]{1,12}$','Receipt number from the ZamZam link',NULL,false,true,false,true,true,140,'Enter the receipt number from the ZamZam receipt link.',100,NULL,CURRENT_TIMESTAMP),
  ('zemen','Zemen Bank','BANK_TRANSFER','zemen','https://share.zemenbank.com/rt/{ref}/pdf','^[A-Za-z0-9_-]{1,64}$','Reference from the Zemen receipt link',NULL,false,false,false,true,false,150,'Paste the Zemen receipt link.',100,NULL,CURRENT_TIMESTAMP),
  ('abay','Abay Bank','BANK_TRANSFER',NULL,NULL,NULL,NULL,NULL,false,false,false,false,false,200,NULL,NULL,NULL,CURRENT_TIMESTAMP),
  ('addis','Addis International Bank','BANK_TRANSFER',NULL,NULL,NULL,NULL,NULL,false,false,false,false,false,210,NULL,NULL,NULL,CURRENT_TIMESTAMP),
  ('amhara','Amhara Bank','BANK_TRANSFER',NULL,NULL,NULL,NULL,NULL,false,false,false,false,false,220,NULL,NULL,NULL,CURRENT_TIMESTAMP),
  ('berhan','Berhan International Bank','BANK_TRANSFER',NULL,NULL,NULL,NULL,NULL,false,false,false,false,false,230,NULL,NULL,NULL,CURRENT_TIMESTAMP),
  ('enat','Enat Bank','BANK_TRANSFER',NULL,NULL,NULL,NULL,NULL,false,false,false,false,false,240,NULL,NULL,NULL,CURRENT_TIMESTAMP),
  ('global','Global Bank Ethiopia','BANK_TRANSFER',NULL,NULL,NULL,NULL,NULL,false,false,false,false,false,250,NULL,NULL,NULL,CURRENT_TIMESTAMP),
  ('lion','Lion International Bank','BANK_TRANSFER',NULL,NULL,NULL,NULL,NULL,false,false,false,false,false,260,NULL,NULL,NULL,CURRENT_TIMESTAMP),
  ('oromia','Oromia International Bank','BANK_TRANSFER',NULL,NULL,NULL,NULL,NULL,false,false,false,false,false,270,NULL,NULL,NULL,CURRENT_TIMESTAMP),
  ('hibret','Hibret Bank','BANK_TRANSFER',NULL,NULL,NULL,NULL,NULL,false,false,false,false,false,280,NULL,NULL,NULL,CURRENT_TIMESTAMP),
  ('hijra','Hijra Bank','BANK_TRANSFER',NULL,NULL,NULL,NULL,NULL,false,false,false,false,false,290,NULL,NULL,NULL,CURRENT_TIMESTAMP),
  ('shabelle','Shabelle Bank','BANK_TRANSFER',NULL,NULL,NULL,NULL,NULL,false,false,false,false,false,300,NULL,NULL,NULL,CURRENT_TIMESTAMP),
  ('goh','Goh Betoch Bank','BANK_TRANSFER',NULL,NULL,NULL,NULL,NULL,false,false,false,false,false,310,NULL,NULL,NULL,CURRENT_TIMESTAMP),
  ('tsedey','Tsedey Bank','BANK_TRANSFER',NULL,NULL,NULL,NULL,NULL,false,false,false,false,false,320,NULL,NULL,NULL,CURRENT_TIMESTAMP),
  ('gadaa','Gadaa Bank','BANK_TRANSFER',NULL,NULL,NULL,NULL,NULL,false,false,false,false,false,330,NULL,NULL,NULL,CURRENT_TIMESTAMP),
  ('rammis','Rammis Bank','BANK_TRANSFER',NULL,NULL,NULL,NULL,NULL,false,false,false,false,false,340,NULL,NULL,NULL,CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

