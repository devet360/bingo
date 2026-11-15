import { Router } from 'express';
import { AgentStatus, AgentTier, PaymentMethod, UserRole, UserStatus } from '@prisma/client';
import { z } from 'zod';
import { env } from '../config/env';
import { parse } from '../lib/validate';
import { asyncHandler } from '../lib/async';
import { Errors } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { PHONE_RE } from '../lib/phone';
import { serializeAgent, serializeUser } from '../lib/serializers';
import { authenticate, requireRole } from '../middleware/auth';
import { moneyLimiter } from '../middleware/rateLimit';
import {
  createAgent,
  createPaymentAccount,
  topUpAgentFloat,
  updateAutoDepositSettings,
} from '../services/agents';
import { writeAudit } from '../services/audit';
import {
  listAllProviders,
  serializeProvider,
  updateProvider,
} from '../services/providers';
import {
  createStaff,
  createStaffTelegramLink,
  resetStaffPassword,
  setStaffStatus,
  setStaffTelegram,
  STAFF_ROLES,
} from '../services/staff';
import { scopedIdempotencyKey } from '../services/wallet';
import {
  createCampaign,
  deleteCampaign,
  listAllCampaigns,
  serializeCampaign,
  updateCampaign,
} from '../services/campaigns';
import {
  getBonusSettings,
  getConfig,
  getReferralSettings,
  setConfig,
  BONUS_CONFIG_KEY,
  REFERRAL_CONFIG_KEY,
} from '../services/config';
import {
  grantBonus,
  listBonusHistory,
  serializeBonus,
  serializeBonusPromotion,
} from '../services/bonuses';
import {
  DEFAULT_PROVIDER_MAX_WIN,
  PROVIDER_MAX_WIN_CONFIG_KEY,
  deleteGame,
  deleteProvider,
  listProviderCatalog,
  serializeProvider as serializeGameProvider,
  upsertGame,
  upsertProvider,
} from '../services/gameProviders';

const AgentAccountSchema = z.object({
  method: z.nativeEnum(PaymentMethod),
  provider: z.string().trim().max(64).optional(),
  accountName: z.string().trim().min(1).max(128),
  accountNumber: z.string().trim().min(1).max(64),
  instructions: z.string().trim().max(500).optional(),
  minAmount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  maxAmount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});

const CreateAgentSchema = z
  .object({
    userId: z.string().uuid().optional(),
    telegramId: z.string().regex(/^\d{1,20}$/).optional(),
    region: z.string().min(1).max(64),
    city: z.string().max(64).optional(),
    district: z.string().max(64).optional(),
  })
  .refine((value) => value.userId || value.telegramId, {
    message: 'Provide userId or telegramId',
    path: ['userId'],
  });

const TopUpSchema = z.object({
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  method: z.nativeEnum(PaymentMethod),
  externalRef: z.string().max(128).optional(),
  proofUrl: z.string().url().max(2048).optional(),
});

const AgentListQuery = z.object({ status: z.nativeEnum(AgentStatus).optional() });

const CreateStaffSchema = z
  .object({
    role: z.enum(['SUPPORT', 'AGENT', 'SUPER_ADMIN']),
    displayName: z.string().trim().min(1).max(64),
    email: z.string().email().max(254).optional(),
    phone: z.string().regex(PHONE_RE, 'Use E.164 format').optional(),
    password: z.string().min(8).max(128).optional(),
    agent: z
      .object({
        region: z.string().trim().min(1).max(64),
        city: z.string().max(64).optional(),
        district: z.string().max(64).optional(),
        // Optional receiving account so a new agent can take deposits at once.
        account: AgentAccountSchema.optional(),
      })
      .optional(),
  })
  .refine((value) => value.email || value.phone, {
    message: 'An email or phone is required for login',
    path: ['email'],
  })
  .refine((value) => value.role !== 'AGENT' || Boolean(value.agent), {
    message: 'Agent region is required',
    path: ['agent'],
  });

const StaffQuery = z.object({
  query: z.string().trim().max(64).optional(),
  status: z.nativeEnum(UserStatus).optional(),
  page: z.coerce.number().int().min(0).max(2000).default(0),
});

const StaffStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED']),
});

const StaffTelegramSchema = z.object({
  telegramId: z.string().regex(/^\d{1,20}$/, 'Telegram id must be digits').nullable(),
});

const AgentPatchSchema = z.object({
  status: z.nativeEnum(AgentStatus).optional(),
  tier: z.nativeEnum(AgentTier).optional(),
  autoDepositEnabled: z.boolean().optional(),
  autoDepositThreshold: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .optional(),
});

const AuditQuery = z.object({
  action: z.string().trim().max(64).optional(),
  actorId: z.string().uuid().optional(),
  entityType: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().min(0).max(2000).default(0),
});

