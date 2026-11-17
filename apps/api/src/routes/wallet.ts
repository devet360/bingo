import { Router } from 'express';
import { DepositStatus, PaymentMethod, WithdrawalStatus } from '@prisma/client';
import { z } from 'zod';
import { parse } from '../lib/validate';
import { asyncHandler } from '../lib/async';
import { Errors } from '../lib/errors';
import { prisma } from '../lib/prisma';
import {
  serializeDeposit,
  serializePayoutAccount,
  serializeProof,
  serializeWallet,
} from '../lib/serializers';
import { authenticate, requireVerifiedPhone } from '../middleware/auth';
import { moneyLimiter, receiptLimiter } from '../middleware/rateLimit';
import { findAgentByCode } from '../services/agents';
import {
  createDeposit,
  listPlayerDeposits,
} from '../services/deposits';
import {
  queueDepositVerification,
  serializePlayerDeposit,
  verifyDepositReceipt,
} from '../services/receipts/deposits';
import { listEnabledProviders, serializeProvider } from '../services/providers';
import {
  cancelWithdrawal,
  createWithdrawal,
  listPlayerWithdrawals,
  playerWithdrawalInclude,
  serializePlayerWithdrawal,
} from '../services/withdrawals';
import {
  confirmCashReceived,
  listWithdrawalProofs,
} from '../services/withdrawalProofs';
import {
  createPayoutAccount,
  deactivatePayoutAccount,
  listPayoutAccounts,
  updatePayoutAccount,
} from '../services/payoutAccounts';
import { getPlayerWallet, scopedIdempotencyKey } from '../services/wallet';
import { getDepositLimits } from '../services/config';

const minorAmount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const CreateDepositSchema = z
  .object({
    amount: minorAmount,
    method: z.nativeEnum(PaymentMethod),
    agentProfileId: z.string().uuid().optional(),
    agentCode: z.string().max(16).optional(),
    paymentAccountId: z.string().uuid().optional(),
    providerCode: z.string().trim().min(1).max(32).optional(),
    receiptReference: z.string().trim().max(512).optional(),
    receiptAccount: z.string().trim().max(64).optional(),
    receiptPhone: z.string().trim().max(32).optional(),
    externalRef: z.string().max(128).optional(),
    receiptUrl: z.string().url().max(2048).optional(),
    playerNote: z.string().max(500).optional(),
  })
  .refine((value) => !(value.agentProfileId && value.agentCode), {
    message: 'Provide agentProfileId or agentCode, not both',
    path: ['agentCode'],
  });

/**
 * "I have paid": the reference typed from the receipt, an optional proof
 * screenshot, and — for client-side rails — the bank's own response captured
 * by the player's device.
 */
const VerifyReceiptSchema = z
  .object({
    contentType: z.string().max(128).optional(),
    bodyBase64: z.string().min(1).max(7_200_000).optional(),
    receiptReference: z.string().trim().max(512).optional(),
    receiptAccount: z.string().trim().max(64).optional(),
    receiptPhone: z.string().trim().max(32).optional(),
    proofBase64: z.string().min(1).max(6_000_000).optional(),
    proofContentType: z.enum(['image/png', 'image/jpeg', 'image/webp']).optional(),
  })
  .refine(
    (value) => Boolean(value.bodyBase64 || value.receiptReference || value.proofBase64),
    { message: 'Provide a receipt reference, a proof image or the bank response' },
  )
  .refine((value) => !value.proofBase64 || Boolean(value.proofContentType), {
    message: 'proofContentType is required with proofBase64',
    path: ['proofContentType'],
  });

const DepositCodeParams = z.object({ code: z.string().regex(/^\d{6}$/, 'Expected a 6-digit code') });

const ProviderQuery = z.object({ method: z.nativeEnum(PaymentMethod).optional() });

const CreateWithdrawalSchema = z.object({
  amount: minorAmount,
  method: z.nativeEnum(PaymentMethod),
  providerCode: z.string().trim().min(1).max(32).optional(),
  agentProfileId: z.string().uuid().optional(),
  paymentAccountId: z.string().uuid().optional(),
  payoutAccountId: z.string().uuid().optional(),
  payoutAccount: z
    .object({
      accountName: z.string().trim().min(1).max(128),
      accountNumber: z.string().trim().min(1).max(64),
      provider: z.string().trim().max(64).nullable().optional(),
    })
    .optional(),
  playerNote: z.string().max(500).optional(),
});

const PayoutAccountSchema = z.object({
  method: z.nativeEnum(PaymentMethod),
  provider: z.string().trim().max(64).nullable().optional(),
  accountName: z.string().trim().min(1).max(128),
  accountNumber: z.string().trim().min(1).max(64),
  isDefault: z.boolean().optional(),
});

const PayoutAccountPatchSchema = PayoutAccountSchema.partial().extend({
  isDefault: z.boolean().optional(),
});

const PayoutAccountParams = z.object({ id: z.string().uuid() });
const WithdrawalParams = z.object({ id: z.string().uuid() });

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

walletRouter.get(
  '/deposit-providers',
  asyncHandler(async (req, res) => {
    const query = parse(ProviderQuery, req.query);
    const providers = await listEnabledProviders(query.method);
    res.json({ data: providers.map(serializeProvider) });
  }),
);

