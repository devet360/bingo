-- Players no longer choose a paying agent. A withdrawal is created unassigned
-- and any active agent may settle its payout code.
ALTER TABLE "WithdrawalRequest" ALTER COLUMN "agentProfileId" DROP NOT NULL;
ALTER TABLE "WithdrawalRequest" DROP CONSTRAINT "WithdrawalRequest_agentProfileId_fkey";
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_agentProfileId_fkey"
  FOREIGN KEY ("agentProfileId") REFERENCES "AgentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
