import { Router } from 'express';
import { DepositStatus, PaymentMethod, WithdrawalStatus } from '@prisma/client';
import { z } from 'zod';
import { parse } from '../lib/validate';
import { asyncHandler } from '../lib/async';
import { Errors } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { serializeDeposit, serializeWallet, serializeWithdrawal } from '../lib/serializers';
import { authenticate, requireVerifiedPhone } from '../middleware/auth';
import { moneyLimiter } from '../middleware/rateLimit';
import { findAgentByCode } from '../services/agents';
import {
  createDeposit,
  listPlayerDeposits,
} from '../services/deposits';
import {
  cancelWithdrawal,
  createWithdrawal,
  listPlayerWithdrawals,
} from '../services/withdrawals';
import { getPlayerWallet, scopedIdempotencyKey } from '../services/wallet';

const minorAmount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const CreateDepositSchema = z
  .object({
    amount: minorAmount,
    method: z.nativeEnum(PaymentMethod),
    agentProfileId: z.string().uuid().optional(),
    agentCode: z.string().max(16).optional(),
    paymentAccountId: z.string().uuid().optional(),
    externalRef: z.string().max(128).optional(),
    receiptUrl: z.string().url().max(2048).optional(),
    playerNote: z.string().max(500).optional(),
  })
  .refine((value) => !(value.agentProfileId && value.agentCode), {
    message: 'Provide agentProfileId or agentCode, not both',
    path: ['agentCode'],
  });

const CreateWithdrawalSchema = z.object({
  amount: minorAmount,
  method: z.nativeEnum(PaymentMethod),
  agentProfileId: z.string().uuid(),
  paymentAccountId: z.string().uuid().optional(),
  playerNote: z.string().max(500).optional(),
});

const StatusQuery = z.object({
  status: z.nativeEnum(DepositStatus).optional(),
});

const WithdrawalStatusQuery = z.object({
  status: z.nativeEnum(WithdrawalStatus).optional(),
});

const HistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const walletRouter = Router();

walletRouter.use(authenticate);

walletRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const wallet = await getPlayerWallet(req.auth!.userId);
    res.json({ data: serializeWallet(wallet) });
  }),
);

walletRouter.get(
  '/transactions',
  asyncHandler(async (req, res) => {
    const { limit } = parse(HistoryQuery, req.query);
    const entries = await prisma.ledgerEntry.findMany({
      where: { account: { ownerKind: 'USER', ownerId: req.auth!.userId } },
      include: {
        account: { select: { code: true } },
        ledger: {
          select: { kind: true, refType: true, refId: true, memo: true, createdAt: true, id: true },
        },
      },
      orderBy: { id: 'desc' },
      take: limit,
    });
    res.json({
      data: entries.map((entry) => ({
        id: entry.id.toString(),
        account: entry.account.code,
        amount: entry.amount,
        balanceAfter: entry.balanceAfter,
        kind: entry.ledger.kind,
        refType: entry.ledger.refType,
        refId: entry.ledger.refId,
        memo: entry.ledger.memo,
        ledgerId: entry.ledger.id,
        createdAt: entry.ledger.createdAt,
      })),
    });
  }),
);

walletRouter.post(
  '/deposits',
  moneyLimiter,
  asyncHandler(async (req, res) => {
    const body = parse(CreateDepositSchema, req.body);
    const idempotencyKey = scopedIdempotencyKey(req);

    let agentProfileId = body.agentProfileId;
    if (!agentProfileId && body.agentCode) {
      const agent = await findAgentByCode(body.agentCode);
      if (!agent) throw Errors.notFound('Agent');
      agentProfileId = agent.id;
    }

    const { deposit, replayed } = await createDeposit({
      playerId: req.auth!.userId,
      agentProfileId,
      paymentAccountId: body.paymentAccountId,
      method: body.method,
      amount: BigInt(body.amount),
      externalRef: body.externalRef,
      receiptUrl: body.receiptUrl,
      playerNote: body.playerNote,
      idempotencyKey,
    });

    res.status(replayed ? 200 : 201).json({ data: serializeDeposit(deposit), replayed });
  }),
);

walletRouter.get(
  '/deposits',
  asyncHandler(async (req, res) => {
    const query = parse(StatusQuery, req.query);
    const deposits = await listPlayerDeposits(req.auth!.userId, query.status);
    res.json({ data: deposits.map(serializeDeposit) });
  }),
);

walletRouter.get(
  '/deposits/:id',
  asyncHandler(async (req, res) => {
    const deposit = await prisma.depositRequest.findFirst({
      where: { id: req.params.id, playerId: req.auth!.userId },
    });
    if (!deposit) throw Errors.notFound('Deposit');
    res.json({ data: serializeDeposit(deposit) });
  }),
);

walletRouter.post(
  '/withdrawals',
  requireVerifiedPhone,
  moneyLimiter,
  asyncHandler(async (req, res) => {
    const body = parse(CreateWithdrawalSchema, req.body);
    const { withdrawal, replayed } = await createWithdrawal({
      playerId: req.auth!.userId,
      agentProfileId: body.agentProfileId,
      paymentAccountId: body.paymentAccountId,
      method: body.method,
      amount: BigInt(body.amount),
      playerNote: body.playerNote,
      idempotencyKey: scopedIdempotencyKey(req),
    });
    res.status(replayed ? 200 : 201).json({ data: serializeWithdrawal(withdrawal), replayed });
  }),
);

walletRouter.get(
  '/withdrawals',
  asyncHandler(async (req, res) => {
    const query = parse(WithdrawalStatusQuery, req.query);
    const withdrawals = await listPlayerWithdrawals(req.auth!.userId, query.status);
    res.json({ data: withdrawals.map(serializeWithdrawal) });
  }),
);

walletRouter.post(
  '/withdrawals/:id/cancel',
  asyncHandler(async (req, res) => {
    const withdrawal = await cancelWithdrawal(req.auth!.userId, req.params.id);
    res.json({ data: serializeWithdrawal(withdrawal) });
  }),
);
