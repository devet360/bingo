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

export const ProviderProbeSchema = z.object({
  type: z.literal('probe'),
  operator: z.string().max(64).optional(),
  timestamp: z.number().int().optional(),
});

export const CALLBACK_ENUM: Record<ProviderCallbackPayload['type'], ProviderCallbackType> = {
  bet: 'BET',
  win: 'WIN',
  rollback: 'ROLLBACK',
  balance: 'BALANCE',
};

const SAFE_EQUAL = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
};

function signingSecrets(
  provider: Pick<GameProvider, 'webhookSecret' | 'code'> & Partial<Pick<GameProvider, 'config'>>,
): string[] {
  if (!provider.webhookSecret) return [];
  const config = (provider.config ?? null) as { previousWebhookSecret?: unknown } | null;
  const previous =
    typeof config?.previousWebhookSecret === 'string' ? config.previousWebhookSecret : null;
  return previous ? [provider.webhookSecret, previous] : [provider.webhookSecret];
}

/**
 * Providers sign `${code}.${rawBody}`; V1 deployments signed the bare body.
 * Both remain valid, and rotation allows the previous secret in the overlap.
 */
export function verifyCallbackSignature(
  provider: Pick<GameProvider, 'webhookSecret' | 'code'> & Partial<Pick<GameProvider, 'config'>>,
  rawBody: Buffer | undefined,
  signature: string | undefined,
): boolean {
  if (!rawBody || !signature) return false;
  const given = signature.replace(/^sha256=/, '').toLowerCase();
  const scoped = Buffer.concat([Buffer.from(`${provider.code}.`, 'utf8'), rawBody]);
  return signingSecrets(provider).some((secret) => {
    const scopedExpected = createHmac('sha256', secret).update(scoped).digest('hex');
    const legacyExpected = createHmac('sha256', secret).update(rawBody).digest('hex');
    return SAFE_EQUAL(scopedExpected, given) || SAFE_EQUAL(legacyExpected, given);
  });
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
