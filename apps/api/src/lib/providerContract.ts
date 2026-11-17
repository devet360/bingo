import { signBalance } from './providerCallback';

export interface LaunchContext {
  token: string;
  lang: string;
  currency: string;
}

export function buildLaunchUrl(template: string | null, ctx: LaunchContext): string | null {
  if (!template) return null;
  return template
    .replaceAll('{token}', encodeURIComponent(ctx.token))
    .replaceAll('{sessionId}', encodeURIComponent(ctx.token))
    .replaceAll('{lang}', encodeURIComponent(ctx.lang))
    .replaceAll('{currency}', encodeURIComponent(ctx.currency));
}

export type ProviderMovementType = 'balance' | 'bet' | 'win' | 'rollback';

/**
 * Reads and new debits need a live launch session. Settlements (win/rollback)
 * are movements of money the round already committed, so they must land even
 * after the session was closed or its launch TTL expired -- rejecting them
 * would silently forfeit a player's win or refund.
 */
export function movementRequiresOpenSession(type: ProviderMovementType): boolean {
  return type === 'balance' || type === 'bet';
}

export interface BalanceReplyInput {
  secret: string;
  sessionId: string;
  currency: string;
  balance: bigint;
  minStake: bigint | null;
  maxStake: bigint | null;
  maxWin: bigint | null;
  timestamp: number;
  nonce: string;
}

/** Signed balance payload. Limits are optional so older providers keep working. */
export function buildBalanceReply(input: BalanceReplyInput) {
  return {
    currency: input.currency,
    balance: input.balance.toString(),
    timestamp: input.timestamp,
    nonce: input.nonce,
    signature: signBalance(input.secret, {
      sessionId: input.sessionId,
      currency: input.currency,
      balance: input.balance,
      timestamp: input.timestamp,
      nonce: input.nonce,
    }),
    ...(input.minStake !== null ? { minStake: input.minStake.toString() } : {}),
    ...(input.maxStake !== null ? { maxStake: input.maxStake.toString() } : {}),
    ...(input.maxWin !== null ? { maxWin: input.maxWin.toString() } : {}),
  };
}

export function withBalance<T extends Record<string, unknown>>(
  data: T,
  balance: bigint,
): T & { balance: string } {
  return { ...data, balance: balance.toString() };
}
