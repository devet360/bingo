/**
 * Receipt verification tied to a deposit request.
 *
 * Flow:
 *   1. The player creates a deposit with a provider and pays.
 *   2. "I have paid" submits the receipt reference, a screenshot, or both.
 *   3. A reference is checked against the issuer (server-side, or over bytes
 *      the payer's device captured). The outcome is stored in
 *      ReceiptVerification, one reference per provider, so the same receipt
 *      can never fund two deposits.
 *   4. When the assigned agent has auto-verification on and the deposit is at
 *      or below the agent's threshold, a verified receipt credits the deposit
 *      immediately. The ledger still runs in a transaction with row locks and
 *      the `deposit:<id>` idempotency key.
 *   5. A screenshot without a reference, a rail the bank refuses to answer, or
 *      a reference the bank cannot confirm alongside a screenshot, goes to the
 *      assigned agent as MANUAL.
 */
import {
  DepositStatus,
  VerificationStatus,
  VerificationSource,
  type DepositProvider,
  type DepositRequest,
  type Prisma,
} from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { Errors } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { serializeDeposit, serializePaymentAccount } from '../../lib/serializers';
import { isUniqueViolation } from '../../lib/tx';
import { creditDeposit } from '../deposits';
import { verifyClientPayload, verifyReceipt } from './verify';
import { deriveReceiptAccount, mergeReceiptSubmission } from './reference';
import { ReferenceError, type ReceiptProvider, type VerifyOutcome } from './types';

type DepositWithProvider = DepositRequest & { provider: DepositProvider | null };

/**
 * Wire shape for the player: the assigned agent and the exact account to pay.
 */
export async function serializePlayerDeposit(deposit: DepositWithProvider) {
  const [agent, account] = await Promise.all([
    deposit.agentProfileId
      ? prisma.agentProfile.findUnique({
          where: { id: deposit.agentProfileId },
          include: {
            user: {
              select: { displayName: true, avatarUrl: true, phone: true, telegramUsername: true },
            },
          },
        })
      : null,
    deposit.paymentAccountId
      ? prisma.agentPaymentAccount.findUnique({ where: { id: deposit.paymentAccountId } })
      : null,
  ]);

  return {
    ...serializeDeposit(deposit),
    agent: agent
      ? {
          id: agent.id,
          agentCode: agent.agentCode,
          displayName: agent.user.displayName,
          avatarUrl: agent.user.avatarUrl,
          phone: agent.user.phone,
          telegramUsername: agent.user.telegramUsername,
          isOnline: agent.isOnline,
          autoDepositEnabled: agent.autoDepositEnabled,
          autoDepositThreshold:
            agent.autoDepositThreshold === null ? null : agent.autoDepositThreshold.toString(),
        }
      : null,
    paymentAccount: account ? serializePaymentAccount(account) : null,
  };
}

function toReceiptProvider(provider: DepositProvider): ReceiptProvider {
  return {
    code: provider.code,
    name: provider.name,
    method: provider.method,
    parser: provider.parser,
    endpoint: provider.endpoint,
    refPattern: provider.refPattern,
    refHint: provider.refHint,
    accountDigits: provider.accountDigits,
    requiresPhone: provider.requiresPhone,
    opaqueReference: provider.opaqueReference,
    clientSide: provider.clientSide,
    supported: provider.supported,
    enabled: provider.enabled,
  };
}

function minorFromEtb(amount: number | undefined): bigint | null {
  if (amount === undefined || !Number.isFinite(amount) || amount <= 0) return null;
  return BigInt(Math.round(amount * 100));
}

/**
 * True when the receipt's receiver account matches the agent's payment
 * account. undefined means "cannot tell" (one side missing or masked too
 * heavily), which the caller treats as a soft pass.
 */
