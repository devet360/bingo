import { createHmac, timingSafeEqual } from 'node:crypto';
import type { GameProvider, ProviderCallbackType } from '@prisma/client';
import { z } from 'zod';

const CALLBACK_AMOUNT = z
  .union([
    z.string().regex(/^\d+$/, 'amount must be a positive integer in minor units'),
    z.number().int().positive(),
  ])
  .transform(String)
  .refine((value) => BigInt(value) > 0n, {
    message: 'amount must be a positive integer in minor units',
  });

const movementFields = {
  sessionId: z.string().uuid(),
  txnId: z.string().min(1).max(128),
  amount: CALLBACK_AMOUNT,
  currency: z.string().max(16).optional(),
  roundId: z.string().max(128).optional(),
};

export const ProviderCallbackSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('balance'),
    sessionId: z.string().uuid(),
    currency: z.string().max(16).optional(),
    nonce: z.string().max(64).optional(),
  }),
  z.object({ type: z.literal('bet'), ...movementFields }),
  z.object({ type: z.literal('win'), ...movementFields }),
  z.object({ type: z.literal('rollback'), ...movementFields }),
]);

export type ProviderCallbackPayload = z.infer<typeof ProviderCallbackSchema>;

export const CALLBACK_ENUM: Record<ProviderCallbackPayload['type'], ProviderCallbackType> = {
  bet: 'BET',
  win: 'WIN',
  rollback: 'ROLLBACK',
  balance: 'BALANCE',
};

/**
 * HMAC-SHA256 over the raw request body with the provider's shared secret.
 * The secret is per provider, rotated from the admin console.
 */
export function verifyCallbackSignature(
  provider: Pick<GameProvider, 'webhookSecret' | 'code'>,
  rawBody: Buffer | undefined,
  signature: string | undefined,
): boolean {
  if (!provider.webhookSecret || !rawBody || !signature) return false;
  const expected = createHmac('sha256', provider.webhookSecret).update(rawBody).digest('hex');
  const given = signature.replace(/^sha256=/, '').toLowerCase();
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Signed balance replies bind the amount, currency, timestamp and nonce. */
export function signBalance(
  secret: string,
  input: { sessionId: string; currency: string; balance: bigint; timestamp: number; nonce: string },
): string {
  return createHmac('sha256', secret)
    .update(`${input.sessionId}.${input.currency}.${input.balance}.${input.timestamp}.${input.nonce}`)
    .digest('hex');
}

export function providerLedgerKey(code: string, type: 'bet' | 'win', txnId: string): string {
  return `provider:${code}:${type}:${txnId}`;
}

/** Bet/win keys before type namespacing; still honoured so upgrades never double-credit. */
export function legacyProviderLedgerKey(code: string, txnId: string): string {
  return `provider:${code}:${txnId}`;
}

export function rollbackLedgerKey(code: string, txnId: string): string {
  return `provider:${code}:rollback:${txnId}`;
}
