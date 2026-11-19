-- CBE's app receipt API is down. The parser now reads the legacy branch
-- receipt PDF, keyed by the FT reference and the last eight digits of the
-- receiving account. The lookup therefore needs the receiving-account suffix
-- (derived server-side from the agent's payment account), and the reference
-- is no longer opaque: the bank prints it on the receipt and the gate must
-- match it.
UPDATE "DepositProvider"
SET "accountDigits" = 8,
    "opaqueReference" = false,
    "endpoint" = 'https://apps.cbe.com.et:100/BranchReceipt/{ref}&{account}',
    "refHint" = 'FT reference from the CBE receipt, e.g. FT26266ZN54F',
    "instructions" = 'Transfer to the agent''s CBE account, then enter the FT reference from the receipt.',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'cbe';
