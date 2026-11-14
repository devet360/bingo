import { NotificationType, type PaymentMethod, type WithdrawalStatus } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { calculateBps, splitWithdrawalFee } from '../lib/money';
import { numericCode } from '../lib/ids';
import { Errors } from '../lib/errors';
import { isUniqueViolation, runTransaction, withTxRetry } from '../lib/tx';
import { postLedger } from './ledger';
import { getActiveAgentByUserId } from './agents';

const WITHDRAWAL_TTL_MS = 60 * 60_000;

export interface CreateWithdrawalInput {
  playerId: string;
  /** Optional legacy assignment; players normally leave this to the server. */
  agentProfileId?: string;
  paymentAccountId?: string;
  method: PaymentMethod;
  amount: bigint;
  playerNote?: string;
  idempotencyKey: string;
}

export async function createWithdrawal(input: CreateWithdrawalInput) {
  const agent = input.agentProfileId
    ? await prisma.agentProfile.findUnique({
        where: { id: input.agentProfileId },
        select: { id: true, status: true, agentCode: true },
      })
    : null;
  if (input.agentProfileId && !agent) throw Errors.notFound('Agent');
  if (agent && agent.status !== 'ACTIVE') {
    throw Errors.conflict('Agent is not processing payouts right now', 'AGENT_INACTIVE');
  }
  if (input.paymentAccountId && agent) {
    const owned = await prisma.agentPaymentAccount.findFirst({
      where: { id: input.paymentAccountId, agentProfileId: agent.id, isActive: true },
      select: { id: true },
    });
    if (!owned) {
      throw Errors.badRequest(
        'Payment account does not belong to the selected agent',
        'PAYMENT_ACCOUNT_MISMATCH',
      );
    }
  }

  const existing = await prisma.withdrawalRequest.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) return { withdrawal: existing, replayed: true };

  const open = await prisma.withdrawalRequest.findFirst({
    where: { playerId: input.playerId, status: 'ESCROWED' },
    select: { id: true },
  });
  if (open) {
    throw Errors.conflict(
      'You already have a withdrawal in progress. Cancel it before opening a new one.',
      'WITHDRAWAL_OPEN',
    );
  }

  const { fee, net } = splitWithdrawalFee(input.amount, env.WITHDRAWAL_FEE_BPS);
  if (net <= 0n) {
    throw Errors.badRequest('Amount is too small after fees', 'AMOUNT_TOO_SMALL');
  }

  try {
    return await withTxRetry(() =>
      runTransaction(async (tx) => {
        const withdrawal = await tx.withdrawalRequest.create({
          data: {
            payoutCode: numericCode(6),
            idempotencyKey: input.idempotencyKey,
            playerId: input.playerId,
            agentProfileId: agent?.id ?? null,
            paymentAccountId: input.paymentAccountId,
            method: input.method,
            amount: input.amount,
            fee,
            netAmount: net,
            playerNote: input.playerNote,
            expiresAt: new Date(Date.now() + WITHDRAWAL_TTL_MS),
          },
        });

        await postLedger(tx, {
          idempotencyKey: `withdrawal-escrow:${withdrawal.id}`,
          kind: 'WITHDRAWAL_ESCROW',
          refType: 'WithdrawalRequest',
          refId: withdrawal.id,
          memo: agent
            ? `Withdrawal escrow via agent ${agent.agentCode}`
            : 'Withdrawal escrow (agent assigned at payout)',
          instructions: [
            { ownerKind: 'USER', ownerId: input.playerId, code: 'AVAILABLE', delta: -input.amount },
            { ownerKind: 'USER', ownerId: input.playerId, code: 'ESCROW', delta: input.amount },
          ],
        });

        return { withdrawal, replayed: false };
      }),
    );
  } catch (error) {
    if (isUniqueViolation(error, 'idempotencyKey')) {
      const duplicate = await prisma.withdrawalRequest.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (duplicate) return { withdrawal: duplicate, replayed: true };
    }
    if (isUniqueViolation(error, 'playerId')) {
      throw Errors.conflict(
        'You already have a withdrawal in progress. Cancel it before opening a new one.',
        'WITHDRAWAL_OPEN',
      );
    }
    throw error;
  }
}