/** Amounts are minor units; null clears the limit. Parser/endpoint host stay code-owned. */
const ProviderPatchSchema = z.object({
  name: z.string().trim().min(1).max(96).optional(),
  enabled: z.boolean().optional(),
  supported: z.boolean().optional(),
  requiresPhone: z.boolean().optional(),
  accountDigits: z.number().int().min(1).max(12).nullable().optional(),
  opaqueReference: z.boolean().optional(),
  clientSide: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  instructions: z.string().trim().max(1000).nullable().optional(),
  refPattern: z.string().trim().max(300).nullable().optional(),
  refHint: z.string().trim().max(200).nullable().optional(),
  minAmount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  maxAmount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
});

const PAGE_SIZE = 50;

const CampaignBodySchema = z.object({
  kind: z.enum(['BANNER', 'POPUP']),
  audience: z.enum(['ALL', 'PLAYERS', 'AGENTS']).default('ALL'),
  locale: z.enum(['en', 'am']).default('en'),
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(2000),
  imageUrl: z.string().url().max(2048).nullable().optional(),
  linkUrl: z.string().url().max(2048).nullable().optional(),
  linkLabel: z.string().trim().max(40).nullable().optional(),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(1000).default(0),
  dismissHours: z.number().int().min(0).max(720).default(24),
  startsAt: z.coerce.date().nullable().optional(),
  endsAt: z.coerce.date().nullable().optional(),
});

const CampaignPatchSchema = CampaignBodySchema.partial();

const moneyOrNull = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .nullable()
  .optional();

const PromotionBodySchema = z.object({
  code: z.string().trim().min(3).max(32),
  name: z.string().trim().min(1).max(120),
  percentBps: z.number().int().min(1).max(10000).nullable().optional(),
  fixedAmount: moneyOrNull,
  maxBonus: moneyOrNull,
  minDeposit: moneyOrNull,
  wageringMultiplier: z.number().int().min(1).max(100),
  expiresInDays: z.number().int().min(1).max(365),
  enabled: z.boolean().default(true),
  startsAt: z.coerce.date().nullable().optional(),
  endsAt: z.coerce.date().nullable().optional(),
  maxRedemptions: z.number().int().positive().max(1_000_000).nullable().optional(),
});

const PromotionPatchSchema = PromotionBodySchema.partial();

const GrantBonusSchema = z.object({
  userId: z.string().uuid(),
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  multiplier: z.number().int().min(1).max(100).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  note: z.string().trim().max(200).optional(),
});

const ReferralSettingsSchema = z.object({
  commissionBps: z.number().int().min(0).max(5000),
  minRakeToPay: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});

const BonusSettingsSchema = z.object({
  defaultWageringMultiplier: z.number().int().min(1).max(100),
  defaultExpiryDays: z.number().int().min(1).max(365),
});

const ProviderBodySchema = z.object({
  name: z.string().trim().min(1).max(96),
  kind: z.enum(['NATIVE', 'AGGREGATOR']).default('AGGREGATOR'),
  apiBaseUrl: z.string().url().max(2048).nullable().optional(),
  webhookSecret: z.string().min(16).max(128).nullable().optional(),
  currency: z.string().trim().regex(/^[A-Za-z]{3,8}$/).transform((value) => value.toUpperCase()).default('ETB'),
  maxWin: moneyOrNull,
  enabled: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  config: z.unknown().optional(),
});

const GameBodySchema = z.object({
  externalId: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(96),
  category: z.string().trim().max(48).nullable().optional(),
  thumbnailUrl: z.string().url().max(2048).nullable().optional(),
  launchUrlTemplate: z.string().trim().max(2048).nullable().optional(),
  minStake: moneyOrNull,
  maxStake: moneyOrNull,
  maxWin: moneyOrNull,
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

const ProviderMaxWinSchema = z.object({
  maxWin: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

const ProviderCallbacksQuery = z.object({
  page: z.coerce.number().int().min(0).max(2000).default(0),
});

const ProviderTransactionsQuery = z.object({
  type: z.enum(['BET', 'WIN', 'ROLLBACK', 'BALANCE']).optional(),
  status: z.enum(['APPLIED', 'REJECTED', 'ROLLED_BACK']).optional(),
  page: z.coerce.number().int().min(0).max(2000).default(0),
});

export const adminRouter = Router();

adminRouter.use(authenticate, requireRole(UserRole.SUPER_ADMIN));

adminRouter.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [users, players, activeAgents, pendingDeposits, openWithdrawals, liabilities, todayLedgers] =
      await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { role: UserRole.PLAYER } }),
        prisma.agentProfile.count({ where: { status: AgentStatus.ACTIVE } }),
        prisma.depositRequest.count({ where: { status: 'PENDING' } }),
        prisma.withdrawalRequest.count({ where: { status: 'ESCROWED' } }),
        prisma.wallet.aggregate({ _sum: { available: true, escrow: true, locked: true } }),
        prisma.transactionLedger.count({ where: { createdAt: { gte: startOfDay } } }),
      ]);

    res.json({
      data: {
        users,
        players,
        activeAgents,
        pendingDeposits,
        openWithdrawals,
        todayLedgers,
        liabilities: {
          available: (liabilities._sum.available ?? 0n).toString(),
          escrow: (liabilities._sum.escrow ?? 0n).toString(),
          locked: (liabilities._sum.locked ?? 0n).toString(),
        },
      },
    });
  }),
);