export function receiverAccountMatches(
  receiptAccount: string | undefined,
  agentAccount: string | undefined,
): boolean | undefined {
  if (!receiptAccount || !agentAccount) return undefined;
  const receipt = receiptAccount.replace(/[^0-9*]/g, '');
  const agent = agentAccount.replace(/\D/g, '');
  if (!receipt || !agent) return undefined;
  // A masked number keeps its first and last digits; the suffix is stable.
  const visible = receipt.replace(/\*/g, '');
  const len = Math.min(6, visible.length, agent.length);
  if (len < 4) return undefined;
  return agent.endsWith(visible.slice(-len));
}

/** The receiving-account suffix for a deposit: what was stored with it, or the
 * tail of the account the server assigned. The player never types the agent's
 * number.
 */
async function resolveReceiptAccount(deposit: DepositWithProvider): Promise<string | undefined> {
  const digits = deposit.provider?.accountDigits;
  if (deposit.receiptAccount || !digits || !deposit.paymentAccountId) {
    return deposit.receiptAccount ?? undefined;
  }
  const account = await prisma.agentPaymentAccount.findUnique({
    where: { id: deposit.paymentAccountId },
    select: { accountNumber: true },
  });
  return deriveReceiptAccount(undefined, account?.accountNumber, digits);
}

export interface ReceiptSubmission {
  reference?: string;
  accountNumber?: string;
  phoneNumber?: string;
}

/**
 * Submit payment evidence for a deposit: the receipt reference typed after
 * paying, an optional screenshot, and (for server-reachable rails) the bank's
 * own response captured by the payer's device.
 *
 * Manual rails and screenshots without a fetchable receipt park the deposit in
 * MANUAL so the assigned agent can confirm it by hand.
 */
