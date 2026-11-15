import {
  NotificationType,
  type PaymentMethod,
  type Prisma,
  type WithdrawalStatus,
} from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { calculateBps, splitWithdrawalFee } from '../lib/money';
import { numericCode } from '../lib/ids';
import { Errors } from '../lib/errors';
import { isUniqueViolation, runTransaction, withTxRetry } from '../lib/tx';
import { postLedger } from './ledger';
import { assignAgentForPayment, getActiveAgentByUserId } from './agents';
import { closeAgentTask, createAgentTask, isTaskLockViolation } from './agentTasks';

const WITHDRAWAL_TTL_MS = 60 * 60_000;

export interface CreateWithdrawalInput {
  playerId: string;
  /** Optional legacy assignment; players normally leave this to the server. */
  agentProfileId?: string;
  paymentAccountId?: string;
  payoutAccountId?: string;
  method: PaymentMethod;
  amount: bigint;
  playerNote?: string;
  idempotencyKey: string;
}

/** Cash handovers have no receiving account; every other rail needs one. */
async function resolvePayoutAccount(
  playerId: string,
  method: PaymentMethod,
  payoutAccountId?: string,
) {
  if (payoutAccountId) {
    const account = await prisma.playerPayoutAccount.findFirst({
      where: { id: payoutAccountId, playerId, isActive: true },
    });
    if (!account) throw Errors.notFound('Payout account');
    if (account.method !== method) {
      throw Errors.badRequest(
        'The payout account does not match the withdrawal method',
        'PAYOUT_METHOD_MISMATCH',
      );
    }
    return account;
  }
  if (method === 'CASH') return null;

  const account = await prisma.playerPayoutAccount.findFirst({
    where: { playerId, method, isActive: true },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
  if (!account) {
    throw Errors.badRequest(
      'Add a payout account for this method before withdrawing',
      'PAYOUT_ACCOUNT_REQUIRED',
    );
  }
  return account;
}

export async function createWithdrawal(input: CreateWithdrawalInput) {
  const agent = input.agentProfileId
    ? await prisma.agentProfile.findUnique({
        where: { id: input.agentProfileId },
        select: { id: true, status: true, agentCode: true, acceptingTasks: true },
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
    where: { playerId: input.playerId, status: { in: ['ESCROWED', 'PROCESSING'] } },
    select: { id: true },
  });
  if (open) {
    throw Errors.conflict(
      'You already have a withdrawal in progress. Cancel it before opening a new one.',
      'WITHDRAWAL_OPEN',
    );
  }

  const payoutAccount = await resolvePayoutAccount(
    input.playerId,
    input.method,
    input.payoutAccountId,
  );

  const { fee, net } = splitWithdrawalFee(input.amount, env.WITHDRAWAL_FEE_BPS);
  if (net <= 0n) {
    throw Errors.badRequest('Amount is too small after fees', 'AMOUNT_TOO_SMALL');
  }

  let agentProfileId = agent?.id ?? null;
  let paymentAccountId = input.paymentAccountId;
  const explicitAgent = Boolean(agentProfileId);

  if (!agentProfileId) {
    const assignment = await assignAgentForPayment({
      method: input.method,
      amount: input.amount,
    });
    if (assignment) {
      agentProfileId = assignment.agent.id;
      paymentAccountId = assignment.account.id;
    }
  }

  const excludedAgentIds = new Set<string>();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await withTxRetry(() =>
        runTransaction(async (tx) => {
          const withdrawal = await tx.withdrawalRequest.create({
            data: {
              payoutCode: numericCode(6),
              idempotencyKey: input.idempotencyKey,
              playerId: input.playerId,
              agentProfileId,
              paymentAccountId,
              payoutAccountId: payoutAccount?.id ?? null,
              method: input.method,
              amount: input.amount,
              fee,
              netAmount: net,
              playerNote: input.playerNote,
              expiresAt: new Date(Date.now() + WITHDRAWAL_TTL_MS),
            },
          });

          if (agentProfileId) {
            await createAgentTask(tx, { agentProfileId, withdrawalId: withdrawal.id });
          }

          await postLedger(tx, {
            idempotencyKey: `withdrawal-escrow:${withdrawal.id}`,
            kind: 'WITHDRAWAL_ESCROW',
            refType: 'WithdrawalRequest',
            refId: withdrawal.id,
            memo: agentProfileId
              ? 'Withdrawal escrow (agent routed)'
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
      if (isUniqueViolation(error, 'playerId') || isUniqueViolation(error, 'payoutCode')) {
        if (isUniqueViolation(error, 'playerId')) {
          throw Errors.conflict(
            'You already have a withdrawal in progress. Cancel it before opening a new one.',
            'WITHDRAWAL_OPEN',
          );
        }
        continue;
      }
      if (isTaskLockViolation(error) && agentProfileId) {
        if (explicitAgent) {
          throw Errors.conflict(
            'That agent is finishing another request. Try again in a moment.',
            'AGENT_BUSY',
          );
        }
        excludedAgentIds.add(agentProfileId);
        const next = await assignAgentForPayment({
          method: input.method,
          amount: input.amount,
          excludeAgentIds: [...excludedAgentIds],
        });
        if (next) {
          agentProfileId = next.agent.id;
          paymentAccountId = next.account.id;
        } else {
          agentProfileId = null;
          paymentAccountId = undefined;
        }
        continue;
      }
      throw error;
    }
  }

  throw Errors.internal('Could not allocate a payout code');
}

/**
 * Returns escrow to the player. ESCROWED requests refund the player's own
 * escrow; PROCESSING requests unwind the agent hold instead, because the
 * agent already claimed the money and the platform fee moved at hold time.
 */
async function refundWithdrawal(
  withdrawalId: string,
  finalStatus: Extract<WithdrawalStatus, 'EXPIRED' | 'CANCELLED'>,
): Promise<void> {
  await withTxRetry(() =>
    runTransaction(async (tx) => {
      const withdrawal = await tx.withdrawalRequest.findUnique({ where: { id: withdrawalId } });
      if (!withdrawal) return;
      if (withdrawal.status !== 'ESCROWED' && withdrawal.status !== 'PROCESSING') return;

      const held = withdrawal.status === 'PROCESSING';
      if (held && !withdrawal.agentProfileId) {
        throw Errors.internal('Held withdrawal has no agent to unwind');
      }
      const posted = await postLedger(tx, {
        idempotencyKey: held
          ? `withdrawal-hold-refund:${withdrawal.id}`
          : `withdrawal-refund:${withdrawal.id}`,
        kind: held ? 'WITHDRAWAL_HOLD_REFUND' : 'WITHDRAWAL_REFUND',
        refType: 'WithdrawalRequest',
        refId: withdrawal.id,
        memo: `Withdrawal ${finalStatus.toLowerCase()} refund`,
        instructions: held
          ? [
              {
                ownerKind: 'AGENT',
                ownerId: withdrawal.agentProfileId ?? '',
                code: 'FLOAT_ESCROW',
                delta: -withdrawal.netAmount,
              },
              { ownerKind: 'PLATFORM', ownerId: 'platform', code: 'TREASURY', delta: -withdrawal.fee },
              { ownerKind: 'USER', ownerId: withdrawal.playerId, code: 'AVAILABLE', delta: withdrawal.amount },
            ]
          : [
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
      await closeAgentTask(tx, { withdrawalId: withdrawal.id }, 'CANCELLED');
      await tx.notification.create({
        data: {
          userId: withdrawal.playerId,
          type: held ? NotificationType.WITHDRAWAL_REFUNDED : NotificationType.WITHDRAWAL_EXPIRED,
          title: finalStatus === 'CANCELLED' ? 'Withdrawal cancelled' : 'Withdrawal expired',
          body: 'Your funds have been returned to your balance.',
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

/** Staff-assisted cancellation (support releasing a stuck escrow or hold). */
export async function cancelWithdrawalByStaff(withdrawalId: string) {
  const withdrawal = await prisma.withdrawalRequest.findUnique({ where: { id: withdrawalId } });
  if (!withdrawal) throw Errors.notFound('Withdrawal');
  if (withdrawal.status !== 'ESCROWED' && withdrawal.status !== 'PROCESSING') {
    throw Errors.conflict(
      'Only pending or in-progress withdrawals can be cancelled',
      'WITHDRAWAL_NOT_OPEN',
    );
  }
  await refundWithdrawal(withdrawal.id, 'CANCELLED');
  const updated = await prisma.withdrawalRequest.findUnique({ where: { id: withdrawal.id } });
  return updated!;
}

/**
 * Step 1 of the two-phase payout: the agent claims the payout code and the
 * player's escrow is held against the agent's FLOAT_ESCROW. No commission is
 * posted here; the agent earns it only when the payment proof is verified.
 */
export async function redeemWithdrawal(params: {
  agentUserId: string;
  payoutCode: string;
  note?: string;
}) {
  const agent = await getActiveAgentByUserId(params.agentUserId);
  if (!agent.acceptingTasks) {
    throw Errors.conflict('Turn on accepting tasks before paying out', 'AGENT_UNAVAILABLE');
  }

  const live = await prisma.withdrawalRequest.findFirst({
    where: {
      payoutCode: params.payoutCode,
      status: { in: ['ESCROWED', 'PROCESSING'] },
    },
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
  if (live.status === 'PROCESSING') {
    return { withdrawal: live, replayed: true };
  }
  if (live.expiresAt <= new Date()) {
    await refundWithdrawal(live.id, 'EXPIRED');
    throw Errors.gone('Payout code has expired', 'WITHDRAWAL_EXPIRED');
  }
  if (!live.payoutAccountId && live.method !== 'CASH') {
    throw Errors.conflict(
      'The player has no payout account for this method; ask them to add one',
      'PAYOUT_ACCOUNT_REQUIRED',
    );
  }

  return withTxRetry(() =>
    runTransaction(async (tx) => {
      const current = await tx.withdrawalRequest.findUnique({ where: { id: live.id } });
      if (!current || current.status !== 'ESCROWED') {
        return { withdrawal: current ?? live, replayed: true };
      }

      const task = await tx.agentTask.findFirst({
        where: { withdrawalId: current.id, status: { in: ['OFFERED', 'CLAIMED'] } },
      });
      if (!task) {
        const busy = await tx.agentTask.findFirst({
          where: { agentProfileId: agent.id, status: { in: ['OFFERED', 'CLAIMED'] } },
          select: { id: true },
        });
        if (busy) {
          throw Errors.conflict(
            'Finish your current task before taking another',
            'AGENT_TASK_ACTIVE',
          );
        }
        await createAgentTask(tx, { agentProfileId: agent.id, withdrawalId: current.id });
      }

      const posted = await postLedger(tx, {
        idempotencyKey: `withdrawal-hold:${current.id}`,
        kind: 'WITHDRAWAL_HOLD',
        refType: 'WithdrawalRequest',
        refId: current.id,
        createdById: agent.userId,
        memo: `Withdrawal ${current.payoutCode} held for agent ${agent.agentCode}`,
        instructions: [
          { ownerKind: 'USER', ownerId: current.playerId, code: 'ESCROW', delta: -current.amount },
          { ownerKind: 'AGENT', ownerId: agent.id, code: 'FLOAT_ESCROW', delta: current.netAmount },
          { ownerKind: 'PLATFORM', ownerId: 'platform', code: 'TREASURY', delta: current.fee },
        ],
      });

      if (posted.replayed) {
        const refreshed = await tx.withdrawalRequest.findUnique({ where: { id: current.id } });
        return { withdrawal: refreshed ?? current, replayed: true };
      }

      const withdrawal = await tx.withdrawalRequest.update({
        where: { id: current.id },
        data: {
          status: 'PROCESSING',
          agentProfileId: agent.id,
          processedById: agent.userId,
          holdAt: new Date(),
          agentNote: params.note,
        },
      });

      await tx.notification.create({
        data: {
          userId: current.playerId,
          type: NotificationType.WITHDRAWAL_PROCESSING,
          title: 'Withdrawal in progress',
          body: 'An agent is paying out your withdrawal. Funds are released once the payment proof is checked.',
          data: { withdrawalId: current.id, amount: current.amount.toString() },
        },
      });

      return { withdrawal, replayed: false };
    }),
  );
}

/**
 * Step 2 of the two-phase payout: the proof cleared, so the agent's held float
 * becomes spendable float and the withheld commission is finally posted.
 * Runs inside the caller's transaction so the proof row and the money commit
 * together.
 */
export async function releaseWithdrawalHold(
  tx: Prisma.TransactionClient,
  withdrawalId: string,
  options: { note?: string; processedById?: string } = {},
) {
  const current = await tx.withdrawalRequest.findUnique({
    where: { id: withdrawalId },
    include: { agentProfile: true },
  });
  if (!current) throw Errors.notFound('Withdrawal');
  if (current.status !== 'PROCESSING') {
    throw Errors.conflict('This withdrawal is not being paid out', 'WITHDRAWAL_NOT_PROCESSING');
  }
  const agent = current.agentProfile;
  if (!agent) throw Errors.internal('Held withdrawal has no agent');

  const commission = calculateBps(current.netAmount, agent.withdrawalCommissionBps);
  const posted = await postLedger(tx, {
    idempotencyKey: `withdrawal-release:${current.id}`,
    kind: 'WITHDRAWAL_HOLD_RELEASE',
    refType: 'WithdrawalRequest',
    refId: current.id,
    createdById: options.processedById,
    memo: `Withdrawal ${current.payoutCode} released to agent ${agent.agentCode}`,
    instructions: [
      { ownerKind: 'AGENT', ownerId: agent.id, code: 'FLOAT_ESCROW', delta: -current.netAmount },
      { ownerKind: 'AGENT', ownerId: agent.id, code: 'FLOAT', delta: current.netAmount },
    ],
  });
  if (posted.replayed) {
    const refreshed = await tx.withdrawalRequest.findUnique({ where: { id: current.id } });
    return refreshed!;
  }

  if (commission > 0n) {
    await postLedger(tx, {
      idempotencyKey: `withdrawal-commission:${current.id}`,
      kind: 'WITHDRAWAL_COMMISSION',
      refType: 'WithdrawalRequest',
      refId: current.id,
      memo: `Withdrawal commission ${agent.withdrawalCommissionBps} bps`,
      instructions: [
        { ownerKind: 'PLATFORM', ownerId: 'platform', code: 'COMMISSION_EXPENSE', delta: -commission },
        { ownerKind: 'AGENT', ownerId: agent.id, code: 'COMMISSION', delta: commission },
      ],
    });
  }

  const updated = await tx.withdrawalRequest.update({
    where: { id: current.id },
    data: {
      status: 'SETTLED',
      processedById: options.processedById ?? current.processedById,
      settledAt: new Date(),
      ...(options.note ? { agentNote: options.note } : {}),
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
  await closeAgentTask(tx, { withdrawalId: current.id }, 'COMPLETED');
  await tx.notification.create({
    data: {
      userId: current.playerId,
      type: NotificationType.WITHDRAWAL_SETTLED,
      title: 'Withdrawal paid',
      body: 'Your withdrawal has been paid out and the payment proof was verified.',
      data: { withdrawalId: current.id, amount: current.amount.toString() },
    },
  });

  return updated;
}

export async function listPlayerWithdrawals(playerId: string, status?: WithdrawalStatus) {  return prisma.withdrawalRequest.findMany({
    where: { playerId, ...(status ? { status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}

export async function listAgentWithdrawals(agentProfileId: string, status?: WithdrawalStatus) {
  // Unassigned escrows are visible to every active agent: whoever hands over
  // the cash claims the payout by redeeming its code (taking a task slot).
  return prisma.withdrawalRequest.findMany({
    where: {
      OR: [{ agentProfileId }, { agentProfileId: null, status: 'ESCROWED' }],
      ...(status ? { status } : { status: { in: ['ESCROWED', 'PROCESSING'] } }),
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
}
