import { AgentStatus, UserRole, type AgentProfile, type PaymentMethod } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { provisionAgentAccounts } from './accounts';
import { postLedger } from './ledger';
import { referralCode as shortCode } from '../lib/ids';
import { Errors } from '../lib/errors';
import { isUniqueViolation, runTransaction, withTxRetry } from '../lib/tx';

export async function getActiveAgentByUserId(userId: string): Promise<AgentProfile> {
  const agent = await prisma.agentProfile.findUnique({ where: { userId } });
  if (!agent) throw Errors.forbidden('An agent account is required', 'AGENT_REQUIRED');
  if (agent.status !== AgentStatus.ACTIVE) {
    throw Errors.forbidden('Agent account is not active', 'AGENT_INACTIVE');
  }
  return agent;
}

export interface CreateAgentInput {
  userId: string;
  region: string;
  city?: string;
  district?: string;
  approvedById?: string;
}

export async function createAgent(input: CreateAgentInput): Promise<AgentProfile> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await withTxRetry(() =>
        runTransaction(async (tx) => {
          const user = await tx.user.findUnique({ where: { id: input.userId } });
          if (!user) throw Errors.notFound('User');
          if (await tx.agentProfile.findUnique({ where: { userId: input.userId } })) {
            throw Errors.conflict('This user is already an agent', 'AGENT_EXISTS');
          }

          const profile = await tx.agentProfile.create({
            data: {
              userId: input.userId,
              agentCode: `AG${shortCode(6)}`,
              region: input.region,
              city: input.city,
              district: input.district,
              status: AgentStatus.ACTIVE,
              depositCommissionBps: env.DEFAULT_DEPOSIT_COMMISSION_BPS,
              withdrawalCommissionBps: env.DEFAULT_WITHDRAWAL_COMMISSION_BPS,
              approvedById: input.approvedById,
              approvedAt: new Date(),
            },
          });
          await tx.user.update({
            where: { id: input.userId },
            data: { role: UserRole.AGENT },
          });
          await provisionAgentAccounts(tx, profile.id);
          return profile;
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error, 'agentCode')) continue;
      throw error;
    }
  }
  throw Errors.internal('Could not allocate a unique agent code');
}

export interface TopUpFloatInput {
  agentProfileId: string;
  amount: bigint;
  method: PaymentMethod;
  externalRef?: string;
  proofUrl?: string;
  idempotencyKey: string;
  reviewedById: string;
}

export async function topUpAgentFloat(input: TopUpFloatInput) {
  const agent = await prisma.agentProfile.findUnique({ where: { id: input.agentProfileId } });
  if (!agent) throw Errors.notFound('Agent');
  if (agent.status !== AgentStatus.ACTIVE) {
    throw Errors.conflict('Agent is not active', 'AGENT_INACTIVE');
  }

  const existing = await prisma.agentFloatRequest.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) return { request: existing, replayed: true };

  return withTxRetry(() =>
    runTransaction(async (tx) => {
      const request = await tx.agentFloatRequest.create({
        data: {
          idempotencyKey: input.idempotencyKey,
          agentProfileId: agent.id,
          direction: 'TOP_UP',
          amount: input.amount,
          method: input.method,
          externalRef: input.externalRef,
          proofUrl: input.proofUrl,
          status: 'APPROVED',
          reviewedById: input.reviewedById,
          reviewedAt: new Date(),
        },
      });
      await postLedger(tx, {
        idempotencyKey: `agent-float-topup:${request.id}`,
        kind: 'AGENT_FLOAT_TOP_UP',
        refType: 'AgentFloatRequest',
        refId: request.id,
        createdById: input.reviewedById,
        memo: `Agent float top-up ${request.id}`,
        instructions: [
          { ownerKind: 'PLATFORM', ownerId: 'platform', code: 'SUSPENSE', delta: -input.amount },
          { ownerKind: 'AGENT', ownerId: agent.id, code: 'FLOAT', delta: input.amount },
        ],
      });
      return { request, replayed: false };
    }),
  );
}

export async function listPublicAgents(filter: { region?: string; method?: PaymentMethod }) {
  return prisma.agentProfile.findMany({
    where: {
      status: AgentStatus.ACTIVE,
      ...(filter.region ? { region: { equals: filter.region, mode: 'insensitive' } } : {}),
      ...(filter.method
        ? { paymentAccounts: { some: { isActive: true, method: filter.method } } }
        : {}),
    },
    include: {
      user: { select: { displayName: true, avatarUrl: true } },
      paymentAccounts: {
        where: { isActive: true, ...(filter.method ? { method: filter.method } : {}) },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: [{ isOnline: 'desc' }, { ratingAvg: 'desc' }, { completedDeposits: 'desc' }],
    take: 50,
  });
}

export async function findAgentByCode(agentCode: string) {
  return prisma.agentProfile.findUnique({
    where: { agentCode },
    include: {
      user: { select: { displayName: true, avatarUrl: true } },
      paymentAccounts: { where: { isActive: true } },
    },
  });
}

export async function setAgentPresence(userId: string, isOnline: boolean): Promise<AgentProfile> {
  return prisma.agentProfile.update({
    where: { userId },
    data: { isOnline, lastSeenAt: new Date() },
  });
}