adminRouter.get(
  '/staff',
  asyncHandler(async (req, res) => {
    const query = parse(StaffQuery, req.query);
    const where = {
      role: { in: STAFF_ROLES },
      ...(query.status ? { status: query.status } : {}),
      ...(query.query
        ? {
            OR: [
              { displayName: { contains: query.query, mode: 'insensitive' as const } },
              { email: { contains: query.query, mode: 'insensitive' as const } },
              { phone: { contains: query.query } },
            ],
          }
        : {}),
    };
    const [total, staff] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.page * PAGE_SIZE,
        take: PAGE_SIZE,
        include: { agentProfile: { select: { id: true, agentCode: true, status: true } } },
      }),
    ]);
    res.json({
      data: staff.map((user) => ({
        ...serializeUser(user),
        agentProfile: user.agentProfile,
      })),
      page: { index: query.page, size: PAGE_SIZE, total },
    });
  }),
);

adminRouter.post(
  '/staff',
  asyncHandler(async (req, res) => {
    const body = parse(CreateStaffSchema, req.body);
    const { user, temporaryPassword } = await createStaff({
      role: body.role,
      displayName: body.displayName,
      email: body.email,
      phone: body.phone,
      password: body.password,
    });

    let agent: Awaited<ReturnType<typeof createAgent>> | null = null;
    if (body.role === 'AGENT' && body.agent) {
      agent = await createAgent({
        userId: user.id,
        region: body.agent.region,
        city: body.agent.city,
        district: body.agent.district,
        approvedById: req.auth!.userId,
      });
      if (body.agent.account) {
        await createPaymentAccount(agent.id, {
          method: body.agent.account.method,
          provider: body.agent.account.provider,
          accountName: body.agent.account.accountName,
          accountNumber: body.agent.account.accountNumber,
          instructions: body.agent.account.instructions,
          minAmount:
            body.agent.account.minAmount === undefined ? undefined : BigInt(body.agent.account.minAmount),
          maxAmount:
            body.agent.account.maxAmount === undefined ? undefined : BigInt(body.agent.account.maxAmount),
        });
      }
    }

    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'staff.create',
      entityType: 'User',
      entityId: user.id,
      after: { role: user.role, email: user.email, phone: user.phone },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(201).json({
      data: {
        user: serializeUser(user),
        agent: agent ? serializeAgent(agent, { includeBalances: true }) : null,
        temporaryPassword,
      },
    });
  }),
);

adminRouter.patch(
  '/staff/:userId/status',
  asyncHandler(async (req, res) => {
    const body = parse(StaffStatusSchema, req.body);
    const target = await prisma.user.findUnique({
      where: { id: req.params.userId },
      select: { id: true, role: true, status: true },
    });
    if (!target || !STAFF_ROLES.includes(target.role)) throw Errors.notFound('Staff member');
    if (target.id === req.auth!.userId) {
      throw Errors.badRequest('You cannot change your own status', 'SELF_STATUS_CHANGE');
    }
    if (target.role === UserRole.SUPER_ADMIN && body.status === UserStatus.SUSPENDED) {
      const others = await prisma.user.count({
        where: { role: UserRole.SUPER_ADMIN, status: UserStatus.ACTIVE, id: { not: target.id } },
      });
      if (others === 0) {
        throw Errors.conflict('At least one active super admin is required', 'LAST_SUPER_ADMIN');
      }
    }

    const updated = await setStaffStatus(target.id, body.status);
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'staff.status',
      entityType: 'User',
      entityId: target.id,
      before: { status: target.status },
      after: { status: updated.status },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ data: { user: serializeUser(updated) } });
  }),
);

adminRouter.post(
  '/staff/:userId/reset-password',
  asyncHandler(async (req, res) => {
    const { temporaryPassword } = await resetStaffPassword(req.params.userId);
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'staff.reset_password',
      entityType: 'User',
      entityId: req.params.userId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ data: { temporaryPassword } });
  }),
);

adminRouter.patch(
  '/staff/:userId/telegram',
  asyncHandler(async (req, res) => {
    const body = parse(StaffTelegramSchema, req.body);
    const updated = await setStaffTelegram(req.params.userId, body.telegramId);
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'staff.telegram',
      entityType: 'User',
      entityId: updated.id,
      after: { telegramId: updated.telegramId?.toString() ?? null },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ data: { user: serializeUser(updated) } });
  }),
);

