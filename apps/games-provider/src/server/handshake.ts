import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config';
import type { SessionRecord } from '../domain/types';
import { OperatorError, type OperatorRegistry } from './operatorRegistry';
import type { Store } from './store';
import { WalletError } from './wallet';

export class SessionEndedError extends Error {
  constructor(message = 'Game session is closed') {
    super(message);
    this.name = 'SessionEndedError';
  }
}

export interface HandshakeDeps {
  token: string;
  operatorCode?: string;
  gameId?: string;
  config: AppConfig;
  store: Store;
  registry: OperatorRegistry;
  now?: Date;
}

export async function handshake(input: HandshakeDeps): Promise<SessionRecord> {
  const now = input.now ?? new Date();
  const operatorCode = input.operatorCode ?? input.config.defaultOperatorCode;
  const operator = await input.registry.get(operatorCode);
  if (operator.status !== 'ACTIVE') {
    throw new OperatorError(403, 'OPERATOR_INACTIVE', `Operator ${operatorCode} is not active`);
  }
  if (operator.maintenance) {
    throw new OperatorError(503, 'OPERATOR_MAINTENANCE', `Operator ${operatorCode} is in maintenance`);
  }
  const gameId = input.gameId ?? 'crash';
  if (!operator.enabledGames.includes(gameId)) {
    throw new OperatorError(403, 'GAME_UNAVAILABLE', `Game ${gameId} is not enabled for ${operatorCode}`);
  }

  const existing = await input.store.getSession(input.token);
  if (existing !== null && existing.operatorCode !== operatorCode) {
    throw new OperatorError(403, 'OPERATOR_MISMATCH', 'Session belongs to another operator');
  }
  if (existing !== null && existing.status === 'CLOSED') throw new SessionEndedError();

  const wallet = await input.registry.walletFor(operatorCode);
  const nonce = randomUUID();
  let reply;
  try {
    reply = await wallet.balance(input.token, nonce);
  } catch (error) {
    if (error instanceof WalletError && error.status !== null && error.status >= 400 && error.status < 500) {
      throw new SessionEndedError();
    }
    throw error;
  }
  await input.registry.verifyBalance(operatorCode, input.token, reply, now.getTime());
  if (reply.currency !== operator.currency) {
    throw new WalletError(
      502, 'CURRENCY_MISMATCH',
      `Bingo settles ${reply.currency}, expected ${operator.currency}`,
    );
  }

  const minStake = maxBigInt(reply.minStake ?? operator.limits.minStake, operator.limits.minStake);
  const maxStake = minBigInt(reply.maxStake ?? operator.limits.maxStake, operator.limits.maxStake);
  const maxWin = minBigInt(reply.maxWin ?? operator.limits.maxWin, operator.limits.maxWin);
  if (minStake > maxStake) {
    throw new OperatorError(409, 'LIMITS_CONFLICT', 'Wallet and operator stake limits do not overlap');
  }

  const session: SessionRecord = {
    token: input.token,
    operatorCode,
    gameId,
    currency: reply.currency,
    minStake,
    maxStake,
    maxWin,
    maxBetsPerRound: operator.limits.maxBetsPerRound,
    displayBalance: reply.balance,
    status: 'OPEN',
    createdAt: existing?.createdAt ?? now,
    lastHandshakeAt: now,
  };
  await input.store.saveSession(session);
  return session;
}

const maxBigInt = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const minBigInt = (a: bigint, b: bigint): bigint => (a < b ? a : b);
