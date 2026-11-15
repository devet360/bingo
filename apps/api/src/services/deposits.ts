import {
  DepositStatus,
  NotificationType,
  VerificationStatus,
  type DepositProvider,
  type PaymentMethod,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { calculateBps } from '../lib/money';
import { numericCode } from '../lib/ids';
import { Errors } from '../lib/errors';
import { isUniqueViolation, runTransaction, withTxRetry } from '../lib/tx';
import { postLedger } from './ledger';
import { assignAgentForPayment, getActiveAgentByUserId } from './agents';
import { closeAgentTask, createAgentTask, isTaskLockViolation } from './agentTasks';
import { getProvider } from './providers';
import { getDepositLimits } from './config';
import { formatEtb } from '../lib/money';
import { normalizeInput } from './receipts/reference';
import { ReferenceError as ReceiptReferenceError } from './receipts/types';

const DEPOSIT_TTL_MS = 30 * 60_000;

function noAgentForRail(rail: string) {
  return Errors.conflict(
    `No active agent is available for ${rail} right now. Choose another payment method.`,
    'NO_AGENT_FOR_METHOD',
  );
}

export interface CreateDepositInput {
  playerId: string;
  agentProfileId?: string;
  paymentAccountId?: string;
  method: PaymentMethod;
  amount: bigint;
  providerCode?: string;
  receiptReference?: string;
  receiptAccount?: string;
  receiptPhone?: string;
  externalRef?: string;
  receiptUrl?: string;
  playerNote?: string;
  idempotencyKey: string;
}

/** Validate the provider rail and canonicalise the receipt inputs before storing them. */
async function resolveProvider(input: CreateDepositInput): Promise<{
  provider: DepositProvider | null;
  receiptReference?: string;
  receiptAccount?: string;
  receiptPhone?: string;
}> {
  // Platform-wide floor and ceiling are operator settings, applied before any
  // rail-specific limit so an admin can cap deposits without editing each rail.
  const limits = await getDepositLimits();
  if (input.amount < limits.minAmount) {
    throw Errors.badRequest(
      `The minimum deposit is ${formatEtb(limits.minAmount)} ETB`,
      'DEPOSIT_BELOW_MINIMUM',
    );
  }
  if (limits.maxAmount !== null && input.amount > limits.maxAmount) {
    throw Errors.badRequest(
      `The maximum deposit is ${formatEtb(limits.maxAmount)} ETB`,
      'DEPOSIT_ABOVE_MAXIMUM',
    );
  }

  if (!input.providerCode) {
    return {
      provider: null,
      receiptReference: input.receiptReference?.trim() || undefined,
      receiptAccount: input.receiptAccount?.trim() || undefined,
      receiptPhone: input.receiptPhone?.trim() || undefined,
    };
  }

  const provider = await getProvider(input.providerCode, { requireEnabled: true });
  if (provider.method !== input.method) {
    throw Errors.badRequest(
      `${provider.name} is a ${provider.method.toLowerCase().replace('_', ' ')} method`,
      'PROVIDER_METHOD_MISMATCH',
    );
  }
  if (provider.minAmount !== null && input.amount < provider.minAmount) {
    throw Errors.badRequest(
      `The minimum for ${provider.name} is ${(Number(provider.minAmount) / 100).toFixed(2)}`,
      'AMOUNT_BELOW_PROVIDER_MINIMUM',
    );
  }
  if (provider.maxAmount !== null && input.amount > provider.maxAmount) {
    throw Errors.badRequest(
      `The maximum for ${provider.name} is ${(Number(provider.maxAmount) / 100).toFixed(2)}`,
      'AMOUNT_ABOVE_PROVIDER_MAXIMUM',
    );
  }

  // Manual-only rails have no receipt to parse; the agent confirms those.
  if (!provider.supported) {
    return {
      provider,
      receiptReference: input.receiptReference?.trim() || undefined,
      receiptAccount: input.receiptAccount?.trim() || undefined,
      receiptPhone: input.receiptPhone?.trim() || undefined,
    };
  }

  try {
    const normalized = normalizeInput(provider, {
      reference: input.receiptReference,
      accountNumber: input.receiptAccount,
      phoneNumber: input.receiptPhone,
    });
    return {
      provider,
      receiptReference: normalized.reference,
      receiptAccount: normalized.accountNumber,
      receiptPhone: normalized.phoneNumber,
    };
  } catch (error) {
    if (error instanceof ReceiptReferenceError) {
      throw Errors.badRequest(error.message, 'INVALID_RECEIPT_REFERENCE');
    }
    throw error;
  }
}

export async function createDeposit(input: CreateDepositInput) {
  let agentProfileId = input.agentProfileId;
  let paymentAccountId = input.paymentAccountId;
  // A player-chosen agent is honoured or rejected; the server never silently
  // moves an explicitly chosen payment destination to someone else.
  let assignedByServer = false;

  if (!agentProfileId && input.paymentAccountId) {
    const account = await prisma.agentPaymentAccount.findUnique({
      where: { id: input.paymentAccountId },
      select: { agentProfileId: true, isActive: true },
    });
    if (!account?.isActive) throw Errors.notFound('Payment account');
    agentProfileId = account.agentProfileId;
    paymentAccountId = input.paymentAccountId;
  }

  if (agentProfileId) {
    const agent = await prisma.agentProfile.findUnique({
      where: { id: agentProfileId },
      select: { status: true, acceptingTasks: true },
    });
    if (!agent) throw Errors.notFound('Agent');
    if (agent.status !== 'ACTIVE') {
      throw Errors.conflict('Agent is not accepting deposits right now', 'AGENT_INACTIVE');
    }
    if (!agent.acceptingTasks) {
      throw Errors.conflict('Agent is not accepting deposits right now', 'AGENT_UNAVAILABLE');
    }
    if (input.paymentAccountId) {
      const owned = await prisma.agentPaymentAccount.findFirst({
        where: { id: input.paymentAccountId, agentProfileId, isActive: true },
        select: { id: true },
      });
      if (!owned) {
        throw Errors.badRequest(
          'Payment account does not belong to the selected agent',
          'PAYMENT_ACCOUNT_MISMATCH',
        );
      }
    }
  }

  const receipt = await resolveProvider(input);

  const existing = await prisma.depositRequest.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) return { deposit: existing, replayed: true, provider: receipt.provider };

  // Players only choose a method; the server picks who will receive the money.
  if (!agentProfileId) {
    const assignment = await assignAgentForPayment({
      method: input.method,
      amount: input.amount,
      providerCode: receipt.provider?.code,
    });
    if (!assignment) {
      const rail = receipt.provider?.name ?? input.method.toLowerCase().replaceAll('_', ' ');
      throw noAgentForRail(rail);
    }
    agentProfileId = assignment.agent.id;
    paymentAccountId = assignment.account.id;
    assignedByServer = true;
  }

  const excludedAgentIds = new Set<string>();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const deposit = await runTransaction(async (tx) => {
        const created = await tx.depositRequest.create({
          data: {
            code: numericCode(6),
            idempotencyKey: input.idempotencyKey,
            playerId: input.playerId,
            agentProfileId,
            paymentAccountId,
            method: input.method,
            amount: input.amount,
            providerCode: receipt.provider?.code,
            receiptReference: receipt.receiptReference,
            receiptAccount: receipt.receiptAccount,
            receiptPhone: receipt.receiptPhone,
            verificationStatus: receipt.provider?.supported
              ? VerificationStatus.PENDING
              : VerificationStatus.NOT_REQUIRED,
            externalRef: input.externalRef,
            receiptUrl: input.receiptUrl,
            playerNote: input.playerNote,
            expiresAt: new Date(Date.now() + DEPOSIT_TTL_MS),
          },
        });
        await createAgentTask(tx, { agentProfileId: agentProfileId!, depositId: created.id });
        return created;
      });
      return { deposit, replayed: false, provider: receipt.provider };
    } catch (error) {
      if (isUniqueViolation(error, 'idempotencyKey')) {
        const duplicate = await prisma.depositRequest.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (duplicate) return { deposit: duplicate, replayed: true, provider: receipt.provider };
      }
      if (isUniqueViolation(error, 'code')) continue;
      if (isTaskLockViolation(error) && agentProfileId) {
        // The agent was picked up by a concurrent request between the query
        // and the insert; try the next free agent.
        if (!assignedByServer) {
          throw Errors.conflict(
            'That agent is finishing another request. Try again in a moment.',
            'AGENT_BUSY',
          );
        }
        excludedAgentIds.add(agentProfileId);
        const next = await assignAgentForPayment({
          method: input.method,
          amount: input.amount,
          providerCode: receipt.provider?.code,
          excludeAgentIds: [...excludedAgentIds],
        });
        if (!next) {
          const rail = receipt.provider?.name ?? input.method.toLowerCase().replaceAll('_', ' ');
          throw noAgentForRail(rail);
        }
        agentProfileId = next.agent.id;
        paymentAccountId = next.account.id;
        continue;
      }
      throw error;
    }
  }

  throw Errors.internal('Could not allocate a deposit code');
}