adminRouter.post(
  '/staff/:userId/telegram-link',
  asyncHandler(async (req, res) => {
    const { token, expiresAt } = await createStaffTelegramLink(req.params.userId);
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'staff.telegram_link',
      entityType: 'User',
      entityId: req.params.userId,
      after: { expiresAt: expiresAt.toISOString() },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    const botUsername = env.TELEGRAM_BOT_USERNAME;
    res.json({
      data: {
        token,
        expiresAt,
        url: botUsername ? `https://t.me/${botUsername}?start=staff_${token}` : null,
      },
    });
  }),
);

adminRouter.get(
  '/audit',
  asyncHandler(async (req, res) => {
    const query = parse(AuditQuery, req.query);
    const where = {
      ...(query.action ? { action: { contains: query.action } } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
    };
    const [total, logs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.page * PAGE_SIZE,
        take: PAGE_SIZE,
        include: { actor: { select: { displayName: true, role: true } } },
      }),
    ]);
    res.json({
      data: logs.map((log) => ({
        id: log.id.toString(),
        actorId: log.actorId,
        actorName: log.actor?.displayName ?? null,
        actorRole: log.actor?.role ?? log.actorRole,
        action: log.action,
        entityType: log.entityType,
        entityId: log.entityId,
        before: log.before,
        after: log.after,
        createdAt: log.createdAt,
      })),
      page: { index: query.page, size: PAGE_SIZE, total },
    });
  }),
);

adminRouter.post(
  '/agents',
  asyncHandler(async (req, res) => {
    const body = parse(CreateAgentSchema, req.body);
    const user = body.userId
      ? await prisma.user.findUnique({ where: { id: body.userId } })
      : await prisma.user.findUnique({ where: { telegramId: BigInt(body.telegramId!) } });
    if (!user) throw Errors.notFound('User');

    const agent = await createAgent({
      userId: user.id,
      region: body.region,
      city: body.city,
      district: body.district,
      approvedById: req.auth!.userId,
    });
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'agent.create',
      entityType: 'AgentProfile',
      entityId: agent.id,
      after: { userId: user.id, region: body.region },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.status(201).json({ data: serializeAgent(agent, { includeBalances: true }) });
  }),
);

adminRouter.post(
  '/agents/:agentId/payment-accounts',
  asyncHandler(async (req, res) => {
    const body = parse(AgentAccountSchema, req.body);
    const agent = await prisma.agentProfile.findUnique({
      where: { id: req.params.agentId },
      select: { id: true },
    });
    if (!agent) throw Errors.notFound('Agent');

    const account = await createPaymentAccount(agent.id, {
      method: body.method,
      provider: body.provider,
      accountName: body.accountName,
      accountNumber: body.accountNumber,
      instructions: body.instructions,
      minAmount: body.minAmount === undefined ? undefined : BigInt(body.minAmount),
      maxAmount: body.maxAmount === undefined ? undefined : BigInt(body.maxAmount),
    });
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'agent.payment_account',
      entityType: 'AgentPaymentAccount',
      entityId: account.id,
      after: { agentProfileId: agent.id, method: body.method },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.status(201).json({ data: { id: account.id } });
  }),
);

