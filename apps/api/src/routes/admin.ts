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
import { createAgent, topUpAgentFloat, updateAutoDepositSettings } from '../services/agents';
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