export async function verifyDepositReceipt(params: {
  depositId: string;
  source?: VerificationSource;
  payload?: { contentType?: string; bodyBase64: string };
  receipt?: ReceiptSubmission;
  proof?: { contentType?: string; base64: string };
}): Promise<{
  outcome: VerifyOutcome;
  deposit: DepositRequest;
  autoCredited: boolean;
}> {
  const deposit = await prisma.depositRequest.findUnique({
    where: { id: params.depositId },
    include: { provider: true },
  });
  if (!deposit) throw Errors.notFound('Deposit request');
  if (!deposit.provider) {
    throw Errors.conflict('This deposit has no receipt provider attached', 'PROVIDER_REQUIRED');
  }
  if (deposit.status !== 'PENDING' && deposit.status !== 'PROCESSING') {
    throw Errors.conflict(`Deposit is ${deposit.status.toLowerCase()}`, 'DEPOSIT_NOT_OPEN');
  }

  const provider = toReceiptProvider(deposit.provider);
  const source = params.source ?? (params.payload ? VerificationSource.CLIENT : VerificationSource.SERVER);

  let receiptReference = deposit.receiptReference;
  let receiptAccount = deposit.receiptAccount ?? (await resolveReceiptAccount(deposit)) ?? null;
  let receiptPhone = deposit.receiptPhone;

  if (params.receipt) {
    try {
      const merged = mergeReceiptSubmission(
        provider,
        {
          reference: deposit.receiptReference,
          accountNumber: receiptAccount,
          phoneNumber: deposit.receiptPhone,
        },
        params.receipt,
      );
      receiptReference = merged.reference;
      receiptAccount = merged.accountNumber;
      receiptPhone = merged.phoneNumber;
    } catch (error) {
      if (error instanceof ReferenceError) {
        throw Errors.badRequest(error.message, 'INVALID_RECEIPT_REFERENCE');
      }
      throw error;
    }
  }

  const submitted: Prisma.DepositRequestUpdateInput = {};
  if (receiptReference !== deposit.receiptReference) submitted.receiptReference = receiptReference;
  if (receiptAccount !== deposit.receiptAccount) submitted.receiptAccount = receiptAccount;
  if (receiptPhone !== deposit.receiptPhone) submitted.receiptPhone = receiptPhone;
  if (params.proof) {
    submitted.receiptUrl = `data:${params.proof.contentType};base64,${params.proof.base64}`;
  }

  let current: DepositWithProvider = deposit;
  if (Object.keys(submitted).length > 0) {
    const updated = await prisma.depositRequest.update({ where: { id: deposit.id }, data: submitted });
    current = { ...updated, provider: deposit.provider };
  }

  const markManual = async (message: string) => {
    const manual = await prisma.depositRequest.update({
      where: { id: current.id },
      data: {
        verificationStatus: VerificationStatus.MANUAL,
        verificationMessage: message,
        verificationSource: source,
      },
    });
    return {
      outcome: { status: 'NOT_VERIFIED' as const, message, source },
      deposit: manual,
      autoCredited: false,
    };
  };

  // Manual rails: the agent confirms the money arrived.
  if (!provider.supported) {
    return markManual('Payment submitted. The assigned agent will confirm it.');
  }

  if (!receiptReference) {
    // A screenshot has no reference to look up at the issuer, so the agent
    // confirms it by hand. One of the two is enough.
    if (params.proof) {
      return markManual('Payment submitted. The assigned agent will confirm it.');
    }
    throw Errors.badRequest(
      'Enter the receipt reference from your payment, or attach the receipt.',
      'RECEIPT_REFERENCE_REQUIRED',
    );
  }

  const input = {
    reference: receiptReference,
    accountNumber: receiptAccount ?? undefined,
    phoneNumber: receiptPhone ?? undefined,
  };

  // Telebirr and M-Pesa only answer Ethiopian IPs. The API tries anyway (the
  // deployment is in Ethiopia); a refusal is not a failed payment.
  const outcome = params.payload
    ? await verifyClientPayload(provider, input, params.payload, source)
    : await verifyReceipt(provider, input, source);

  if (outcome.status === 'UNREACHABLE') {
    return markManual('The bank did not answer, so your assigned agent will confirm this payment.');
  }

  await storeOutcome(current, outcome, source);
  const verified = outcome.status === 'VERIFIED';
  // A reference the bank cannot confirm still leaves a screenshot as evidence,
  // so the agent decides instead of failing the submission outright.
  const skipped = !verified && !!params.proof;
  const updated = await prisma.depositRequest.update({
    where: { id: current.id },
    data: {
      verificationStatus: verified
        ? VerificationStatus.VERIFIED
        : skipped
          ? VerificationStatus.MANUAL
          : VerificationStatus.FAILED,
      verificationMessage: skipped
        ? `${outcome.message} The assigned agent will confirm your receipt.`
        : outcome.message,
      verificationSource: source,
      verifiedAt: verified ? new Date() : null,
    },
  });

  let autoCredited = false;
  if (verified) {
    autoCredited = await tryAutoCredit(current, outcome);
  }

  const final = autoCredited
    ? (await prisma.depositRequest.findUnique({ where: { id: current.id } })) ?? updated
    : updated;
  return { outcome, deposit: final, autoCredited };
}

async function storeOutcome(
  deposit: DepositWithProvider,
  outcome: VerifyOutcome,
  source: VerificationSource,
): Promise<void> {
  const providerCode = deposit.providerCode!;
  const reference = outcome.reference ?? deposit.receiptReference!;
  const parsed = outcome.parsed;
  const amount = minorFromEtb(parsed?.amount);

  const conflict = await prisma.receiptVerification.findUnique({
    where: { providerCode_reference: { providerCode, reference } },
  });
  if (conflict && conflict.depositId && conflict.depositId !== deposit.id) {
    throw Errors.conflict('This receipt has already been used for another deposit', 'RECEIPT_ALREADY_USED');
  }

  // One verification row per deposit: a corrected reference updates it.
  const byDeposit = await prisma.receiptVerification.findUnique({ where: { depositId: deposit.id } });
  const base = {
    providerCode,
    reference,
    depositId: deposit.id,
    status: outcome.status === 'VERIFIED' ? VerificationStatus.VERIFIED : VerificationStatus.FAILED,
    source,
    amount,
    currency: parsed?.currency ?? 'ETB',
    senderName: parsed?.senderName ?? null,
    senderAccount: parsed?.senderAccount ?? null,
    receiverName: parsed?.receiverName ?? null,
    receiverAccount: parsed?.receiverAccount ?? null,
    transactionDate: parsed?.date ?? null,
    transactionStatus: parsed?.transactionStatus ?? null,
    message: outcome.message,
    detail: parsed ? (JSON.parse(JSON.stringify(parsed)) as object) : undefined,
    verifiedAt: outcome.status === 'VERIFIED' ? new Date() : null,
  };

  try {
    if (byDeposit) {
      await prisma.receiptVerification.update({
        where: { id: byDeposit.id },
        data: { ...base, attempts: { increment: 1 } },
      });
    } else {
      await prisma.receiptVerification.create({ data: { ...base, attempts: 1 } });
    }
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // A concurrent attempt (background server check + client submission) won
    // the insert, or the reference already funds another deposit.
    const row = await prisma.receiptVerification.findUnique({
      where: { providerCode_reference: { providerCode, reference } },
    });
    if (row && row.depositId && row.depositId !== deposit.id) {
      throw Errors.conflict('This receipt has already been used for another deposit', 'RECEIPT_ALREADY_USED');
    }
    if (!row) throw e;
    await prisma.receiptVerification.update({
      where: { id: row.id },
      data: { ...base, attempts: { increment: 1 } },
    });
  }
}