adminRouter.get(
  '/agents',
  asyncHandler(async (req, res) => {
    const query = parse(AgentListQuery, req.query);
    const agents = await prisma.agentProfile.findMany({
      where: query.status ? { status: query.status } : {},
      include: {
        user: { select: { displayName: true, avatarUrl: true } },
        paymentAccounts: { orderBy: { createdAt: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ data: agents.map((agent) => serializeAgent(agent, { includeBalances: true })) });
  }),
);

adminRouter.patch(
  '/agents/:agentId',
  asyncHandler(async (req, res) => {
    const body = parse(AgentPatchSchema, req.body);
    if (
      !body.status &&
      !body.tier &&
      body.autoDepositEnabled === undefined &&
      body.autoDepositThreshold === undefined
    ) {
      throw Errors.badRequest('Nothing to update');
    }
    const agent = await prisma.agentProfile.findUnique({
      where: { id: req.params.agentId },
      select: { id: true, status: true, tier: true },
    });
    if (!agent) throw Errors.notFound('Agent');

    if (body.autoDepositEnabled !== undefined || body.autoDepositThreshold !== undefined) {
      await updateAutoDepositSettings(agent.id, {
        autoDepositEnabled: body.autoDepositEnabled,
        autoDepositThreshold:
          body.autoDepositThreshold === undefined
            ? undefined
            : body.autoDepositThreshold === null
              ? null
              : BigInt(body.autoDepositThreshold),
      });
    }

    const updated = await prisma.agentProfile.update({
      where: { id: agent.id },
      data: { ...(body.status ? { status: body.status } : {}), ...(body.tier ? { tier: body.tier } : {}) },
      include: { user: { select: { displayName: true, avatarUrl: true } } },
    });
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'agent.update',
      entityType: 'AgentProfile',
      entityId: agent.id,
      before: { status: agent.status, tier: agent.tier },
      after: {
        status: updated.status,
        tier: updated.tier,
        autoDepositEnabled: updated.autoDepositEnabled,
        autoDepositThreshold: updated.autoDepositThreshold?.toString() ?? null,
      },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ data: serializeAgent(updated, { includeBalances: true }) });
  }),
);

adminRouter.post(
  '/agents/:agentId/float',
  moneyLimiter,
  asyncHandler(async (req, res) => {
    const body = parse(TopUpSchema, req.body);
    const { request, replayed } = await topUpAgentFloat({
      agentProfileId: req.params.agentId,
      amount: BigInt(body.amount),
      method: body.method,
      externalRef: body.externalRef,
      proofUrl: body.proofUrl,
      idempotencyKey: scopedIdempotencyKey(req),
      reviewedById: req.auth!.userId,
    });
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'agent.float_topup',
      entityType: 'AgentFloatRequest',
      entityId: request.id,
      after: { amount: request.amount.toString(), status: request.status },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.status(replayed ? 200 : 201).json({
      data: {
        id: request.id,
        agentProfileId: request.agentProfileId,
        amount: request.amount,
        status: request.status,
        createdAt: request.createdAt,
      },
      replayed,
    });
  }),
);

adminRouter.get(
  '/deposit-providers',
  asyncHandler(async (_req, res) => {
    const providers = await listAllProviders();
    res.json({ data: providers.map(serializeProvider) });
  }),
);

adminRouter.patch(
  '/deposit-providers/:code',
  asyncHandler(async (req, res) => {
    const body = parse(ProviderPatchSchema, req.body);
    const provider = await updateProvider(req.params.code, {
      ...body,
      minAmount:
        body.minAmount === undefined
          ? undefined
          : body.minAmount === null
            ? null
            : BigInt(body.minAmount),
      maxAmount:
        body.maxAmount === undefined
          ? undefined
          : body.maxAmount === null
            ? null
            : BigInt(body.maxAmount),
    });
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'provider.update',
      entityType: 'DepositProvider',
      entityId: provider.code,
      after: {
        enabled: provider.enabled,
        supported: provider.supported,
        clientSide: provider.clientSide,
        minAmount: provider.minAmount?.toString() ?? null,
        maxAmount: provider.maxAmount?.toString() ?? null,
      },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ data: serializeProvider(provider) });
  }),
);

adminRouter.get(
  '/reconciliation',
  asyncHandler(async (_req, res) => {
    // v_account_drift returns only accounts whose cached balance differs from the journal.
    const drift = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      'SELECT * FROM "v_account_drift" LIMIT 200',
    );
    res.json({ data: { healthy: drift.length === 0, drift } });
  }),
);

// ═══════════════════════════════ MARKETING ═══════════════════════════════════

adminRouter.get(
  '/campaigns',
  asyncHandler(async (_req, res) => {
    const campaigns = await listAllCampaigns();
    res.json({ data: campaigns.map(serializeCampaign) });
  }),
);

adminRouter.post(
  '/campaigns',
  asyncHandler(async (req, res) => {
    const body = parse(CampaignBodySchema, req.body);
    const campaign = await createCampaign({ ...body, createdById: req.auth!.userId });
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'campaign.create',
      entityType: 'Campaign',
      entityId: campaign.id,
      after: { kind: campaign.kind, title: campaign.title, audience: campaign.audience },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.status(201).json({ data: serializeCampaign(campaign) });
  }),
);

adminRouter.patch(
  '/campaigns/:id',
  asyncHandler(async (req, res) => {
    const body = parse(CampaignPatchSchema, req.body);
    const campaign = await updateCampaign(req.params.id, body);
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'campaign.update',
      entityType: 'Campaign',
      entityId: campaign.id,
      after: { enabled: campaign.enabled, title: campaign.title, priority: campaign.priority },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ data: serializeCampaign(campaign) });
  }),
);

adminRouter.delete(
  '/campaigns/:id',
  asyncHandler(async (req, res) => {
    await deleteCampaign(req.params.id);
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'campaign.delete',
      entityType: 'Campaign',
      entityId: req.params.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ data: { deleted: true } });
  }),
);

// ═════════════════════════════ BONUS PROGRAMME ═══════════════════════════════

adminRouter.get(
  '/bonus-promotions',
  asyncHandler(async (_req, res) => {
    const promotions = await prisma.bonusPromotion.findMany({
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: promotions.map(serializeBonusPromotion) });
  }),
);

