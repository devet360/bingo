import { AccountCode, AccountOwnerKind, type Prisma } from '@prisma/client';

const USER_CODES: AccountCode[] = [
  AccountCode.AVAILABLE,
  AccountCode.ESCROW,
  AccountCode.LOCKED,
  AccountCode.BONUS,
];
const AGENT_CODES: AccountCode[] = [AccountCode.FLOAT, AccountCode.FLOAT_ESCROW, AccountCode.COMMISSION];

/** Idempotent: safe to call on every login for accounts created before provisioning existed. */
export async function provisionUserAccounts(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  await tx.wallet.upsert({ where: { userId }, create: { userId }, update: {} });
  for (const code of USER_CODES) {
    await tx.ledgerAccount.upsert({
      where: { ownerKind_ownerId_code: { ownerKind: AccountOwnerKind.USER, ownerId: userId, code } },
      create: { ownerKind: AccountOwnerKind.USER, ownerId: userId, code },
      update: {},
    });
  }
}

export async function provisionAgentAccounts(
  tx: Prisma.TransactionClient,
  agentProfileId: string,
): Promise<void> {
  for (const code of AGENT_CODES) {
    await tx.ledgerAccount.upsert({
      where: {
        ownerKind_ownerId_code: { ownerKind: AccountOwnerKind.AGENT, ownerId: agentProfileId, code },
      },
      create: { ownerKind: AccountOwnerKind.AGENT, ownerId: agentProfileId, code },
      update: {},
    });
  }
}
