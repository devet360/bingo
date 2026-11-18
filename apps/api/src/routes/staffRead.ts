import { Router } from 'express';
import {
  DepositStatus,
  LedgerKind,
  SupportTicketStatus,
  UserRole,
  UserStatus,
  VerificationStatus,
  WithdrawalStatus,
  type Prisma,
} from '@prisma/client';
import { z } from 'zod';
import { parse } from '../lib/validate';
import { asyncHandler } from '../lib/async';
import { Errors } from '../lib/errors';
import { minorToWire } from '../lib/money';
import { prisma } from '../lib/prisma';
import {
  serializeAgent,
  serializeDeposit,
  serializeLedger,
  serializeProof,
  serializeSupportMessage,
  serializeSupportTicket,
  serializeUser,
  serializeWallet,
  serializeWithdrawal,
} from '../lib/serializers';
import { authenticate, requireRole } from '../middleware/auth';
import { writeAudit } from '../services/audit';
import { cancelWithdrawalByStaff } from '../services/withdrawals';
import { reviewWithdrawalProof } from '../services/withdrawalProofs';
import { closeAgentTask } from '../services/agentTasks';
import { confirmManualReceipt, recheckDepositReceipt } from '../services/receipts/deposits';
import { checkReceipt } from '../services/receipts/checker';
import { listAllProviders, serializeProvider } from '../services/providers';
import {
  SUPPORT_PAGE_SIZE,
  claimSupportTicket,
  getSupportTicketDetail,
  listSupportTickets,
  replyToTicketAsStaff,
  resolveSupportTicket,
} from '../services/support';
import { runTransaction } from '../lib/tx';

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

const ListReceiptsQuery = z.object({
  status: z.nativeEnum(VerificationStatus).optional(),
  providerCode: z.string().trim().max(32).optional(),
  page: z.coerce.number().int().min(0).max(2000).default(0),
});

const UserStatusSchema = z.object({
  status: z.enum([UserStatus.ACTIVE, UserStatus.SUSPENDED]),
});

const ProofReviewSchema = z.object({
  decision: z.enum(['VERIFIED', 'FAILED']),
  note: z.string().trim().max(500).optional(),
});

const DepositParams = z.object({ depositId: z.string().uuid() });

/** The amount a person read on the bank's receipt page, in minor units. */
const ConfirmReceiptSchema = z.object({
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

const ReceiptCheckSchema = z.object({
  providerCode: z.string().trim().min(1).max(64),
  reference: z.string().trim().min(1).max(512),
  accountNumber: z.string().trim().max(64).optional(),
  phoneNumber: z.string().trim().max(32).optional(),
  payload: z
    .object({
      contentType: z.string().trim().max(128).optional(),
      bodyBase64: z.string().min(1),
    })
    .optional(),
});

const ProofReviewParams = z.object({
  withdrawalId: z.string().uuid(),
  proofId: z.string().uuid(),
});

const TicketParams = z.object({ ticketId: z.string().uuid() });

const ListTicketsQuery = z.object({
  status: z.nativeEnum(SupportTicketStatus).optional(),
  assignee: z.string().trim().max(36).optional(),
  query: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().min(0).max(2000).default(0),
});

const TicketReplySchema = z.object({
  body: z.string().trim().min(1).max(4000),
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
          payoutAccount: { select: { accountName: true, accountNumber: true, provider: true } },
          proofs: { orderBy: { createdAt: 'desc' }, take: 3 },
          task: { select: { status: true, slaDeadline: true } },
        },
      }),
    ]);
    res.json({
      data: withdrawals.map((withdrawal) => ({
        ...serializeWithdrawal(withdrawal),
        player: withdrawal.player,
        agentCode: withdrawal.agentProfile?.agentCode ?? null,
        payoutAccount: withdrawal.payoutAccount,
        proofs: withdrawal.proofs.map(serializeProof),
        task: withdrawal.task,
      })),
      page: { index: query.page, size: PAGE_SIZE, total },
    });
  }),
);

