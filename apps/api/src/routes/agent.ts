import { Router } from 'express';
import { DepositStatus, PaymentMethod, WithdrawalStatus } from '@prisma/client';
import { z } from 'zod';
import { parse } from '../lib/validate';
import { asyncHandler } from '../lib/async';
import { prisma } from '../lib/prisma';
import {
  serializeAgent,
  serializeAgentTask,
  serializeCommission,
  serializeDeposit,
  serializePaymentAccount,
  serializeProof,
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
  createPaymentAccount,
  setAgentAvailability,
  setAgentPresence,
  updateAutoDepositSettings,
  updatePaymentAccount,
} from '../services/agents';
import {
  listAgentWithdrawals,
  redeemWithdrawal,
} from '../services/withdrawals';
import { releaseAgentTask } from '../services/agentTasks';
import { listAgentProofs, submitWithdrawalProof } from '../services/withdrawalProofs';
import { getPlayerWallet } from '../services/wallet';

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

const ProofSchema = z.object({
  reference: z.string().trim().max(128).optional(),
  paidAmount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  currency: z.string().trim().length(3).optional(),
  senderAccount: z.string().trim().max(64).optional(),
  receiverAccount: z.string().trim().max(64).optional(),
  paidAt: z.coerce.date().optional(),
  notes: z.string().trim().max(500).optional(),
  mediaAssetId: z.string().uuid().optional(),
  screenshotBase64: z.string().min(1).max(7_500_000).optional(),
});

const IdParams = z.object({ id: z.string().uuid() });

const PresenceSchema = z.object({ isOnline: z.boolean() });
const AvailabilitySchema = z.object({ acceptingTasks: z.boolean() });

const AutoDepositSchema = z
  .object({
    autoDepositEnabled: z.boolean().optional(),
    autoDepositThreshold: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable()
      .optional(),
  })
  .refine((value) => value.autoDepositEnabled !== undefined || value.autoDepositThreshold !== undefined, {
    message: 'Nothing to update',
  });

const PaymentAccountSchema = z.object({
  method: z.nativeEnum(PaymentMethod),
  provider: z.string().trim().max(64).nullable().optional(),
  accountName: z.string().trim().min(1).max(128),
  accountNumber: z.string().trim().min(1).max(64),
  instructions: z.string().trim().max(500).nullable().optional(),
  minAmount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  maxAmount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
});

const PaymentAccountPatchSchema = PaymentAccountSchema.partial().extend({
  isActive: z.boolean().optional(),
});

const AccountParams = z.object({ id: z.string().uuid() });

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

agentRouter.patch(
  '/me',
  asyncHandler(async (req, res) => {
    const body = parse(AutoDepositSchema, req.body);
    const agent = await updateAutoDepositSettings(req.agent!.id, {
      autoDepositEnabled: body.autoDepositEnabled,
      autoDepositThreshold:
        body.autoDepositThreshold === undefined
          ? undefined
          : body.autoDepositThreshold === null
            ? null
            : BigInt(body.autoDepositThreshold),
    });
    res.json({ data: serializeAgent(agent, { includeBalances: true }) });
  }),
);

agentRouter.get(
  '/payment-accounts',
  asyncHandler(async (req, res) => {
    const accounts = await prisma.agentPaymentAccount.findMany({
      where: { agentProfileId: req.agent!.id },
      orderBy: { createdAt: 'asc' },
    });
    res.json({
      data: accounts.map((account) => ({ ...serializePaymentAccount(account), isActive: account.isActive })),
    });
  }),
);

agentRouter.post(
  '/payment-accounts',
  asyncHandler(async (req, res) => {
    const body = parse(PaymentAccountSchema, req.body);
    const account = await createPaymentAccount(req.agent!.id, {
      method: body.method,
      provider: body.provider,
      accountName: body.accountName,
      accountNumber: body.accountNumber,
      instructions: body.instructions,
      minAmount: body.minAmount === undefined || body.minAmount === null ? body.minAmount : BigInt(body.minAmount),
      maxAmount: body.maxAmount === undefined || body.maxAmount === null ? body.maxAmount : BigInt(body.maxAmount),
    });
    res.status(201).json({ data: { ...serializePaymentAccount(account), isActive: account.isActive } });
  }),
);

agentRouter.patch(
  '/payment-accounts/:id',
  asyncHandler(async (req, res) => {
    const params = parse(AccountParams, req.params);
    const body = parse(PaymentAccountPatchSchema, req.body);
    const account = await updatePaymentAccount(req.agent!.id, params.id, {
      method: body.method,
      provider: body.provider,
      accountName: body.accountName,
      accountNumber: body.accountNumber,
      instructions: body.instructions,
      isActive: body.isActive,
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
    res.json({ data: { ...serializePaymentAccount(account), isActive: account.isActive } });
  }),
);

agentRouter.delete(
  '/payment-accounts/:id',
  asyncHandler(async (req, res) => {
    const params = parse(AccountParams, req.params);
    const account = await updatePaymentAccount(req.agent!.id, params.id, { isActive: false });
    res.json({ data: { ...serializePaymentAccount(account), isActive: account.isActive } });
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

agentRouter.post(
  '/availability',
  asyncHandler(async (req, res) => {
    const body = parse(AvailabilitySchema, req.body);
    const agent = await setAgentAvailability(req.auth!.userId, body.acceptingTasks);
    res.json({ data: serializeAgent(agent, { includeBalances: true }) });
  }),
);

agentRouter.get(
  '/tasks',
  asyncHandler(async (req, res) => {
    const tasks = await prisma.agentTask.findMany({
      where: { agentProfileId: req.agent!.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ data: tasks.map((task) => serializeAgentTask(task)) });
  }),
);

agentRouter.post(
  '/tasks/:id/release',
  asyncHandler(async (req, res) => {
    const params = parse(AccountParams, req.params);
    const task = await releaseAgentTask(req.auth!.userId, params.id);
    res.json({ data: serializeAgentTask(task) });
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
  '/withdrawals/:id/proofs',
  asyncHandler(async (req, res) => {
    const params = parse(IdParams, req.params);
    const proofs = await listAgentProofs(req.agent!.id, params.id);
    res.json({ data: proofs.map(serializeProof) });
  }),
);

agentRouter.post(
  '/withdrawals/:id/proof',
  asyncHandler(async (req, res) => {
    const params = parse(IdParams, req.params);
    const body = parse(ProofSchema, req.body);
    const proof = await submitWithdrawalProof({
      agentUserId: req.auth!.userId,
      withdrawalId: params.id,
      input: {
        reference: body.reference,
        paidAmount: body.paidAmount === undefined ? undefined : BigInt(body.paidAmount),
        currency: body.currency,
        senderAccount: body.senderAccount,
        receiverAccount: body.receiverAccount,
        paidAt: body.paidAt,
        notes: body.notes,
        mediaAssetId: body.mediaAssetId,
        screenshotBase64: body.screenshotBase64,
      },
    });
    res.status(201).json({ data: serializeProof(proof) });
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