async function refundWithdrawal(
  withdrawalId: string,
  finalStatus: Extract<WithdrawalStatus, 'EXPIRED' | 'CANCELLED'>,
): Promise<void> {
  await withTxRetry(() =>
    runTransaction(async (tx) => {
      const withdrawal = await tx.withdrawalRequest.findUnique({ where: { id: withdrawalId } });
      if (!withdrawal || withdrawal.status !== 'ESCROWED') return;

      const posted = await postLedger(tx, {
        idempotencyKey: `withdrawal-refund:${withdrawal.id}`,
        kind: 'WITHDRAWAL_REFUND',
        refType: 'WithdrawalRequest',
        refId: withdrawal.id,
        memo: `Withdrawal ${finalStatus.toLowerCase()} refund`,
        instructions: [
          { ownerKind: 'USER', ownerId: withdrawal.playerId, code: 'ESCROW', delta: -withdrawal.amount },
          { ownerKind: 'USER', ownerId: withdrawal.playerId, code: 'AVAILABLE', delta: withdrawal.amount },
        ],
      });
      if (posted.replayed) return;

      await tx.withdrawalRequest.update({
        where: { id: withdrawal.id },
        data: {
          status: finalStatus,
          ...(finalStatus === 'CANCELLED' ? { cancelledAt: new Date() } : {}),
        },
      });
      await tx.notification.create({
        data: {
          userId: withdrawal.playerId,
          type: NotificationType.WITHDRAWAL_EXPIRED,
          title: finalStatus === 'CANCELLED' ? 'Withdrawal cancelled' : 'Withdrawal expired',
          body: 'Your escrowed funds have been returned to your balance.',
          data: { withdrawalId: withdrawal.id, amount: withdrawal.amount.toString() },
        },
      });
    }),
  );
}

/** Expiry worker entrypoint: refunds an ESCROWED request whose TTL has elapsed. */
export async function expireWithdrawal(withdrawalId: string): Promise<void> {
  await refundWithdrawal(withdrawalId, 'EXPIRED');
}

export async function cancelWithdrawal(playerId: string, withdrawalId: string) {
  const withdrawal = await prisma.withdrawalRequest.findUnique({ where: { id: withdrawalId } });
  if (!withdrawal || withdrawal.playerId !== playerId) throw Errors.notFound('Withdrawal');
  if (withdrawal.status !== 'ESCROWED') {
    throw Errors.conflict('Only pending withdrawals can be cancelled', 'WITHDRAWAL_NOT_OPEN');
  }
  await refundWithdrawal(withdrawal.id, 'CANCELLED');
  const updated = await prisma.withdrawalRequest.findUnique({ where: { id: withdrawal.id } });
  return updated!;
}

/** Staff-assisted cancellation (support releasing a stuck escrow). */
export async function cancelWithdrawalByStaff(withdrawalId: string) {
  const withdrawal = await prisma.withdrawalRequest.findUnique({ where: { id: withdrawalId } });
  if (!withdrawal) throw Errors.notFound('Withdrawal');
  if (withdrawal.status !== 'ESCROWED') {
    throw Errors.conflict('Only pending withdrawals can be cancelled', 'WITHDRAWAL_NOT_OPEN');
  }
  await refundWithdrawal(withdrawal.id, 'CANCELLED');
  const updated = await prisma.withdrawalRequest.findUnique({ where: { id: withdrawal.id } });
  return updated!;
}

