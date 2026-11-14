import { Router } from 'express';
import { DepositStatus, WithdrawalStatus } from '@prisma/client';
import { z } from 'zod';
import { parse } from '../lib/validate';
import { asyncHandler } from '../lib/async';
import { prisma } from '../lib/prisma';
import {
  serializeAgent,
  serializeCommission,
  serializeDeposit,
  serializeWallet,
  serializeWithdrawal,
} from '../lib/serializers';
import { authenticate, requireAgent } from '../middleware/auth';
import {
  claimDeposit,
  creditDeposit,
  listAgentDeposits,
  rejectDeposit,
} from '../services/deposits';
import {
  listAgentWithdrawals,
  redeemWithdrawal,
} from '../services/withdrawals';
import { getPlayerWallet } from '../services/wallet';
import { setAgentPresence } from '../services/agents';

const CodeParams = z.object({ code: z.string().regex(/^\d{6}$/, 'Expected a 6-digit code') });

const CreditSchema = z.object({
  creditedAmount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  note: z.string().max(500).optional(),
});

const RejectSchema = z.object({ note: z.string().max(500).optional() });

const RedeemSchema = z.object({
  payoutCode: z.string().regex(/^\d{6}$/, 'Expected a 6-digit payout code'),
  note: z.string().max(500).optional(),
});

const PresenceSchema = z.object({ isOnline: z.boolean() });

const DepositQueueQuery = z.object({ status: z.nativeEnum(DepositStatus).optional() });
const WithdrawalQueueQuery = z.object({ status: z.nativeEnum(WithdrawalStatus).optional() });
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

export const agentRouter = Router();

agentRouter.use(authenticate, requireAgent);

agentRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    const wallet = await getPlayerWallet(req.auth!.userId);
    res.json({
      data: {
        agent: serializeAgent(req.agent!, { includeBalances: true }),
        wallet: serializeWallet(wallet),
      },
    });
  }),
);

agentRouter.post(
  '/presence',
  asyncHandler(async (req, res) => {
    const body = parse(PresenceSchema, req.body);
    const agent = await setAgentPresence(req.auth!.userId, body.isOnline);
    res.json({ data: serializeAgent(agent, { includeBalances: true }) });
  }),
);

agentRouter.get(
  '/deposits',
  asyncHandler(async (req, res) => {
    const query = parse(DepositQueueQuery, req.query);
    const deposits = await listAgentDeposits(req.agent!.id, query.status);
    res.json({ data: deposits.map(serializeDeposit) });
  }),
);

agentRouter.post(
  '/deposits/:code/claim',
  asyncHandler(async (req, res) => {
    const params = parse(CodeParams, req.params);
    const deposit = await claimDeposit(req.auth!.userId, params.code);
    res.json({ data: serializeDeposit(deposit) });
  }),
);

agentRouter.post(
  '/deposits/:code/credit',
  asyncHandler(async (req, res) => {
    const params = parse(CodeParams, req.params);
    const body = parse(CreditSchema, req.body);
    const { deposit, replayed } = await creditDeposit({
      agentUserId: req.auth!.userId,
      code: params.code,
      creditedAmount: body.creditedAmount ? BigInt(body.creditedAmount) : undefined,
      note: body.note,
    });
    res.json({ data: serializeDeposit(deposit), replayed });
  }),
);

agentRouter.post(
  '/deposits/:code/reject',
  asyncHandler(async (req, res) => {
    const params = parse(CodeParams, req.params);
    const body = parse(RejectSchema, req.body);
    const deposit = await rejectDeposit(req.auth!.userId, params.code, body.note);
    res.json({ data: serializeDeposit(deposit) });
  }),
);

agentRouter.get(
  '/withdrawals',
  asyncHandler(async (req, res) => {
    const query = parse(WithdrawalQueueQuery, req.query);
    const withdrawals = await listAgentWithdrawals(req.agent!.id, query.status);
    res.json({ data: withdrawals.map(serializeWithdrawal) });
  }),
);

agentRouter.post(
  '/withdrawals/redeem',
  asyncHandler(async (req, res) => {
    const body = parse(RedeemSchema, req.body);
    const { withdrawal, replayed } = await redeemWithdrawal({
      agentUserId: req.auth!.userId,
      payoutCode: body.payoutCode,
      note: body.note,
    });
    res.json({ data: serializeWithdrawal(withdrawal), replayed });
  }),
);

agentRouter.get(
  '/commissions',
  asyncHandler(async (req, res) => {
    const { limit } = parse(ListQuery, req.query);
    const commissions = await prisma.agentCommission.findMany({
      where: { agentProfileId: req.agent!.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json({ data: commissions.map(serializeCommission) });
  }),
);

agentRouter.get(
  '/float-requests',
  asyncHandler(async (req, res) => {
    const { limit } = parse(ListQuery, req.query);
    const requests = await prisma.agentFloatRequest.findMany({
      where: { agentProfileId: req.agent!.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json({
      data: requests.map((request) => ({
        id: request.id,
        direction: request.direction,
        amount: request.amount,
        method: request.method,
        externalRef: request.externalRef,
        status: request.status,
        createdAt: request.createdAt,
        reviewedAt: request.reviewedAt,
      })),
    });
  }),
);
