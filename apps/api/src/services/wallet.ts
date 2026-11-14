import type { Request } from 'express';
import { prisma } from '../lib/prisma';
import { provisionUserAccounts } from './accounts';
import { runTransaction } from '../lib/tx';
import { Errors } from '../lib/errors';

export async function getPlayerWallet(userId: string) {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (wallet) return wallet;
  await prisma.$transaction(async (tx) => provisionUserAccounts(tx, userId));
  const provisioned = await prisma.wallet.findUnique({ where: { userId } });
  if (!provisioned) throw Errors.internal('Wallet provisioning failed');
  return provisioned;
}

/**
 * Idempotency keys are scoped per caller: one player must not be able to replay
 * another player's key and receive their request back.
 */
export function scopedIdempotencyKey(req: Request): string {
  const raw = req.header('idempotency-key');
  if (!raw || !/^[A-Za-z0-9._:-]{8,128}$/.test(raw)) {
    throw Errors.badRequest(
      'Provide an Idempotency-Key header (8-128 chars: A-Z a-z 0-9 . _ : -)',
      'IDEMPOTENCY_KEY_REQUIRED',
    );
  }
  return `${req.auth!.userId}:${raw}`;
}