export async function claimDeposit(agentUserId: string, code: string) {
  const agent = await getActiveAgentByUserId(agentUserId);
  if (!agent.acceptingTasks) {
    throw Errors.conflict('Turn on accepting tasks before claiming work', 'AGENT_UNAVAILABLE');
  }
  return runTransaction(async (tx) => {
    const deposit = await tx.depositRequest.findFirst({
      where: { code, status: { in: ['PENDING', 'PROCESSING'] } },
    });
    if (!deposit) throw Errors.notFound('Open deposit request');
    if (deposit.agentProfileId && deposit.agentProfileId !== agent.id) {
      throw Errors.forbidden('This deposit is assigned to another agent', 'DEPOSIT_ASSIGNED');
    }
    if (deposit.expiresAt <= new Date()) {
      throw Errors.gone('Deposit request has expired', 'DEPOSIT_EXPIRED');
    }
    if (deposit.status === 'PROCESSING' && deposit.agentProfileId === agent.id) {
      return deposit;
    }

    const task = await tx.agentTask.findFirst({
      where: { depositId: deposit.id, status: { in: ['OFFERED', 'CLAIMED'] } },
    });
    if (!task) {
      const busy = await tx.agentTask.findFirst({
        where: { agentProfileId: agent.id, status: { in: ['OFFERED', 'CLAIMED'] } },
        select: { id: true },
      });
      if (busy) {
        throw Errors.conflict(
          'Finish your current task before claiming another',
          'AGENT_TASK_ACTIVE',
        );
      }
      await createAgentTask(tx, { agentProfileId: agent.id, depositId: deposit.id });
    }

    return tx.depositRequest.update({
      where: { id: deposit.id },
      data: {
        status: DepositStatus.PROCESSING,
        agentProfileId: agent.id,
        claimedAt: new Date(),
      },
    });
  });
}

