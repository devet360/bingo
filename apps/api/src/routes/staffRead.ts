import { Router } from 'express';
import {
  DepositStatus,
  LedgerKind,
  UserRole,
  UserStatus,
  WithdrawalStatus,
  type Prisma,
} from '@prisma/client';
import { z } from 'zod';
import { parse } from '../lib/validate';
import { asyncHandler } from '../lib/async';
import { Errors } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { serializeAgent, serializeDeposit, serializeLedger, serializeUser, serializeWallet, serializeWithdrawal } from '../lib/serializers';
import { authenticate, requireRole } from '../middleware/auth';
import { writeAudit } from '../services/audit';
import { cancelWithdrawalByStaff } from '../services/withdrawals';

const PAGE_SIZE = 25;

const ListUsersQuery = z.object({
  query: z.string().trim().max(64).optional(),
  role: z.nativeEnum(UserRole).optional(),
  status: z.nativeEnum(UserStatus).optional(),
  page: z.coerce.number().int().min(0).max(2000).default(0),
});

const ListTransactionsQuery = z.object({
  userId: z.string().uuid().optional(),
  kind: z.nativeEnum(LedgerKind).optional(),
  refType: z.string().max(64).optional(),
  page: z.coerce.number().int().min(0).max(2000).default(0),
});

const ListDepositsQuery = z.object({
  status: z.nativeEnum(DepositStatus).optional(),
  userId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(0).max(2000).default(0),
});

const ListWithdrawalsQuery = z.object({
  status: z.nativeEnum(WithdrawalStatus).optional(),
  userId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(0).max(2000).default(0),
});

const UserStatusSchema = z.object({
  status: z.enum([UserStatus.ACTIVE, UserStatus.SUSPENDED]),
});

function userSearchWhere(query: string | undefined): Prisma.UserWhereInput {
  if (!query) return {};
  const numeric = /^\d{1,20}$/.test(query) ? BigInt(query) : null;
  return {
    OR: [
      { displayName: { contains: query, mode: 'insensitive' } },
      { phone: { contains: query } },
      { email: { contains: query, mode: 'insensitive' } },
      { telegramUsername: { contains: query, mode: 'insensitive' } },
      { referralCode: query.toUpperCase() },
      ...(numeric ? [{ telegramId: numeric }] : []),
    ],
  };
}

/**
 * Read-only and time-limited assist endpoints shared by support and super admin.
 * Mounted under both /support and /admin. Every mutation is audited.
 */
export const staffReadRouter = Router();

staffReadRouter.use(authenticate, requireRole(UserRole.SUPPORT, UserRole.SUPER_ADMIN));

staffReadRouter.get(
  '/users',
  asyncHandler(async (req, res) => {
    const query = parse(ListUsersQuery, req.query);
    const where: Prisma.UserWhereInput = {
      ...(query.role ? { role: query.role } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...userSearchWhere(query.query),
    };
    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.page * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ]);
    res.json({
      data: users.map(serializeUser),
      page: { index: query.page, size: PAGE_SIZE, total },
    });
  }),
);

staffReadRouter.get(
  '/users/:userId',
  asyncHandler(async (req, res) => {
    const userId = req.params.userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { wallet: true, agentProfile: true },
    });
    if (!user) throw Errors.notFound('User');

    const [depositCount, withdrawalCount, cardCount, winCount, ledgers, deposits, withdrawals] =
      await Promise.all([
        prisma.depositRequest.count({ where: { playerId: userId } }),
        prisma.withdrawalRequest.count({ where: { playerId: userId } }),
        prisma.bingoCard.count({ where: { userId } }),
        prisma.roundWinner.count({ where: { userId } }),
        prisma.transactionLedger.findMany({
          where: { entries: { some: { account: { ownerKind: 'USER', ownerId: userId } } } },
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: {
            entries: {
              include: { account: { select: { code: true, ownerKind: true, ownerId: true } } },
            },
          },
        }),
        prisma.depositRequest.findMany({
          where: { playerId: userId },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
        prisma.withdrawalRequest.findMany({
          where: { playerId: userId },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
      ]);

    res.json({
      data: {
        user: serializeUser(user),
        wallet: user.wallet ? serializeWallet(user.wallet) : null,
        agent: user.agentProfile ? serializeAgent(user.agentProfile, { includeBalances: true }) : null,
        counts: {
          deposits: depositCount,
          withdrawals: withdrawalCount,
          cards: cardCount,
          wins: winCount,
        },
        transactions: ledgers.map(serializeLedger),
        deposits: deposits.map(serializeDeposit),
        withdrawals: withdrawals.map(serializeWithdrawal),
      },
    });
  }),
);

staffReadRouter.get(
  '/transactions',
  asyncHandler(async (req, res) => {
    const query = parse(ListTransactionsQuery, req.query);
    const where: Prisma.TransactionLedgerWhereInput = {
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.refType ? { refType: query.refType } : {}),
      ...(query.userId
        ? { entries: { some: { account: { ownerKind: 'USER', ownerId: query.userId } } } }
        : {}),
    };
    const [total, ledgers] = await Promise.all([
      prisma.transactionLedger.count({ where }),
      prisma.transactionLedger.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.page * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          entries: {
            include: { account: { select: { code: true, ownerKind: true, ownerId: true } } },
          },
        },
      }),
    ]);
    res.json({ data: ledgers.map(serializeLedger), page: { index: query.page, size: PAGE_SIZE, total } });
  }),
);

