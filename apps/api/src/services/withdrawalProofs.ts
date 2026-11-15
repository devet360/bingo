import { VerificationStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { Errors } from '../lib/errors';
import { accountSuffixMatches } from '../lib/accountMatch';
import { isUniqueViolation, runTransaction, withTxRetry } from '../lib/tx';
import { getActiveAgentByUserId } from './agents';
import { releaseWithdrawalHold } from './withdrawals';
import { storeMedia, type StoreMediaInput } from './media';

function normaliseReference(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed ? trimmed.slice(0, 128) : null;
}

function referenceConflict(error: unknown): boolean {
  if (!isUniqueViolation(error)) return false;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  const text = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return text.includes('reference') || text.includes('WithdrawalProof_reference');
}

export interface SubmitProofInput {
  reference?: string;
  paidAmount?: bigint;
  currency?: string;
  senderAccount?: string;
  receiverAccount?: string;
  paidAt?: Date;
  notes?: string;
  mediaAssetId?: string;
  /** Inline screenshot (data URL or raw base64); stored before the proof. */
  screenshotBase64?: string;
}

/**
 * Records the agent's payment evidence. Structural cross-checks run against
 * the request itself: exact amount, the player's payout account digits, the
 * agent's own paying account, and a timestamp after the claim. Cash and
 * screenshot-only proofs always wait for a human.
 */
export async function submitWithdrawalProof(params: {
  agentUserId: string;
  withdrawalId: string;
  input: SubmitProofInput;
}) {
  const agent = await getActiveAgentByUserId(params.agentUserId);
  const withdrawal = await prisma.withdrawalRequest.findUnique({
    where: { id: params.withdrawalId },
    include: { payoutAccount: true, paymentAccount: true },
  });
  if (!withdrawal) throw Errors.notFound('Withdrawal');
  if (withdrawal.agentProfileId !== agent.id) {
    throw Errors.forbidden('This payout belongs to another agent', 'WITHDRAWAL_ASSIGNED');
  }
  if (withdrawal.status !== 'PROCESSING') {
    throw Errors.conflict('Claim the payout code before submitting proof', 'WITHDRAWAL_NOT_PROCESSING');
  }

  const reference = normaliseReference(params.input.reference);
  let mediaAssetId = params.input.mediaAssetId;
  if (params.input.screenshotBase64) {
    const upload: StoreMediaInput = {
      base64: params.input.screenshotBase64,
      uploadedById: agent.userId,
      purpose: 'withdrawal-proof',
    };
    const asset = await storeMedia(upload);
    mediaAssetId = asset.id;
  }
  if (!reference && !mediaAssetId) {
    throw Errors.badRequest(
      'Attach the payment reference or a screenshot of the transfer',
      'PROOF_REQUIRED',
    );
  }
  if (mediaAssetId) {
    const asset = await prisma.mediaAsset.findUnique({ where: { id: mediaAssetId } });
    if (!asset) throw Errors.notFound('Screenshot');
    if (asset.uploadedById && asset.uploadedById !== agent.userId) {
      throw Errors.forbidden('That screenshot belongs to another upload', 'MEDIA_FORBIDDEN');
    }
  }

  const paidAmount = params.input.paidAmount ?? withdrawal.netAmount;
  const currency = (params.input.currency ?? 'ETB').toUpperCase();
  const now = new Date();
  const earliest = new Date((withdrawal.holdAt ?? withdrawal.updatedAt).getTime() - 5 * 60_000);
  const latest = new Date(now.getTime() + 5 * 60_000);

  const failures: string[] = [];
  if (paidAmount !== withdrawal.netAmount) {
    failures.push(
      `The amount paid must be exactly ${withdrawal.netAmount.toString()} minor units`,
    );
  }
  if (currency !== 'ETB') failures.push('Only ETB payouts are supported');
  if (withdrawal.payoutAccount) {
    const receiverOk = accountSuffixMatches(
      params.input.receiverAccount,
      withdrawal.payoutAccount.accountNumber,
    );
    if (receiverOk === false) failures.push("The receiver account does not match the player's account");
  }
  if (withdrawal.paymentAccount) {
    const senderOk = accountSuffixMatches(
      params.input.senderAccount,
      withdrawal.paymentAccount.accountNumber,
    );
    if (senderOk === false) failures.push('The sender account does not match your paying account');
  }
  if (params.input.paidAt) {
    if (params.input.paidAt < earliest || params.input.paidAt > latest) {
      failures.push('The payment time is outside the payout window');
    }
  }

  const autoVerify =
    failures.length === 0 && Boolean(reference) && withdrawal.method !== 'CASH';

  try {
    return await withTxRetry(() =>
      runTransaction(async (tx) => {
        const current = await tx.withdrawalRequest.findUnique({ where: { id: withdrawal.id } });
        if (!current || current.status !== 'PROCESSING') {
          throw Errors.conflict('This payout is no longer in progress', 'WITHDRAWAL_NOT_PROCESSING');
        }

        const proof = await tx.withdrawalProof.create({
          data: {
            withdrawalId: current.id,
            agentProfileId: agent.id,
            submittedById: agent.userId,
            method: current.method,
            reference,
            paidAmount,
            currency,
            senderAccount: params.input.senderAccount?.trim() || null,
            receiverAccount: params.input.receiverAccount?.trim() || null,
            paidAt: params.input.paidAt ?? null,
            mediaAssetId: mediaAssetId ?? null,
            notes: params.input.notes?.trim() || null,
            status: failures.length
              ? VerificationStatus.FAILED
              : autoVerify
                ? VerificationStatus.VERIFIED
                : VerificationStatus.MANUAL,
            message: failures.length
              ? failures.join('. ')
              : autoVerify
                ? 'Automatically matched to the withdrawal'
                : 'Waiting for a support review',
            ...(autoVerify ? { reviewedAt: now } : {}),
          },
        });

        if (autoVerify) {
          await releaseWithdrawalHold(tx, current.id, {
            processedById: agent.userId,
            note: params.input.notes,
          });
        }

        return proof;
      }),
    );
  } catch (error) {
    if (referenceConflict(error)) {
      throw Errors.conflict(
        'This payment reference was already used for another payout',
        'PROOF_REFERENCE_REUSED',
      );
    }
    throw error;
  }
}

/** Staff decision on a submitted proof; approving releases the held float. */
export async function reviewWithdrawalProof(params: {
  staffUserId: string;
  withdrawalId: string;
  proofId: string;
  decision: Extract<VerificationStatus, 'VERIFIED' | 'FAILED'>;
  note?: string;
}) {
  return runTransaction(async (tx) => {
    const proof = await tx.withdrawalProof.findFirst({
      where: { id: params.proofId, withdrawalId: params.withdrawalId },
      include: { withdrawal: true },
    });
    if (!proof) throw Errors.notFound('Payment proof');
    if (proof.status === VerificationStatus.VERIFIED) return proof;
    if (params.decision === 'FAILED') {
      return tx.withdrawalProof.update({
        where: { id: proof.id },
        data: {
          status: VerificationStatus.FAILED,
          message: params.note?.trim() || 'Rejected by support',
          reviewedById: params.staffUserId,
          reviewedAt: new Date(),
        },
      });
    }
    if (proof.withdrawal.status !== 'PROCESSING') {
      throw Errors.conflict('This withdrawal is not being paid out', 'WITHDRAWAL_NOT_PROCESSING');
    }
    await releaseWithdrawalHold(tx, proof.withdrawalId, {
      processedById: params.staffUserId,
      note: params.note,
    });
    return tx.withdrawalProof.update({
      where: { id: proof.id },
      data: {
        status: VerificationStatus.VERIFIED,
        message: params.note?.trim() || 'Approved by support',
        reviewedById: params.staffUserId,
        reviewedAt: new Date(),
      },
    });
  });
}

/** The player says the cash arrived; releases the agent's held float. */
export async function confirmCashReceived(playerId: string, withdrawalId: string) {
  return runTransaction(async (tx) => {
    const withdrawal = await tx.withdrawalRequest.findFirst({
      where: { id: withdrawalId, playerId },
    });
    if (!withdrawal) throw Errors.notFound('Withdrawal');
    if (withdrawal.method !== 'CASH') {
      throw Errors.badRequest('Only cash payouts need confirmation', 'NOT_CASH_PAYOUT');
    }
    if (withdrawal.status !== 'PROCESSING') {
      throw Errors.conflict('This payout is not waiting for confirmation', 'WITHDRAWAL_NOT_PROCESSING');
    }
    const proof = await tx.withdrawalProof.findFirst({
      where: { withdrawalId, status: { in: [VerificationStatus.PENDING, VerificationStatus.MANUAL] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!proof) {
      throw Errors.conflict('The agent has not submitted payment proof yet', 'PROOF_MISSING');
    }
    await releaseWithdrawalHold(tx, withdrawalId, { note: 'Confirmed by player' });
    return tx.withdrawalProof.update({
      where: { id: proof.id },
      data: {
        status: VerificationStatus.VERIFIED,
        message: 'Confirmed by player',
        reviewedAt: new Date(),
      },
    });
  });
}

export async function listWithdrawalProofs(playerId: string, withdrawalId: string) {
  const withdrawal = await prisma.withdrawalRequest.findFirst({
    where: { id: withdrawalId, playerId },
    select: { id: true },
  });
  if (!withdrawal) throw Errors.notFound('Withdrawal');
  return prisma.withdrawalProof.findMany({
    where: { withdrawalId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function listAgentProofs(agentProfileId: string, withdrawalId: string) {
  const withdrawal = await prisma.withdrawalRequest.findFirst({
    where: { id: withdrawalId, agentProfileId },
    select: { id: true },
  });
  if (!withdrawal) throw Errors.notFound('Withdrawal');
  return prisma.withdrawalProof.findMany({
    where: { withdrawalId },
    orderBy: { createdAt: 'desc' },
  });
}