staffReadRouter.get(
  '/receipts',
  asyncHandler(async (req, res) => {
    const query = parse(ListReceiptsQuery, req.query);
    const where: Prisma.ReceiptVerificationWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.providerCode ? { providerCode: query.providerCode } : {}),
    };
    const [total, receipts] = await Promise.all([
      prisma.receiptVerification.count({ where }),
      prisma.receiptVerification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.page * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          provider: { select: { name: true } },
          deposit: {
            select: {
              code: true,
              amount: true,
              status: true,
              autoVerified: true,
              player: { select: { displayName: true, phone: true } },
            },
          },
        },
      }),
    ]);
    res.json({
      data: receipts.map((receipt) => ({
        id: receipt.id,
        providerCode: receipt.providerCode,
        providerName: receipt.provider.name,
        reference: receipt.reference,
        status: receipt.status,
        source: receipt.source,
        amount: receipt.amount,
        currency: receipt.currency,
        senderName: receipt.senderName,
        senderAccount: receipt.senderAccount,
        receiverName: receipt.receiverName,
        receiverAccount: receipt.receiverAccount,
        transactionDate: receipt.transactionDate,
        transactionStatus: receipt.transactionStatus,
        message: receipt.message,
        attempts: receipt.attempts,
        verifiedAt: receipt.verifiedAt,
        createdAt: receipt.createdAt,
        deposit: receipt.deposit
          ? {
              code: receipt.deposit.code,
              amount: receipt.deposit.amount,
              status: receipt.deposit.status,
              autoVerified: receipt.deposit.autoVerified,
              player: receipt.deposit.player,
            }
          : null,
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
      include: {
        user: { select: { displayName: true, avatarUrl: true, status: true } },
        paymentAccounts: { where: { isActive: true }, orderBy: { createdAt: 'asc' } },
      },
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

staffReadRouter.get(
  '/withdrawals/:withdrawalId/proofs',
  asyncHandler(async (req, res) => {
    const proofs = await prisma.withdrawalProof.findMany({
      where: { withdrawalId: req.params.withdrawalId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: proofs.map(serializeProof) });
  }),
);

staffReadRouter.post(
  '/withdrawals/:withdrawalId/proofs/:proofId/review',
  asyncHandler(async (req, res) => {
    const params = parse(ProofReviewParams, req.params);
    const body = parse(ProofReviewSchema, req.body);
    const proof = await reviewWithdrawalProof({
      staffUserId: req.auth!.userId,
      withdrawalId: params.withdrawalId,
      proofId: params.proofId,
      decision: body.decision,
      note: body.note,
    });
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: body.decision === 'VERIFIED' ? 'withdrawal.proof_approve' : 'withdrawal.proof_reject',
      entityType: 'WithdrawalProof',
      entityId: proof.id,
      after: { withdrawalId: proof.withdrawalId, status: proof.status, note: body.note ?? null },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ data: serializeProof(proof) });
  }),
);

staffReadRouter.post(
  '/withdrawals/:withdrawalId/cancel',
  asyncHandler(async (req, res) => {
    const before = await prisma.withdrawalRequest.findUnique({
      where: { id: req.params.withdrawalId },
      select: { status: true },
    });
    if (!before) throw Errors.notFound('Withdrawal');
    const withdrawal = await cancelWithdrawalByStaff(req.params.withdrawalId);
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'withdrawal.cancel',
      entityType: 'WithdrawalRequest',
      entityId: withdrawal.id,
      before: { status: before.status },
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
    const updated = await runTransaction(async (tx) => {
      const deposit = await tx.depositRequest.findUnique({
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
      await closeAgentTask(tx, { depositId: deposit.id }, 'CANCELLED');
      return tx.depositRequest.update({
        where: { id: deposit.id },
        data: { status: DepositStatus.CANCELLED },
      });
    });
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'deposit.cancel',
      entityType: 'DepositRequest',
      entityId: updated.id,
      before: { status: 'PENDING/PROCESSING' },
      after: { status: updated.status },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ data: serializeDeposit(updated) });
  }),
);

staffReadRouter.post(
  '/deposits/:depositId/recheck-receipt',
  asyncHandler(async (req, res) => {
    const params = parse(DepositParams, req.params);
    const { check, deposit } = await recheckDepositReceipt({ depositId: params.depositId });
    res.json({ data: serializeDeposit(deposit), receipt: check });
  }),
);

staffReadRouter.post(
  '/deposits/:depositId/confirm-receipt',
  asyncHandler(async (req, res) => {
    const params = parse(DepositParams, req.params);
    const body = parse(ConfirmReceiptSchema, req.body);
    const before = await prisma.depositRequest.findUnique({
      where: { id: params.depositId },
      select: { verificationStatus: true, receiptReference: true },
    });
    if (!before) throw Errors.notFound('Deposit');
    const deposit = await confirmManualReceipt({
      depositId: params.depositId,
      actorUserId: req.auth!.userId,
      amount: BigInt(body.amount),
    });
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'deposit.receiptConfirm',
      entityType: 'DepositRequest',
      entityId: deposit.id,
      before: { verificationStatus: before.verificationStatus, reference: before.receiptReference },
      after: {
        verificationStatus: deposit.verificationStatus,
        reference: deposit.receiptReference,
        amount: body.amount,
      },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ data: serializeDeposit(deposit) });
  }),
);

/** Read-only receipt lookup: no deposit needed and nothing is stored. */
staffReadRouter.get(
  '/receipt-providers',
  asyncHandler(async (_req, res) => {
    const providers = await listAllProviders();
    res.json({ data: providers.map(serializeProvider) });
  }),
);

staffReadRouter.post(
  '/receipts/check',
  asyncHandler(async (req, res) => {
    const body = parse(ReceiptCheckSchema, req.body);
    res.json({ data: await checkReceipt(body) });
  }),
);

staffReadRouter.get(
  '/tickets',
  asyncHandler(async (req, res) => {
    const query = parse(ListTicketsQuery, req.query);
    const { total, tickets } = await listSupportTickets(
      {
        statuses: query.status ? [query.status] : undefined,
        assignee: query.assignee,
        query: query.query,
        page: query.page,
      },
      req.auth!.userId,
    );
    res.json({
      data: tickets.map((ticket) => ({
        ...serializeSupportTicket(ticket),
        player: ticket.player,
        assignee: ticket.assignee,
        preview: ticket.messages[0] ?? null,
      })),
      page: { index: query.page, size: SUPPORT_PAGE_SIZE, total },
    });
  }),
);

staffReadRouter.get(
  '/tickets/:ticketId',
  asyncHandler(async (req, res) => {
    const params = parse(TicketParams, req.params);
    const { ticket, wallet, deposits, withdrawals } = await getSupportTicketDetail(params.ticketId);
    res.json({
      data: {
        ticket: {
          ...serializeSupportTicket(ticket),
          player: ticket.player,
          assignee: ticket.assignee,
        },
        messages: ticket.messages.map(serializeSupportMessage),
        wallet: wallet
          ? {
              available: minorToWire(wallet.available),
              bonus: minorToWire(wallet.bonus),
              escrow: minorToWire(wallet.escrow),
              locked: minorToWire(wallet.locked),
            }
          : null,
        deposits: deposits.map((deposit) => ({
          id: deposit.id,
          code: deposit.code,
          amount: minorToWire(deposit.amount),
          status: deposit.status,
          method: deposit.method,
          createdAt: deposit.createdAt,
        })),
        withdrawals: withdrawals.map((withdrawal) => ({
          id: withdrawal.id,
          amount: minorToWire(withdrawal.amount),
          netAmount: minorToWire(withdrawal.netAmount),
          status: withdrawal.status,
          method: withdrawal.method,
          createdAt: withdrawal.createdAt,
        })),
      },
    });
  }),
);

staffReadRouter.post(
  '/tickets/:ticketId/messages',
  asyncHandler(async (req, res) => {
    const params = parse(TicketParams, req.params);
    const body = parse(TicketReplySchema, req.body);
    const { ticket, message } = await replyToTicketAsStaff({
      ticketId: params.ticketId,
      staffUserId: req.auth!.userId,
      body: body.body,
    });
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'support.reply',
      entityType: 'SupportTicket',
      entityId: ticket.id,
      after: { code: ticket.code, messageId: message.id, status: ticket.status },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.status(201).json({
      data: {
        ticket: serializeSupportTicket(ticket),
        message: serializeSupportMessage(message),
      },
    });
  }),
);

staffReadRouter.post(
  '/tickets/:ticketId/claim',
  asyncHandler(async (req, res) => {
    const params = parse(TicketParams, req.params);
    const ticket = await claimSupportTicket(params.ticketId, req.auth!.userId);
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'support.claim',
      entityType: 'SupportTicket',
      entityId: ticket.id,
      after: { code: ticket.code, assigneeId: ticket.assigneeId },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ data: serializeSupportTicket(ticket) });
  }),
);

staffReadRouter.post(
  '/tickets/:ticketId/resolve',
  asyncHandler(async (req, res) => {
    const params = parse(TicketParams, req.params);
    const { ticket, message } = await resolveSupportTicket(params.ticketId, req.auth!.userId);
    await writeAudit({
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'support.resolve',
      entityType: 'SupportTicket',
      entityId: ticket.id,
      after: { code: ticket.code, status: ticket.status, messageId: message?.id ?? null },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({
      data: {
        ticket: serializeSupportTicket(ticket),
        message: message ? serializeSupportMessage(message) : null,
      },
    });
  }),
);
