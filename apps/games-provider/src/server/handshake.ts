import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config';
import type { SessionRecord } from '../domain/types';
import type { Store } from './store';
import { WalletError, verifyBalanceReply, type WalletClient } from './wallet';

export class SessionEndedError extends Error {
  constructor(message = 'Game session is closed') {
    super(message);
    this.name = 'SessionEndedError';
  }
}

export async function handshake(input: {
  token: string;
  config: AppConfig;
  store: Store;
  wallet: WalletClient;
  now?: Date;
}): Promise<SessionRecord> {
  const now = input.now ?? new Date();
  const nonce = randomUUID();
  let reply;
  try {
    reply = await input.wallet.balance(input.token, nonce);
  } catch (error) {
    if (error instanceof WalletError && error.status !== null && error.status >= 400 && error.status < 500) {
      throw new SessionEndedError();
    }
    throw error;
  }
  verifyBalanceReply(input.config.operator.hmacSecret, input.token, reply, now.getTime());
  if (reply.currency !== input.config.operator.currency) {
    // A signed reply in another currency means the operator contract is broken,
    // not that the session ended: surface it on the wallet-unavailable path.
    throw new WalletError(
      502,
      'CURRENCY_MISMATCH',
      `Bingo settles ${reply.currency}, expected ${input.config.operator.currency}`,
    );
  }
  const session = {
    token: input.token,
    operatorCode: input.config.operator.code,
    currency: reply.currency,
    minStake: reply.minStake ?? input.config.limits.minStake,
    maxStake: reply.maxStake ?? input.config.limits.maxStake,
    maxWin: reply.maxWin ?? input.config.limits.maxWin,
    displayBalance: reply.balance,
    status: 'OPEN' as const,
    createdAt: now,
    lastHandshakeAt: now,
  };
  await input.store.saveSession(session);
  return session;
}