function assertPromotionTerms(percentBps: number | null, fixedAmount: bigint | null): void {
  if ((percentBps === null) === (fixedAmount === null)) {
    throw Errors.badRequest(
      'Set exactly one of percentBps or fixedAmount',
      'PROMOTION_TERMS_INVALID',
    );
  }
}

adminRouter.post(
  '/bonus-promotions',
  asyncHandler(async (req, res) => {
    const body = parse(PromotionBodySchema, req.body);
    const percentBps = body.percentBps ?? null;
    const fixedAmount = body.fixedAmount === undefined || body.fixedAmount === null
      ? null
      : BigInt(body.fixedAmount);
    assertPromotionTerms(percentBps, fixedAmount);

    const promotion = await prisma.bonusPromotion.create({
      data: {
        code: body.code.trim().toUpperCase(),
        name: body.name,
        percentBps,
        fixedAmount,
        maxBonus: body.maxBonus == null ? null : BigInt(body.maxBonus),
        minDeposit: body.minDeposit == null ? null : BigInt(body.minDeposit),
        wageringMultiplier: body.wageringMultiplier,
        expiresInDays: body.expiresInDays,
        enabled: body.enabled,
        startsAt: body.startsAt ?? null,
        endsAt: body.endsAt ?? null,
        maxRedemptions: body.maxRedemptions ?? null,
        createdById: req.auth!.userId,
      },
    });
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'promotion.create',
      entityType: 'BonusPromotion',
      entityId: promotion.id,
      after: { code: promotion.code, percentBps, fixedAmount: fixedAmount?.toString() ?? null },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.status(201).json({ data: serializeBonusPromotion(promotion) });
  }),
);

adminRouter.patch(
  '/bonus-promotions/:id',
  asyncHandler(async (req, res) => {
    const body = parse(PromotionPatchSchema, req.body);
    const current = await prisma.bonusPromotion.findUnique({ where: { id: req.params.id } });
    if (!current) throw Errors.notFound('Promotion');

    const percentBps = body.percentBps === undefined ? current.percentBps : body.percentBps;
    const fixedAmount =
      body.fixedAmount === undefined
        ? current.fixedAmount
        : body.fixedAmount === null
          ? null
          : BigInt(body.fixedAmount);
    assertPromotionTerms(percentBps, fixedAmount);

    const promotion = await prisma.bonusPromotion.update({
      where: { id: current.id },
      data: {
        ...(body.code !== undefined ? { code: body.code.trim().toUpperCase() } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        percentBps,
        fixedAmount,
        ...(body.maxBonus !== undefined
          ? { maxBonus: body.maxBonus === null ? null : BigInt(body.maxBonus) }
          : {}),
        ...(body.minDeposit !== undefined
          ? { minDeposit: body.minDeposit === null ? null : BigInt(body.minDeposit) }
          : {}),
        ...(body.wageringMultiplier !== undefined
          ? { wageringMultiplier: body.wageringMultiplier }
          : {}),
        ...(body.expiresInDays !== undefined ? { expiresInDays: body.expiresInDays } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.startsAt !== undefined ? { startsAt: body.startsAt } : {}),
        ...(body.endsAt !== undefined ? { endsAt: body.endsAt } : {}),
        ...(body.maxRedemptions !== undefined ? { maxRedemptions: body.maxRedemptions } : {}),
      },
    });
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'promotion.update',
      entityType: 'BonusPromotion',
      entityId: promotion.id,
      before: { enabled: current.enabled },
      after: { enabled: promotion.enabled },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ data: serializeBonusPromotion(promotion) });
  }),
);

adminRouter.delete(
  '/bonus-promotions/:id',
  asyncHandler(async (req, res) => {
    const removed = await prisma.bonusPromotion.deleteMany({ where: { id: req.params.id } });
    if (removed.count === 0) throw Errors.notFound('Promotion');
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'promotion.delete',
      entityType: 'BonusPromotion',
      entityId: req.params.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ data: { deleted: true } });
  }),
);

adminRouter.get(
  '/bonuses',
  asyncHandler(async (req, res) => {
    const query = parse(
      z.object({
        userId: z.string().uuid().optional(),
        page: z.coerce.number().int().min(0).max(2000).default(0),
      }),
      req.query,
    );
    const where = query.userId ? { userId: query.userId } : {};
    const [total, bonuses] = await Promise.all([
      prisma.bonus.count({ where }),
      prisma.bonus.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.page * PAGE_SIZE,
        take: PAGE_SIZE,
        include: { user: { select: { displayName: true, phone: true } } },
      }),
    ]);
    res.json({
      data: bonuses.map((bonus) => ({
        ...serializeBonus(bonus),
        playerName: bonus.user.displayName,
        playerPhone: bonus.user.phone,
      })),
      page: { index: query.page, size: PAGE_SIZE, total },
    });
  }),
);

