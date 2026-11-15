import { AgentStatus, UserRole, type AgentPaymentAccount, type AgentProfile, type PaymentMethod } from '@prisma/client';
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

export interface AgentAssignment {
  agent: AgentProfile & {
    user: { displayName: string | null; avatarUrl: string | null };
    paymentAccounts: AgentPaymentAccount[];
  };
  account: AgentPaymentAccount;
}

/**
 * Picks the agent a player should pay. Only signed-in, accepting, free agents
 * qualify: the task lock means an agent works one request at a time. Online
 * and automation-capable agents come first, then reputation and float; the
 * payment account must also accept the requested amount. When the player
 * chose a provider rail, accounts on that rail are preferred and accounts
 * tagged with a different rail are skipped, so a Telebirr payer never gets an
 * M-Pesa number.
 */
export async function assignAgentForPayment(params: {
  method: PaymentMethod;
  amount: bigint;
  providerCode?: string;
  excludeAgentIds?: string[];
}): Promise<AgentAssignment | null> {
  const accountFilter = {
    isActive: true,
    method: params.method,
    ...(params.providerCode
      ? { OR: [{ provider: params.providerCode }, { provider: null }] }
      : {}),
  };
  const agents = await prisma.agentProfile.findMany({
    where: {
      status: AgentStatus.ACTIVE,
      acceptingTasks: true,
      ...(params.excludeAgentIds?.length
        ? { id: { notIn: params.excludeAgentIds } }
        : {}),
      tasks: { none: { status: { in: ['OFFERED', 'CLAIMED'] } } },
      paymentAccounts: { some: accountFilter },
    },
    include: {
      user: { select: { displayName: true, avatarUrl: true } },
      paymentAccounts: {
        where: accountFilter,
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: [
      { isOnline: 'desc' },
      { autoDepositEnabled: 'desc' },
      { ratingAvg: 'desc' },
      { completedDeposits: 'desc' },
      { floatAvailable: 'desc' },
    ],
    take: 25,
  });

  for (const agent of agents) {
    const eligible = agent.paymentAccounts.filter(
      (item) =>
        (item.minAmount === null || item.minAmount <= params.amount) &&
        (item.maxAmount === null || item.maxAmount >= params.amount),
    );
    const account =
      (params.providerCode
        ? eligible.find((item) => item.provider === params.providerCode) ??
          eligible.find((item) => !item.provider)
        : undefined) ?? eligible[0];
    if (account) return { agent, account };
  }
  return null;
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

export async function setAgentAvailability(
  userId: string,
  acceptingTasks: boolean,
): Promise<AgentProfile> {
  return prisma.agentProfile.update({
    where: { userId },
    data: { acceptingTasks, lastSeenAt: new Date() },
  });
}

export interface AutoDepositSettings {
  autoDepositEnabled?: boolean;
  autoDepositThreshold?: bigint | null;
}

/**
 * Agent preference for semi-automated deposits. Enabling requires a positive
 * ceiling: without one nothing would ever be below the threshold.
 */
export async function updateAutoDepositSettings(
  agentProfileId: string,
  settings: AutoDepositSettings,
): Promise<AgentProfile> {
  const current = await prisma.agentProfile.findUnique({
    where: { id: agentProfileId },
    select: { autoDepositEnabled: true, autoDepositThreshold: true },
  });
  if (!current) throw Errors.notFound('Agent');

  const enabled = settings.autoDepositEnabled ?? current.autoDepositEnabled;
  const threshold =
    settings.autoDepositThreshold !== undefined
      ? settings.autoDepositThreshold
      : current.autoDepositThreshold;

  if (settings.autoDepositThreshold !== undefined && settings.autoDepositThreshold !== null && settings.autoDepositThreshold <= 0n) {
    throw Errors.badRequest('The auto-verification limit must be positive', 'INVALID_AUTO_DEPOSIT_THRESHOLD');
  }
  if (enabled && (threshold === null || threshold === undefined || threshold <= 0n)) {
    throw Errors.badRequest(
      'Set an auto-verification limit before enabling it',
      'AUTO_DEPOSIT_THRESHOLD_REQUIRED',
    );
  }

  return prisma.agentProfile.update({
    where: { id: agentProfileId },
    data: {
      autoDepositEnabled: enabled,
      autoDepositThreshold: threshold ?? null,
    },
  });
}

export interface PaymentAccountInput {
  method: PaymentMethod;
  provider?: string | null;
  accountName: string;
  accountNumber: string;
  instructions?: string | null;
  minAmount?: bigint | null;
  maxAmount?: bigint | null;
  isActive?: boolean;
}

function assertPaymentAccountLimits(input: Pick<PaymentAccountInput, 'minAmount' | 'maxAmount'>) {
  if (input.minAmount !== undefined && input.minAmount !== null && input.minAmount < 0n) {
    throw Errors.badRequest('The minimum amount cannot be negative', 'INVALID_MIN_AMOUNT');
  }
  if (input.maxAmount !== undefined && input.maxAmount !== null && input.maxAmount <= 0n) {
    throw Errors.badRequest('The maximum amount must be positive', 'INVALID_MAX_AMOUNT');
  }
  if (
    input.minAmount !== undefined &&
    input.minAmount !== null &&
    input.maxAmount !== undefined &&
    input.maxAmount !== null &&
    input.minAmount > input.maxAmount
  ) {
    throw Errors.badRequest('The minimum cannot exceed the maximum', 'INVALID_AMOUNT_RANGE');
  }
}

export async function createPaymentAccount(
  agentProfileId: string,
  input: PaymentAccountInput,
): Promise<AgentPaymentAccount> {
  assertPaymentAccountLimits(input);
  try {
    return await prisma.agentPaymentAccount.create({
      data: {
        agentProfileId,
        method: input.method,
        provider: input.provider,
        accountName: input.accountName,
        accountNumber: input.accountNumber,
        instructions: input.instructions,
        minAmount: input.minAmount ?? null,
        maxAmount: input.maxAmount ?? null,
        isActive: input.isActive ?? true,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw Errors.conflict('This account is already on your profile', 'PAYMENT_ACCOUNT_EXISTS');
    }
    throw error;
  }
}

export async function updatePaymentAccount(
  agentProfileId: string,
  accountId: string,
  input: Partial<PaymentAccountInput>,
): Promise<AgentPaymentAccount> {
  const account = await prisma.agentPaymentAccount.findFirst({
    where: { id: accountId, agentProfileId },
  });
  if (!account) throw Errors.notFound('Payment account');

  assertPaymentAccountLimits({
    minAmount: input.minAmount !== undefined ? input.minAmount : account.minAmount,
    maxAmount: input.maxAmount !== undefined ? input.maxAmount : account.maxAmount,
  });

  try {
    return await prisma.agentPaymentAccount.update({
      where: { id: account.id },
      data: {
        ...(input.method !== undefined ? { method: input.method } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.accountName !== undefined ? { accountName: input.accountName } : {}),
        ...(input.accountNumber !== undefined ? { accountNumber: input.accountNumber } : {}),
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
        ...(input.minAmount !== undefined ? { minAmount: input.minAmount } : {}),
        ...(input.maxAmount !== undefined ? { maxAmount: input.maxAmount } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw Errors.conflict('This account is already on your profile', 'PAYMENT_ACCOUNT_EXISTS');
    }
    throw error;
  }
}