export async function redeemWithdrawal(params: {
  agentUserId: string;
  payoutCode: string;
  note?: string;
}) {
  const agent = await getActiveAgentByUserId(params.agentUserId);

  const live = await prisma.withdrawalRequest.findFirst({
    where: { payoutCode: params.payoutCode, status: 'ESCROWED' },
  });

  if (!live) {
    const latest = await prisma.withdrawalRequest.findFirst({
      where: { payoutCode: params.payoutCode },
      orderBy: { createdAt: 'desc' },
    });
    if (!latest) throw Errors.notFound('Payout code');
    if (latest.status === 'SETTLED' && latest.agentProfileId === agent.id) {
      return { withdrawal: latest, replayed: true };
    }
    if (latest.status === 'SETTLED') {
      throw Errors.conflict('This payout code was already settled', 'WITHDRAWAL_SETTLED');
    }
    throw Errors.gone(`Withdrawal is ${latest.status.toLowerCase()}`, 'WITHDRAWAL_NOT_OPEN');
  }

  if (live.agentProfileId && live.agentProfileId !== agent.id) {
    throw Errors.forbidden('This payout belongs to another agent', 'WITHDRAWAL_ASSIGNED');
  }
  if (live.expiresAt <= new Date()) {
    await refundWithdrawal(live.id, 'EXPIRED');
    throw Errors.gone('Payout code has expired', 'WITHDRAWAL_EXPIRED');
  }

  const commission = calculateBps(live.netAmount, agent.withdrawalCommissionBps);

  return withTxRetry(() =>
    runTransaction(async (tx) => {
      const current = await tx.withdrawalRequest.findUnique({ where: { id: live.id } });
      if (!current || current.status !== 'ESCROWED') {
        return { withdrawal: current ?? live, replayed: true };
      }

      const posted = await postLedger(tx, {
        idempotencyKey: `withdrawal-settlement:${current.id}`,
        kind: 'WITHDRAWAL_SETTLEMENT',
        refType: 'WithdrawalRequest',
        refId: current.id,
        createdById: agent.userId,
        memo: `Withdrawal ${current.payoutCode} settled by agent ${agent.agentCode}`,
        instructions: [
          {
            ownerKind: 'USER',
            ownerId: current.playerId,
            code: 'ESCROW',
            delta: -current.amount,
          },
          {
            ownerKind: 'AGENT',
            ownerId: agent.id,
            code: 'FLOAT',
            delta: current.netAmount,
          },
          {
            ownerKind: 'PLATFORM',
            ownerId: 'platform',
            code: 'TREASURY',
            delta: current.fee,
          },
        ],
      });

      if (posted.replayed) {
        const refreshed = await tx.withdrawalRequest.findUnique({ where: { id: current.id } });
        return { withdrawal: refreshed ?? current, replayed: true };
      }

      if (commission > 0n) {
        await postLedger(tx, {
          idempotencyKey: `withdrawal-commission:${current.id}`,
          kind: 'WITHDRAWAL_COMMISSION',
          refType: 'WithdrawalRequest',
          refId: current.id,
          memo: `Withdrawal commission ${agent.withdrawalCommissionBps} bps`,
          instructions: [
            {
              ownerKind: 'PLATFORM',
              ownerId: 'platform',
              code: 'COMMISSION_EXPENSE',
              delta: -commission,
            },
            { ownerKind: 'AGENT', ownerId: agent.id, code: 'COMMISSION', delta: commission },
          ],
        });
      }

      const withdrawal = await tx.withdrawalRequest.update({
        where: { id: current.id },
        data: {
          status: 'SETTLED',
          agentProfileId: agent.id,
          processedById: agent.userId,
          settledAt: new Date(),
          agentNote: params.note,
        },
      });

      await tx.wallet.updateMany({
        where: { userId: current.playerId },
        data: { lifetimeWithdrawn: { increment: current.amount } },
      });
      await tx.agentProfile.update({
        where: { id: agent.id },
        data: { completedWithdrawals: { increment: 1 } },
      });
      await tx.agentCommission.create({
        data: {
          agentProfileId: agent.id,
          kind: 'WITHDRAWAL',
          withdrawalId: current.id,
          baseAmount: current.netAmount,
          bps: agent.withdrawalCommissionBps,
          amount: commission,
        },
      });
      await tx.notification.create({
        data: {
          userId: current.playerId,
          type: NotificationType.WITHDRAWAL_SETTLED,
          title: 'Withdrawal paid',
          body: 'Your payout code was redeemed by the agent.',
          data: { withdrawalId: current.id, amount: current.amount.toString() },
        },
      });

      return { withdrawal, replayed: false };
    }),
  );
}

export async function listPlayerWithdrawals(playerId: string, status?: WithdrawalStatus) {
  return prisma.withdrawalRequest.findMany({
    where: { playerId, ...(status ? { status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}

export async function listAgentWithdrawals(agentProfileId: string, status?: WithdrawalStatus) {
  // Unassigned escrows are visible to every active agent: whoever hands over
  // the cash claims the payout by redeeming its code.
  const effective = status ?? 'ESCROWED';
  return prisma.withdrawalRequest.findMany({
    where: {
      OR: [{ agentProfileId }, { agentProfileId: null, status: 'ESCROWED' }],
      status: effective,
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
}