adminRouter.post(
  '/bonuses/grant',
  asyncHandler(async (req, res) => {
    const body = parse(GrantBonusSchema, req.body);
    const bonus = await grantBonus({
      userId: body.userId,
      amount: BigInt(body.amount),
      multiplier: body.multiplier,
      expiresInDays: body.expiresInDays,
      grantedById: req.auth!.userId,
      note: body.note,
    });
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'bonus.grant',
      entityType: 'Bonus',
      entityId: bonus.id,
      after: {
        userId: bonus.userId,
        amount: bonus.amount.toString(),
        target: bonus.target.toString(),
      },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.status(201).json({ data: serializeBonus(bonus) });
  }),
);

// ═══════════════════════════════ SETTINGS ════════════════════════════════════

adminRouter.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    const [referral, bonus] = await Promise.all([getReferralSettings(), getBonusSettings()]);
    res.json({
      data: {
        referral: {
          commissionBps: referral.commissionBps,
          minRakeToPay: referral.minRakeToPay.toString(),
        },
        bonus,
      },
    });
  }),
);

adminRouter.put(
  '/settings/referrals',
  asyncHandler(async (req, res) => {
    const body = parse(ReferralSettingsSchema, req.body);
    await setConfig(
      REFERRAL_CONFIG_KEY,
      {
        commissionBps: body.commissionBps,
        ...(body.minRakeToPay !== undefined ? { minRakeToPay: String(body.minRakeToPay) } : {}),
      },
      req.auth!.userId,
      'Referral programme: share of rake paid to referrers',
    );
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'settings.referral',
      entityType: 'SystemConfig',
      entityId: REFERRAL_CONFIG_KEY,
      after: body,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ data: body });
  }),
);

adminRouter.put(
  '/settings/bonuses',
  asyncHandler(async (req, res) => {
    const body = parse(BonusSettingsSchema, req.body);
    await setConfig(
      BONUS_CONFIG_KEY,
      body,
      req.auth!.userId,
      'Bonus programme defaults for admin grants',
    );
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'settings.bonus',
      entityType: 'SystemConfig',
      entityId: BONUS_CONFIG_KEY,
      after: body,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ data: body });
  }),
);

// ═══════════════════════════════ REFERRALS ═══════════════════════════════════

adminRouter.get(
  '/referrals',
  asyncHandler(async (_req, res) => {
    const grouped = await prisma.referralCommission.groupBy({
      by: ['referrerId'],
      _sum: { amount: true, rakeBase: true },
      _count: { _all: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: 50,
    });
    const users = await prisma.user.findMany({
      where: { id: { in: grouped.map((row) => row.referrerId) } },
      select: { id: true, displayName: true, phone: true },
    });
    const byId = new Map(users.map((user) => [user.id, user]));
    res.json({
      data: grouped.map((row) => ({
        referrerId: row.referrerId,
        referrerName: byId.get(row.referrerId)?.displayName ?? null,
        referrerPhone: byId.get(row.referrerId)?.phone ?? null,
        payments: row._count._all,
        rakeBase: (row._sum.rakeBase ?? 0n).toString(),
        amount: (row._sum.amount ?? 0n).toString(),
      })),
    });
  }),
);

// ═══════════════════════════ EXTERNAL GAME PROVIDERS ═════════════════════════

adminRouter.get(
  '/game-providers',
  asyncHandler(async (_req, res) => {
    const providers = await listProviderCatalog();
    res.json({
      data: providers.map((provider) => ({
        ...serializeGameProvider(provider),
        games: provider.games.map((game) => ({
          id: game.id,
          externalId: game.externalId,
          name: game.name,
          category: game.category,
          thumbnailUrl: game.thumbnailUrl,
          launchUrlTemplate: game.launchUrlTemplate,
          minStake: game.minStake?.toString() ?? null,
          maxStake: game.maxStake?.toString() ?? null,
          maxWin: game.maxWin?.toString() ?? null,
          enabled: game.enabled,
          sortOrder: game.sortOrder,
        })),
      })),
    });
  }),
);

adminRouter.get(
  '/game-providers/settings',
  asyncHandler(async (_req, res) => {
    const stored = await getConfig<string | null>(PROVIDER_MAX_WIN_CONFIG_KEY, null);
    res.json({
      data: {
        maxWin:
          typeof stored === 'string' && /^\d+$/.test(stored) && BigInt(stored) > 0n
            ? stored
            : DEFAULT_PROVIDER_MAX_WIN.toString(),
        defaultMaxWin: DEFAULT_PROVIDER_MAX_WIN.toString(),
      },
    });
  }),
);

adminRouter.put(
  '/game-providers/settings',
  asyncHandler(async (req, res) => {
    const body = parse(ProviderMaxWinSchema, req.body);
    await setConfig(PROVIDER_MAX_WIN_CONFIG_KEY, String(body.maxWin), req.auth!.userId);
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'provider.max_win',
      entityType: 'SystemConfig',
      entityId: PROVIDER_MAX_WIN_CONFIG_KEY,
      after: { maxWin: String(body.maxWin) },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ data: { maxWin: String(body.maxWin) } });
  }),
);