walletRouter.get(
  '/deposit-config',
  asyncHandler(async (_req, res) => {
    const limits = await getDepositLimits();
    res.json({
      data: {
        minAmount: limits.minAmount.toString(),
        maxAmount: limits.maxAmount === null ? null : limits.maxAmount.toString(),
      },
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

    const { deposit, replayed, provider } = await createDeposit({
      playerId: req.auth!.userId,
      agentProfileId,
      paymentAccountId: body.paymentAccountId,
      method: body.method,
      amount: BigInt(body.amount),
      providerCode: body.providerCode,
      receiptReference: body.receiptReference,
      receiptAccount: body.receiptAccount,
      receiptPhone: body.receiptPhone,
      externalRef: body.externalRef,
      receiptUrl: body.receiptUrl,
      playerNote: body.playerNote,
      idempotencyKey,
    });

    // Only a legacy caller that already supplied the reference can be checked
    // now. Normally the receipt arrives later with "I have paid".
    if (!replayed && provider?.supported && !provider.clientSide && deposit.receiptReference) {
      queueDepositVerification(deposit.id);
    }

    res
      .status(replayed ? 200 : 201)
      .json({ data: await serializePlayerDeposit({ ...deposit, provider }), replayed });
  }),
);

walletRouter.post(
  '/deposits/:code/verify-receipt',
  receiptLimiter,
  asyncHandler(async (req, res) => {
    const params = parse(DepositCodeParams, req.params);
    const payload = parse(VerifyReceiptSchema, req.body ?? {});

    const deposit = await prisma.depositRequest.findFirst({
      where: { code: params.code, playerId: req.auth!.userId },
      select: { id: true },
    });
    if (!deposit) throw Errors.notFound('Deposit request');

    const result = await verifyDepositReceipt({
      depositId: deposit.id,
      payload: payload.bodyBase64
        ? { contentType: payload.contentType, bodyBase64: payload.bodyBase64 }
        : undefined,
      receipt: {
        reference: payload.receiptReference,
        accountNumber: payload.receiptAccount,
        phoneNumber: payload.receiptPhone,
      },
      proof: payload.proofBase64
        ? { contentType: payload.proofContentType!, base64: payload.proofBase64 }
        : undefined,
    });
    const full = await prisma.depositRequest.findUnique({
      where: { id: deposit.id },
      include: { provider: true },
    });
    res.json({
      data: await serializePlayerDeposit(full!),
      verification: {
        status: result.outcome.status,
        message: result.outcome.message,
      },
      autoCredited: result.autoCredited,
    });
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
      include: { provider: true },
    });
    if (!deposit) throw Errors.notFound('Deposit');
    res.json({ data: await serializePlayerDeposit(deposit) });
  }),
);

walletRouter.get(
  '/payout-accounts',
  asyncHandler(async (req, res) => {
    const accounts = await listPayoutAccounts(req.auth!.userId);
    res.json({ data: accounts.map(serializePayoutAccount) });
  }),
);

walletRouter.post(
  '/payout-accounts',
  asyncHandler(async (req, res) => {
    const body = parse(PayoutAccountSchema, req.body);
    const account = await createPayoutAccount(req.auth!.userId, body);
    res.status(201).json({ data: serializePayoutAccount(account) });
  }),
);

walletRouter.patch(
  '/payout-accounts/:id',
  asyncHandler(async (req, res) => {
    const params = parse(PayoutAccountParams, req.params);
    const body = parse(PayoutAccountPatchSchema, req.body);
    const account = await updatePayoutAccount(req.auth!.userId, params.id, body);
    res.json({ data: serializePayoutAccount(account) });
  }),
);

walletRouter.delete(
  '/payout-accounts/:id',
  asyncHandler(async (req, res) => {
    const params = parse(PayoutAccountParams, req.params);
    const account = await deactivatePayoutAccount(req.auth!.userId, params.id);
    res.json({ data: serializePayoutAccount(account) });
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
      payoutAccountId: body.payoutAccountId,
      payoutAccount: body.payoutAccount,
      providerCode: body.providerCode,
      method: body.method,
      amount: BigInt(body.amount),
      playerNote: body.playerNote,
      idempotencyKey: scopedIdempotencyKey(req),
    });
    res
      .status(replayed ? 200 : 201)
      .json({ data: serializePlayerWithdrawal(withdrawal), replayed });
  }),
);

walletRouter.get(
  '/withdrawals',
  asyncHandler(async (req, res) => {
    const query = parse(WithdrawalStatusQuery, req.query);
    const withdrawals = await listPlayerWithdrawals(req.auth!.userId, query.status);
    res.json({ data: withdrawals.map(serializePlayerWithdrawal) });
  }),
);

walletRouter.post(
  '/withdrawals/:id/cancel',
  asyncHandler(async (req, res) => {
    const withdrawal = await cancelWithdrawal(req.auth!.userId, req.params.id);
    res.json({ data: serializePlayerWithdrawal(withdrawal) });
  }),
);

walletRouter.get(
  '/withdrawals/:id/proofs',
  asyncHandler(async (req, res) => {
    const params = parse(WithdrawalParams, req.params);
    const proofs = await listWithdrawalProofs(req.auth!.userId, params.id);
    res.json({ data: proofs.map(serializeProof) });
  }),
);

walletRouter.post(
  '/withdrawals/:id/confirm-received',
  asyncHandler(async (req, res) => {
    const params = parse(WithdrawalParams, req.params);
    const proof = await confirmCashReceived(req.auth!.userId, params.id);
    const withdrawal = await prisma.withdrawalRequest.findUnique({
      where: { id: params.id },
      include: playerWithdrawalInclude,
    });
    res.json({
      data: {
        withdrawal: serializePlayerWithdrawal(withdrawal!),
        proof: serializeProof(proof),
      },
    });
  }),
);
