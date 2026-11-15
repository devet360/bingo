import { AgentTaskStatus, type AgentTask, type Prisma } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { Errors } from '../lib/errors';
import { isKnownPrismaError, runTransaction, withTxRetry } from '../lib/tx';

const ACTIVE_STATUSES: AgentTaskStatus[] = [AgentTaskStatus.OFFERED, AgentTaskStatus.CLAIMED];

export function taskSlaDeadline(from: Date = new Date()): Date {
  return new Date(from.getTime() + env.AGENT_TASK_SLA_MINUTES * 60_000);
}

/**
 * The single-task lock is a partial unique index, so a concurrent assignment
 * surfaces as P2002 on AgentTask. Prisma reports either the column or the
 * index name depending on the server version; match both.
 */
export function isTaskLockViolation(error: unknown): boolean {
  if (!isKnownPrismaError(error) || error.code !== 'P2002') return false;
  const target = error.meta?.target;
  const text = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return text.includes('agentProfileId') || text.includes('AgentTask_one_active');
}

export interface NewTaskInput {
  agentProfileId: string;
  depositId?: string;
  withdrawalId?: string;
  status?: Extract<AgentTaskStatus, 'OFFERED' | 'CLAIMED'>;
}

/** Must run inside the transaction that creates the deposit/withdrawal. */
export async function createAgentTask(
  tx: Prisma.TransactionClient,
  input: NewTaskInput,
): Promise<AgentTask> {
  const hasDeposit = Boolean(input.depositId);
  const hasWithdrawal = Boolean(input.withdrawalId);
  if (hasDeposit === hasWithdrawal) {
    throw new Error('An agent task must reference exactly one request');
  }
  const now = new Date();
  const status = input.status ?? AgentTaskStatus.CLAIMED;
  return tx.agentTask.create({
    data: {
      agentProfileId: input.agentProfileId,
      depositId: input.depositId ?? null,
      withdrawalId: input.withdrawalId ?? null,
      status,
      assignedAt: now,
      claimedAt: status === AgentTaskStatus.CLAIMED ? now : null,
      slaDeadline: taskSlaDeadline(now),
    },
  });
}

/** Idempotent close: an already-finished task is left untouched. */
export async function closeAgentTask(
  tx: Prisma.TransactionClient,
  ref: { depositId?: string; withdrawalId?: string },
  status: Extract<AgentTaskStatus, 'COMPLETED' | 'CANCELLED' | 'EXPIRED'>,
): Promise<void> {
  if (!ref.depositId && !ref.withdrawalId) return;
  const task = await tx.agentTask.findFirst({
    where: {
      ...(ref.depositId ? { depositId: ref.depositId } : {}),
      ...(ref.withdrawalId ? { withdrawalId: ref.withdrawalId } : {}),
      status: { in: ACTIVE_STATUSES },
    },
  });
  if (!task) return;
  await tx.agentTask.update({
    where: { id: task.id },
    data: {
      status,
      completedAt: status === AgentTaskStatus.COMPLETED ? new Date() : null,
    },
  });
}

/** Agent abandons a claim before any money moved. Frees the lock immediately. */
export async function releaseAgentTask(agentUserId: string, taskId: string): Promise<AgentTask> {
  return withTxRetry(() =>
    runTransaction(async (tx) => {
      const agent = await tx.agentProfile.findUnique({ where: { userId: agentUserId } });
      if (!agent) throw Errors.forbidden('An agent account is required', 'AGENT_REQUIRED');
      const task = await tx.agentTask.findFirst({
        where: { id: taskId, agentProfileId: agent.id, status: { in: ACTIVE_STATUSES } },
        include: { deposit: true, withdrawal: true },
      });
      if (!task) throw Errors.notFound('Task');
      if (task.withdrawal && task.withdrawal.status !== 'ESCROWED') {
        throw Errors.conflict('The payout is already in progress and cannot be released', 'TASK_IN_FLIGHT');
      }
      if (task.deposit && ['CREDITED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(task.deposit.status)) {
        throw Errors.conflict('This deposit is already closed', 'TASK_CLOSED');
      }

      const closed = await tx.agentTask.update({
        where: { id: task.id },
        data: { status: AgentTaskStatus.CANCELLED },
      });
      if (task.depositId) {
        await tx.depositRequest.updateMany({
          where: { id: task.depositId, status: { in: ['PENDING', 'PROCESSING'] } },
          data: { agentProfileId: null, paymentAccountId: null },
        });
      }
      if (task.withdrawalId) {
        await tx.withdrawalRequest.updateMany({
          where: { id: task.withdrawalId, status: 'ESCROWED' },
          data: { agentProfileId: null, paymentAccountId: null },
        });
      }
      return closed;
    }),
  );
}

/**
 * Sweeps tasks whose SLA elapsed while the request was still pre-money. Those
 * assignments are released so another agent can take the work; withdrawals
 * already in PROCESSING keep their task (money is in the agent's hands).
 */
export async function expireOverdueAgentTasks(limit = 100): Promise<number> {
  const overdue = await prisma.agentTask.findMany({
    where: {
      status: { in: ACTIVE_STATUSES },
      slaDeadline: { lte: new Date() },
      OR: [
        { deposit: { status: { in: ['PENDING', 'PROCESSING'] } } },
        { withdrawal: { status: 'ESCROWED' } },
      ],
    },
    select: { id: true, depositId: true, withdrawalId: true },
    take: limit,
  });

  let expired = 0;
  for (const task of overdue) {
    const done = await runTransaction(async (tx) => {
      const current = await tx.agentTask.findFirst({
        where: { id: task.id, status: { in: ACTIVE_STATUSES } },
      });
      if (!current) return false;
      await tx.agentTask.update({
        where: { id: current.id },
        data: { status: AgentTaskStatus.EXPIRED },
      });
      if (task.depositId) {
        await tx.depositRequest.updateMany({
          where: { id: task.depositId, status: { in: ['PENDING', 'PROCESSING'] } },
          data: { agentProfileId: null, paymentAccountId: null },
        });
      }
      if (task.withdrawalId) {
        await tx.withdrawalRequest.updateMany({
          where: { id: task.withdrawalId, status: 'ESCROWED' },
          data: { agentProfileId: null, paymentAccountId: null },
        });
      }
      return true;
    });
    if (done) expired += 1;
  }
  return expired;
}