adminRouter.put(
  '/game-providers/:code',
  asyncHandler(async (req, res) => {
    const body = parse(ProviderBodySchema, req.body);
    const provider = await upsertProvider({
      code: req.params.code,
      name: body.name,
      kind: body.kind,
      apiBaseUrl: body.apiBaseUrl,
      webhookSecret: body.webhookSecret,
      currency: body.currency,
      maxWin: body.maxWin === undefined || body.maxWin === null ? body.maxWin : BigInt(body.maxWin),
      enabled: body.enabled,
      sortOrder: body.sortOrder,
      config: body.config,
    });
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'provider.game_upsert',
      entityType: 'GameProvider',
      entityId: provider.code,
      after: {
        enabled: provider.enabled,
        kind: provider.kind,
        currency: provider.currency,
        maxWin: provider.maxWin?.toString() ?? null,
      },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ data: serializeGameProvider(provider) });
  }),
);

adminRouter.delete(
  '/game-providers/:code',
  asyncHandler(async (req, res) => {
    await deleteProvider(req.params.code);
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'provider.game_delete',
      entityType: 'GameProvider',
      entityId: req.params.code,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ data: { deleted: true } });
  }),
);

adminRouter.post(
  '/game-providers/:code/games',
  asyncHandler(async (req, res) => {
    const body = parse(GameBodySchema, req.body);
    const game = await upsertGame(req.params.code, {
      externalId: body.externalId,
      name: body.name,
      category: body.category,
      thumbnailUrl: body.thumbnailUrl,
      launchUrlTemplate: body.launchUrlTemplate,
      minStake: body.minStake == null ? null : BigInt(body.minStake),
      maxStake: body.maxStake == null ? null : BigInt(body.maxStake),
      maxWin: body.maxWin == null ? null : BigInt(body.maxWin),
      enabled: body.enabled,
      sortOrder: body.sortOrder,
    });
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'provider.game_catalog',
      entityType: 'ProviderGame',
      entityId: game.id,
      after: { provider: req.params.code, externalId: game.externalId },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.status(201).json({
      data: {
        id: game.id,
        externalId: game.externalId,
        name: game.name,
        enabled: game.enabled,
      },
    });
  }),
);

adminRouter.delete(
  '/game-providers/:code/games/:externalId',
  asyncHandler(async (req, res) => {
    await deleteGame(req.params.code, req.params.externalId);
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'provider.game_remove',
      entityType: 'ProviderGame',
      entityId: `${req.params.code}:${req.params.externalId}`,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ data: { deleted: true } });
  }),
);

adminRouter.get(
  '/game-providers/:code/callbacks',
  asyncHandler(async (req, res) => {
    const query = parse(ProviderCallbacksQuery, req.query);
    const where = { providerCode: req.params.code };
    const [total, logs] = await Promise.all([
      prisma.providerCallbackLog.count({ where }),
      prisma.providerCallbackLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.page * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ]);
    res.json({
      data: logs.map((log) => ({
        id: log.id,
        type: log.type,
        externalTxnId: log.externalTxnId,
        externalSessionId: log.externalSessionId,
        signatureValid: log.signatureValid,
        httpStatus: log.httpStatus,
        amount: log.amount?.toString() ?? null,
        currency: log.currency,
        error: log.error,
        ip: log.ip,
        payload: log.payload,
        createdAt: log.createdAt,
      })),
      page: { index: query.page, size: PAGE_SIZE, total },
    });
  }),
);

adminRouter.get(
  '/game-providers/:code/transactions',
  asyncHandler(async (req, res) => {
    const query = parse(ProviderTransactionsQuery, req.query);
    const where = {
      providerCode: req.params.code,
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [total, transactions] = await Promise.all([
      prisma.providerTransaction.count({ where }),
      prisma.providerTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.page * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          user: { select: { displayName: true, phone: true } },
          session: { select: { externalSessionId: true } },
        },
      }),
    ]);
    res.json({
      data: transactions.map((transaction) => ({
        id: transaction.id,
        type: transaction.type,
        externalTxnId: transaction.externalTxnId,
        status: transaction.status,
        amount: transaction.amount.toString(),
        currency: transaction.currency,
        ledgerId: transaction.ledgerId,
        user: transaction.user,
        externalSessionId: transaction.session?.externalSessionId ?? null,
        createdAt: transaction.createdAt,
      })),
      page: { index: query.page, size: PAGE_SIZE, total },
    });
  }),
);
