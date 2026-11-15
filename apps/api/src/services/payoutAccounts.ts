import type { PaymentMethod, PlayerPayoutAccount } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { Errors } from '../lib/errors';
import { isUniqueViolation, runTransaction } from '../lib/tx';

export interface PayoutAccountInput {
  method: PaymentMethod;
  provider?: string | null;
  accountName: string;
  accountNumber: string;
  isDefault?: boolean;
}

export async function listPayoutAccounts(playerId: string): Promise<PlayerPayoutAccount[]> {
  return prisma.playerPayoutAccount.findMany({
    where: { playerId, isActive: true },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
}

export async function createPayoutAccount(
  playerId: string,
  input: PayoutAccountInput,
): Promise<PlayerPayoutAccount> {
  return runTransaction(async (tx) => {
    const count = await tx.playerPayoutAccount.count({ where: { playerId, isActive: true } });
    const makeDefault = input.isDefault ?? count === 0;
    if (makeDefault) {
      await tx.playerPayoutAccount.updateMany({
        where: { playerId, isDefault: true },
        data: { isDefault: false },
      });
    }
    try {
      return await tx.playerPayoutAccount.create({
        data: {
          playerId,
          method: input.method,
          provider: input.provider ?? null,
          accountName: input.accountName,
          accountNumber: input.accountNumber,
          isDefault: makeDefault,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw Errors.conflict('This account is already saved', 'PAYOUT_ACCOUNT_EXISTS');
      }
      throw error;
    }
  });
}

export async function updatePayoutAccount(
  playerId: string,
  accountId: string,
  input: Partial<PayoutAccountInput>,
): Promise<PlayerPayoutAccount> {
  return runTransaction(async (tx) => {
    const account = await tx.playerPayoutAccount.findFirst({
      where: { id: accountId, playerId, isActive: true },
    });
    if (!account) throw Errors.notFound('Payout account');

    if (input.isDefault) {
      await tx.playerPayoutAccount.updateMany({
        where: { playerId, isDefault: true },
        data: { isDefault: false },
      });
    }

    try {
      return await tx.playerPayoutAccount.update({
        where: { id: account.id },
        data: {
          ...(input.method !== undefined ? { method: input.method } : {}),
          ...(input.provider !== undefined ? { provider: input.provider } : {}),
          ...(input.accountName !== undefined ? { accountName: input.accountName } : {}),
          ...(input.accountNumber !== undefined ? { accountNumber: input.accountNumber } : {}),
          ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw Errors.conflict('This account is already saved', 'PAYOUT_ACCOUNT_EXISTS');
      }
      throw error;
    }
  });
}

export async function deactivatePayoutAccount(
  playerId: string,
  accountId: string,
): Promise<PlayerPayoutAccount> {
  const account = await prisma.playerPayoutAccount.findFirst({
    where: { id: accountId, playerId, isActive: true },
  });
  if (!account) throw Errors.notFound('Payout account');

  // A live request pinned to this account must finish before it disappears.
  const inUse = await prisma.withdrawalRequest.findFirst({
    where: {
      payoutAccountId: account.id,
      status: { in: ['ESCROWED', 'PROCESSING'] },
    },
    select: { id: true },
  });
  if (inUse) {
    throw Errors.conflict(
      'This account is used by an open withdrawal. Wait for it to finish.',
      'PAYOUT_ACCOUNT_IN_USE',
    );
  }

  return prisma.playerPayoutAccount.update({
    where: { id: account.id },
    data: { isActive: false, isDefault: false },
  });
}