staffReadRouter.get(
  '/deposits',
  asyncHandler(async (req, res) => {
    const query = parse(ListDepositsQuery, req.query);
    const where: Prisma.DepositRequestWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.userId ? { playerId: query.userId } : {}),
    };
    const [total, deposits] = await Promise.all([
      prisma.depositRequest.count({ where }),
      prisma.depositRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.page * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          player: { select: { displayName: true, phone: true } },
          agentProfile: { select: { agentCode: true } },
        },
      }),
    ]);
    res.json({
      data: deposits.map((deposit) => ({
        ...serializeDeposit(deposit),
        player: deposit.player,
        agentCode: deposit.agentProfile?.agentCode ?? null,
      })),
      page: { index: query.page, size: PAGE_SIZE, total },
    });
  }),
);

staffReadRouter.get(
  '/withdrawals',
  asyncHandler(async (req, res) => {
    const query = parse(ListWithdrawalsQuery, req.query);
    const where: Prisma.WithdrawalRequestWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.userId ? { playerId: query.userId } : {}),
    };
    const [total, withdrawals] = await Promise.all([
      prisma.withdrawalRequest.count({ where }),
      prisma.withdrawalRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.page * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          player: { select: { displayName: true, phone: true } },
          agentProfile: { select: { agentCode: true } },
        },
      }),
    ]);
    res.json({
      data: withdrawals.map((withdrawal) => ({
        ...serializeWithdrawal(withdrawal),
        player: withdrawal.player,
        agentCode: withdrawal.agentProfile.agentCode,
      })),
      page: { index: query.page, size: PAGE_SIZE, total },
    });
  }),
);

staffReadRouter.get(
  '/agents',
  asyncHandler(async (_req, res) => {
    const agents = await prisma.agentProfile.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { user: { select: { displayName: true, avatarUrl: true, status: true } } },
    });
    res.json({ data: agents.map((agent) => serializeAgent(agent, { includeBalances: true })) });
  }),
);

staffReadRouter.post(
  '/users/:userId/status',
  asyncHandler(async (req, res) => {
    const body = parse(UserStatusSchema, req.body);
    const target = await prisma.user.findUnique({
      where: { id: req.params.userId },
      select: { id: true, role: true, status: true, displayName: true },
    });
    if (!target) throw Errors.notFound('User');
    if (target.role === UserRole.SUPER_ADMIN && req.auth!.role !== UserRole.SUPER_ADMIN) {
      throw Errors.forbidden('Only a super admin can modify another super admin', 'ROLE_FORBIDDEN');
    }
    if (target.id === req.auth!.userId) {
      throw Errors.badRequest('You cannot change your own account status', 'SELF_STATUS_CHANGE');
    }

    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: target.id }, data: { status: body.status } });
      if (body.status === UserStatus.SUSPENDED) {
        await tx.authSession.updateMany({
          where: { userId: target.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
    });
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'user.status',
      entityType: 'User',
      entityId: target.id,
      before: { status: target.status },
      after: { status: body.status },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ data: { userId: target.id, status: body.status } });
  }),
);

staffReadRouter.post(
  '/withdrawals/:withdrawalId/cancel',
  asyncHandler(async (req, res) => {
    const withdrawal = await cancelWithdrawalByStaff(req.params.withdrawalId);
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'withdrawal.cancel',
      entityType: 'WithdrawalRequest',
      entityId: withdrawal.id,
      before: { status: 'ESCROWED' },
      after: { status: withdrawal.status },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ data: serializeWithdrawal(withdrawal) });
  }),
);

staffReadRouter.post(
  '/deposits/:depositId/cancel',
  asyncHandler(async (req, res) => {
    const deposit = await prisma.depositRequest.findUnique({
      where: { id: req.params.depositId },
      select: { id: true, status: true },
    });
    if (!deposit) throw Errors.notFound('Deposit');
    if (
      deposit.status !== DepositStatus.PENDING &&
      deposit.status !== DepositStatus.PROCESSING
    ) {
      throw Errors.conflict('Only open deposits can be cancelled', 'DEPOSIT_NOT_OPEN');
    }
    const updated = await prisma.depositRequest.update({
      where: { id: deposit.id },
      data: { status: DepositStatus.CANCELLED },
    });
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'deposit.cancel',
      entityType: 'DepositRequest',
      entityId: deposit.id,
      before: { status: deposit.status },
      after: { status: updated.status },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ data: serializeDeposit(updated) });
  }),
);