/**
 * Verify in the background so the create-deposit response is not held up by a
 * slow bank. Only for rails the API can reach; client-side rails submit the
 * bank's own response instead.
 */
export function queueDepositVerification(depositId: string): void {
  void verifyDepositReceipt({ depositId }).catch((error) => {
    logger.warn({ err: error, depositId }, 'background receipt verification failed');
  });
}

/**
 * Credit the deposit when the agent allows it: auto-verification on, a
 * threshold at or above this deposit, a verified receipt for the exact
 * requested amount, and a receiver that matches the agent's account when both
 * numbers are visible.
 */
async function tryAutoCredit(deposit: DepositWithProvider, outcome: VerifyOutcome): Promise<boolean> {
  if (!deposit.agentProfileId) return false;

  const agent = await prisma.agentProfile.findUnique({
    where: { id: deposit.agentProfileId },
    select: {
      id: true,
      autoDepositEnabled: true,
      autoDepositThreshold: true,
      userId: true,
      status: true,
    },
  });
  if (!agent || agent.status !== 'ACTIVE' || !agent.autoDepositEnabled) return false;
  if (agent.autoDepositThreshold === null || deposit.amount > agent.autoDepositThreshold) return false;

  const parsedAmount = minorFromEtb(outcome.parsed?.amount);
  if (parsedAmount === null || parsedAmount !== deposit.amount) return false;

  if (deposit.paymentAccountId) {
    const account = await prisma.agentPaymentAccount.findUnique({
      where: { id: deposit.paymentAccountId },
      select: { accountNumber: true, agentProfileId: true, isActive: true },
    });
    if (!account?.isActive || account.agentProfileId !== agent.id) return false;
    const matches = receiverAccountMatches(outcome.parsed?.receiverAccount, account.accountNumber);
    if (matches === false) return false;
  }

  // Atomic claim: only one worker may move this deposit out of PENDING.
  const claimed = await prisma.depositRequest.updateMany({
    where: {
      id: deposit.id,
      status: { in: [DepositStatus.PENDING, DepositStatus.PROCESSING] },
      expiresAt: { gt: new Date() },
    },
    data: { status: DepositStatus.PROCESSING, agentProfileId: agent.id, claimedAt: new Date() },
  });
  if (claimed.count === 0) return false;

  try {
    await creditDeposit({
      agentUserId: agent.userId,
      code: deposit.code,
      creditedAmount: deposit.amount,
      note: 'Auto-verified receipt',
    });
    await prisma.depositRequest.update({
      where: { id: deposit.id },
      data: { autoVerified: true, processedById: agent.userId },
    });
    return true;
  } catch (e) {
    // The receipt's own unique index or a race with the agent leaves the
    // deposit PROCESSING; the agent can still see and settle it by hand.
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}