export async function creditDeposit(params: {
  agentUserId: string;
  code: string;
  creditedAmount?: bigint;
  note?: string;
}) {
  const agent = await getActiveAgentByUserId(params.agentUserId);

  return withTxRetry(() =>
    runTransaction(async (tx) => {
      const open = await tx.depositRequest.findFirst({
        where: { code: params.code, status: { in: ['PENDING', 'PROCESSING'] } },
      });

      if (!open) {
        const recent = await tx.depositRequest.findFirst({
          where: { code: params.code },
          orderBy: { createdAt: 'desc' },
        });
        if (!recent) throw Errors.notFound('Deposit request');
        if (recent.status === 'CREDITED') {
          if (recent.agentProfileId === agent.id) return { deposit: recent, replayed: true };
          throw Errors.conflict('This deposit was already credited', 'DEPOSIT_ALREADY_CREDITED');
        }
        if (recent.status === 'EXPIRED') {
          throw Errors.gone('Deposit request has expired', 'DEPOSIT_EXPIRED');
        }
        throw Errors.conflict(`Deposit is ${recent.status.toLowerCase()}`, 'DEPOSIT_NOT_OPEN');
      }

      if (open.agentProfileId && open.agentProfileId !== agent.id) {
        throw Errors.forbidden('This deposit is assigned to another agent', 'DEPOSIT_ASSIGNED');
      }
      if (open.expiresAt <= new Date()) {
        throw Errors.gone('Deposit request has expired', 'DEPOSIT_EXPIRED');
      }

      const amount = params.creditedAmount ?? open.amount;
      if (amount <= 0n || amount > open.amount) {
        throw Errors.badRequest(
          'Credited amount must be positive and cannot exceed the requested amount',
          'INVALID_CREDITED_AMOUNT',
        );
      }

      if (!open.agentProfileId) {
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
        await createAgentTask(tx, { agentProfileId: agent.id, depositId: open.id });
      }

      const commission = calculateBps(amount, agent.depositCommissionBps);

      const posted = await postLedger(tx, {
        idempotencyKey: `deposit:${open.id}`,
        kind: 'DEPOSIT',
        refType: 'DepositRequest',
        refId: open.id,
        createdById: agent.userId,
        memo: `Deposit ${open.code} via agent ${agent.agentCode}`,
        instructions: [
          { ownerKind: 'AGENT', ownerId: agent.id, code: 'FLOAT', delta: -amount },
          { ownerKind: 'USER', ownerId: open.playerId, code: 'AVAILABLE', delta: amount },
        ],
      });

      if (posted.replayed) {
        const current = await tx.depositRequest.findUnique({ where: { id: open.id } });
        return { deposit: current!, replayed: true };
      }

      if (commission > 0n) {
        await postLedger(tx, {
          idempotencyKey: `deposit-commission:${open.id}`,
          kind: 'DEPOSIT_COMMISSION',
          refType: 'DepositRequest',
          refId: open.id,
          memo: `Deposit commission ${agent.depositCommissionBps} bps`,
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

      const deposit = await tx.depositRequest.update({
        where: { id: open.id },
        data: {
          status: DepositStatus.CREDITED,
          creditedAmount: amount,
          agentProfileId: agent.id,
          processedById: agent.userId,
          settledAt: new Date(),
          agentNote: params.note,
        },
      });

      await tx.wallet.updateMany({
        where: { userId: open.playerId },
        data: { lifetimeDeposited: { increment: amount } },
      });
      await tx.agentProfile.update({
        where: { id: agent.id },
        data: { completedDeposits: { increment: 1 } },
      });
      await tx.agentCommission.create({
        data: {
          agentProfileId: agent.id,
          kind: 'DEPOSIT',
          depositId: open.id,
          baseAmount: amount,
          bps: agent.depositCommissionBps,
          amount: commission,
        },
      });
      await tx.notification.create({
        data: {
          userId: open.playerId,
          type: NotificationType.DEPOSIT_CREDITED,
          title: 'Deposit credited',
          body: 'Your deposit has been credited by the agent.',
          data: { depositId: open.id, amount: amount.toString(), code: open.code },
        },
      });

      await closeAgentTask(tx, { depositId: open.id }, 'COMPLETED');

      return { deposit, replayed: false };
    }),
  );
}

export async function rejectDeposit(agentUserId: string, code: string, note?: string) {
  const agent = await getActiveAgentByUserId(agentUserId);
  return runTransaction(async (tx) => {
    const deposit = await tx.depositRequest.findFirst({
      where: { code, status: { in: ['PENDING', 'PROCESSING'] } },
    });
    if (!deposit) throw Errors.notFound('Open deposit request');
    if (deposit.agentProfileId && deposit.agentProfileId !== agent.id) {
      throw Errors.forbidden('This deposit is assigned to another agent', 'DEPOSIT_ASSIGNED');
    }
    const rejected = await tx.depositRequest.update({
      where: { id: deposit.id },
      data: {
        status: DepositStatus.REJECTED,
        agentProfileId: agent.id,
        processedById: agent.userId,
        agentNote: note,
      },
    });
    await closeAgentTask(tx, { depositId: deposit.id }, 'CANCELLED');
    return rejected;
  });
}

export async function listPlayerDeposits(playerId: string, status?: DepositStatus) {
  return prisma.depositRequest.findMany({
    where: { playerId, ...(status ? { status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}

export async function listAgentDeposits(agentProfileId: string, status?: DepositStatus) {
  return prisma.depositRequest.findMany({
    where: {
      OR: [{ agentProfileId }, { agentProfileId: null, status: 'PENDING' }],
      ...(status ? { status } : { status: { in: ['PENDING', 'PROCESSING'] } }),
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
}
