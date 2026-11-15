import { randomUUID } from 'node:crypto';
import type {
  GameProvider,
  Prisma,
  ProviderCallbackType,
  ProviderGame,
  ProviderKind,
  ProviderSession,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AppError, Errors } from '../lib/errors';
import { logger } from '../lib/logger';
import { minorToWire } from '../lib/money';
import {
  CALLBACK_ENUM,
  ProviderCallbackSchema,
  type ProviderCallbackPayload,
  legacyProviderLedgerKey,
  providerLedgerKey,
  rollbackLedgerKey,
  signBalance,
  verifyCallbackSignature,
} from '../lib/providerCallback';
import { postLedger } from './ledger';
import { getConfig } from './config';
import { runTransaction, withTxRetry } from '../lib/tx';

const SESSION_TTL_MS = 2 * 60 * 60 * 1_000;

export function serializeProvider(provider: GameProvider) {
  return {
    id: provider.id,
    code: provider.code,
    name: provider.name,
    kind: provider.kind,
    apiBaseUrl: provider.apiBaseUrl,
    // The secret is write-only: operators can rotate it but never read it back.
    hasSecret: Boolean(provider.webhookSecret),
    currency: provider.currency,
    maxWin: minorToWire(provider.maxWin),
    enabled: provider.enabled,
    sortOrder: provider.sortOrder,
    config: provider.config ?? null,
    createdAt: provider.createdAt,
  };
}

export function serializeGame(game: ProviderGame & { provider?: Pick<GameProvider, 'code' | 'name'> }) {
  return {
    id: game.id,
    providerId: game.providerId,
    providerCode: game.provider?.code,
    providerName: game.provider?.name,
    externalId: game.externalId,
    name: game.name,
    category: game.category,
    thumbnailUrl: game.thumbnailUrl,
    launchUrlTemplate: game.launchUrlTemplate,
    minStake: minorToWire(game.minStake),
    maxStake: minorToWire(game.maxStake),
    maxWin: minorToWire(game.maxWin),
    enabled: game.enabled,
    sortOrder: game.sortOrder,
  };
}

export function serializeSession(session: ProviderSession) {
  return {
    id: session.id,
    providerId: session.providerId,
    gameId: session.gameId,
    externalSessionId: session.externalSessionId,
    status: session.status,
    launchUrl: session.launchUrl,
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
  };
}

export async function listProviderCatalog() {
  return prisma.gameProvider.findMany({
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { games: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] } },
  });
}

/** Player-facing lobby: only enabled providers with enabled games. */
export async function listPlayableGames() {
  const providers = await prisma.gameProvider.findMany({
    where: { enabled: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: {
      games: {
        where: { enabled: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      },
    },
  });
  return providers
    .filter((provider) => provider.games.length > 0)
    .map((provider) => ({
      ...serializeProvider(provider),
      games: provider.games.map((game) => serializeGame({ ...game, provider })),
    }));
}

export interface ProviderInput {
  code: string;
  name: string;
  kind: ProviderKind;
  apiBaseUrl?: string | null;
  webhookSecret?: string | null;
  currency?: string;
  maxWin?: bigint | null;
  enabled: boolean;
  sortOrder?: number;
  config?: unknown;
}

export async function upsertProvider(input: ProviderInput): Promise<GameProvider> {
  const code = input.code.trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,32}$/.test(code)) {
    throw Errors.badRequest('Provider code must be 2-32 lowercase letters, digits, - or _');
  }
  const currency = (input.currency ?? 'ETB').toUpperCase();
  if (!/^[A-Z]{3,8}$/.test(currency)) {
    throw Errors.badRequest('Currency must be a 3-8 letter ISO code');
  }
  return prisma.gameProvider.upsert({
    where: { code },
    create: {
      code,
      name: input.name,
      kind: input.kind,
      apiBaseUrl: input.apiBaseUrl ?? null,
      webhookSecret: input.webhookSecret ?? null,
      currency,
      maxWin: input.maxWin ?? null,
      enabled: input.enabled,
      sortOrder: input.sortOrder ?? 0,
      config: (input.config ?? undefined) as Prisma.InputJsonValue | undefined,
    },
    update: {
      name: input.name,
      kind: input.kind,
      apiBaseUrl: input.apiBaseUrl ?? null,
      currency,
      ...(input.webhookSecret !== undefined ? { webhookSecret: input.webhookSecret } : {}),
      ...(input.maxWin !== undefined ? { maxWin: input.maxWin } : {}),
      enabled: input.enabled,
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.config !== undefined
        ? { config: input.config as Prisma.InputJsonValue }
        : {}),
    },
  });
}

export async function deleteProvider(code: string): Promise<void> {
  const removed = await prisma.gameProvider.deleteMany({ where: { code } });
  if (removed.count === 0) throw Errors.notFound('Provider');
}

export interface GameInput {
  externalId: string;
  name: string;
  category?: string | null;
  thumbnailUrl?: string | null;
  launchUrlTemplate?: string | null;
  minStake?: bigint | null;
  maxStake?: bigint | null;
  maxWin?: bigint | null;
  enabled: boolean;
  sortOrder?: number;
}

export async function upsertGame(providerCode: string, input: GameInput): Promise<ProviderGame> {
  const provider = await prisma.gameProvider.findUnique({ where: { code: providerCode } });
  if (!provider) throw Errors.notFound('Provider');
  return prisma.providerGame.upsert({
    where: {
      providerId_externalId: { providerId: provider.id, externalId: input.externalId },
    },
    create: {
      providerId: provider.id,
      externalId: input.externalId,
      name: input.name,
      category: input.category ?? null,
      thumbnailUrl: input.thumbnailUrl ?? null,
      launchUrlTemplate: input.launchUrlTemplate ?? null,
      minStake: input.minStake ?? null,
      maxStake: input.maxStake ?? null,
      maxWin: input.maxWin ?? null,
      enabled: input.enabled,
      sortOrder: input.sortOrder ?? 0,
    },
    update: {
      name: input.name,
      category: input.category ?? null,
      thumbnailUrl: input.thumbnailUrl ?? null,
      launchUrlTemplate: input.launchUrlTemplate ?? null,
      minStake: input.minStake ?? null,
      maxStake: input.maxStake ?? null,
      maxWin: input.maxWin ?? null,
      enabled: input.enabled,
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
    },
  });
}

export async function deleteGame(providerCode: string, externalId: string): Promise<void> {
  const provider = await prisma.gameProvider.findUnique({ where: { code: providerCode } });
  if (!provider) throw Errors.notFound('Provider');
  const removed = await prisma.providerGame.deleteMany({
    where: { providerId: provider.id, externalId },
  });
  if (removed.count === 0) throw Errors.notFound('Game');
}

function buildLaunchUrl(template: string | null, token: string, lang: string): string | null {
  if (!template) return null;
  return template
    .replaceAll('{token}', encodeURIComponent(token))
    .replaceAll('{sessionId}', encodeURIComponent(token))
    .replaceAll('{lang}', encodeURIComponent(lang))
    .replaceAll('{currency}', 'CREDIT');
}

/** Issues a provider session token and returns the launch URL for the game iframe. */
export async function launchGame(input: {
  userId: string;
  gameId?: string;
  providerCode?: string;
  externalId?: string;
  lang: string;
}): Promise<ProviderSession> {
  const game = input.gameId
    ? await prisma.providerGame.findUnique({
        where: { id: input.gameId },
        include: { provider: true },
      })
    : await prisma.providerGame.findFirst({
        where: {
          externalId: input.externalId,
          provider: { code: input.providerCode },
        },
        include: { provider: true },
      });
  if (!game) throw Errors.notFound('Game');
  if (!game.enabled || !game.provider.enabled) {
    throw Errors.conflict('This game is not available right now', 'GAME_UNAVAILABLE');
  }

  const externalSessionId = randomUUID();
  return prisma.providerSession.create({
    data: {
      userId: input.userId,
      providerId: game.providerId,
      gameId: game.id,
      externalSessionId,
      launchUrl: buildLaunchUrl(game.launchUrlTemplate, externalSessionId, input.lang),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
}

export async function closeSession(userId: string, sessionId: string): Promise<void> {
  const closed = await prisma.providerSession.updateMany({
    where: { id: sessionId, userId, status: 'OPEN' },
    data: { status: 'CLOSED' },
  });
  if (closed.count === 0) throw Errors.notFound('Game session');
}

/** Operator-wide single-win ceiling (30,000 ETB) when no narrower cap is set. */
export const PROVIDER_MAX_WIN_CONFIG_KEY = 'provider.maxWin';
export const DEFAULT_PROVIDER_MAX_WIN = 3_000_000n;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ProviderAudit {
  providerCode: string;
  type: ProviderCallbackType | null;
  externalTxnId: string | null;
  externalSessionId: string | null;
  signatureValid: boolean;
  amount: bigint | null;
  currency: string | null;
  payload: Prisma.InputJsonValue;
  ip: string | null;
}

/** Audit is best-effort: a logging failure must never change the provider's result. */
async function writeCallbackLog(
  audit: ProviderAudit,
  httpStatus: number,
  error?: string,
): Promise<void> {
  try {
    await prisma.providerCallbackLog.create({
      data: { ...audit, httpStatus, error: error ?? null },
    });
  } catch (logError) {
    logger.warn({ err: logError }, 'failed to persist provider callback audit');
  }
}

interface SessionContext {
  id: string;
  userId: string;
  gameId: string | null;
  game: ProviderGame | null;
}

async function resolveMaxWin(provider: GameProvider, game: ProviderGame | null): Promise<bigint> {
  if (game?.maxWin && game.maxWin > 0n) return game.maxWin;
  if (provider.maxWin && provider.maxWin > 0n) return provider.maxWin;
  const configured = await getConfig<string | null>(PROVIDER_MAX_WIN_CONFIG_KEY, null);
  if (typeof configured === 'string' && /^\d+$/.test(configured) && BigInt(configured) > 0n) {
    return BigInt(configured);
  }
  return DEFAULT_PROVIDER_MAX_WIN;
}

async function findOriginalLedger(
  tx: Prisma.TransactionClient,
  providerCode: string,
  txnId: string,
) {
  return tx.transactionLedger.findFirst({
    where: {
      idempotencyKey: {
        in: [
          providerLedgerKey(providerCode, 'bet', txnId),
          providerLedgerKey(providerCode, 'win', txnId),
          legacyProviderLedgerKey(providerCode, txnId),
        ],
      },
    },
    include: { entries: { include: { account: true } } },
  });
}

async function applyProviderMovement(input: {
  provider: GameProvider;
  session: SessionContext;
  payload: Extract<ProviderCallbackPayload, { type: 'bet' | 'win' }>;
  amount: bigint;
}): Promise<boolean> {
  const { provider, session, payload, amount } = input;
  const isBet = payload.type === 'bet';
  const type: ProviderCallbackType = isBet ? 'BET' : 'WIN';
  const key = providerLedgerKey(provider.code, payload.type, payload.txnId);

  return withTxRetry(() =>
    runTransaction(async (tx) => {
      const existingTxn = await tx.providerTransaction.findUnique({
        where: {
          providerCode_externalTxnId_type: {
            providerCode: provider.code,
            externalTxnId: payload.txnId,
            type,
          },
        },
        select: { id: true, status: true },
      });
      if (existingTxn) {
        if (existingTxn.status === 'ROLLED_BACK') {
          throw Errors.conflict('Transaction was rolled back', 'TRANSACTION_ROLLED_BACK');
        }
        return true;
      }

      const existingLedger =
        (await tx.transactionLedger.findUnique({
          where: { idempotencyKey: key },
          select: { id: true, kind: true },
        })) ??
        (await tx.transactionLedger.findUnique({
          where: { idempotencyKey: legacyProviderLedgerKey(provider.code, payload.txnId) },
          select: { id: true, kind: true },
        }));

      if (existingLedger) {
        const expectedKind = isBet ? 'PROVIDER_BET' : 'PROVIDER_WIN';
        if (existingLedger.kind !== expectedKind) {
          throw Errors.conflict(
            'Transaction id was already used for a different movement',
            'TXN_TYPE_MISMATCH',
          );
        }
        await tx.providerTransaction.create({
          data: {
            providerCode: provider.code,
            type,
            externalTxnId: payload.txnId,
            userId: session.userId,
            sessionId: session.id,
            gameId: session.gameId,
            amount,
            currency: provider.currency,
            status: 'APPLIED',
            ledgerId: existingLedger.id,
          },
        });
        return true;
      }

      const posted = await postLedger(tx, {
        idempotencyKey: key,
        kind: isBet ? 'PROVIDER_BET' : 'PROVIDER_WIN',
        refType: 'ProviderSession',
        refId: session.id,
        memo: `${isBet ? 'Bet' : 'Win'} ${payload.txnId} on ${provider.code}`,
        instructions: isBet
          ? [
              { ownerKind: 'USER', ownerId: session.userId, code: 'AVAILABLE', delta: -amount },
              { ownerKind: 'PLATFORM', ownerId: 'platform', code: 'SUSPENSE', delta: amount },
            ]
          : [
              { ownerKind: 'PLATFORM', ownerId: 'platform', code: 'SUSPENSE', delta: -amount },
              { ownerKind: 'USER', ownerId: session.userId, code: 'AVAILABLE', delta: amount },
            ],
      });
      await tx.providerTransaction.create({
        data: {
          providerCode: provider.code,
          type,
          externalTxnId: payload.txnId,
          userId: session.userId,
          sessionId: session.id,
          gameId: session.gameId,
          amount,
          currency: provider.currency,
          status: 'APPLIED',
          ledgerId: posted.ledgerId,
        },
      });
      return posted.replayed;
    }),
  ).catch((error) => {
    // A concurrent duplicate can lose the unique race before it sees the
    // committed journal; that is exactly the replay the provider wants.
    if (isPrismaUniqueViolation(error)) return true;
    throw error;
  });
}

async function rollbackProviderMovement(input: {
  provider: GameProvider;
  session: SessionContext;
  payload: Extract<ProviderCallbackPayload, { type: 'rollback' }>;
  amount: bigint;
}): Promise<boolean> {
  const { provider, session, payload, amount } = input;

  return withTxRetry(() =>
    runTransaction(async (tx) => {
      const existingRollback = await tx.providerTransaction.findUnique({
        where: {
          providerCode_externalTxnId_type: {
            providerCode: provider.code,
            externalTxnId: payload.txnId,
            type: 'ROLLBACK',
          },
        },
        select: { id: true },
      });
      if (existingRollback) return true;

      const original = await findOriginalLedger(tx, provider.code, payload.txnId);
      if (!original) throw Errors.notFound('Original transaction');
      const direction = original.entries.find((entry) => entry.account.ownerKind === 'USER');
      if (!direction || direction.amount === 0n) {
        throw Errors.conflict('Original transaction is not reversible', 'ROLLBACK_INVALID');
      }

      const magnitude = direction.amount < 0n ? -direction.amount : direction.amount;
      if (amount !== magnitude) {
        throw Errors.conflict(
          'Rollback amount does not match the original transaction',
          'ROLLBACK_AMOUNT_MISMATCH',
        );
      }

      const reversed = -direction.amount;
      const posted = await postLedger(tx, {
        idempotencyKey: rollbackLedgerKey(provider.code, payload.txnId),
        kind: 'PROVIDER_ROLLBACK',
        refType: 'ProviderSession',
        refId: session.id,
        memo: `Rollback ${payload.txnId} on ${provider.code}`,
        instructions: [
          { ownerKind: 'USER', ownerId: session.userId, code: 'AVAILABLE', delta: reversed },
          { ownerKind: 'PLATFORM', ownerId: 'platform', code: 'SUSPENSE', delta: -reversed },
        ],
      });
      await tx.providerTransaction.create({
        data: {
          providerCode: provider.code,
          type: 'ROLLBACK',
          externalTxnId: payload.txnId,
          userId: session.userId,
          sessionId: session.id,
          gameId: session.gameId,
          amount: magnitude,
          currency: provider.currency,
          status: 'APPLIED',
          ledgerId: posted.ledgerId,
        },
      });

      const originalType: ProviderCallbackType | null =
        original.kind === 'PROVIDER_BET'
          ? 'BET'
          : original.kind === 'PROVIDER_WIN'
            ? 'WIN'
            : null;
      if (originalType) {
        await tx.providerTransaction.updateMany({
          where: {
            providerCode: provider.code,
            externalTxnId: payload.txnId,
            type: originalType,
          },
          data: { status: 'ROLLED_BACK' },
        });
      }
      return posted.replayed;
    }),
  );
}

function isPrismaUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Single entry point for provider wallet traffic. Every request — valid,
 * forged or malformed — leaves a ProviderCallbackLog row, and money movement
 * additionally lands in ProviderTransaction before the caller sees success.
 */
export async function handleProviderCallback(input: {
  providerCode: string;
  rawBody?: Buffer;
  signature?: string;
  body: unknown;
  ip?: string | null;
}): Promise<{ status: number; data: Record<string, unknown> }> {
  const provider = await prisma.gameProvider.findUnique({ where: { code: input.providerCode } });
  if (!provider) throw Errors.notFound('Provider');

  const signatureValid = verifyCallbackSignature(provider, input.rawBody, input.signature);
  const parsed = ProviderCallbackSchema.safeParse(input.body ?? {});
  const raw = isRecord(input.body) ? input.body : {};

  const audit: ProviderAudit = {
    providerCode: provider.code,
    type: parsed.success ? CALLBACK_ENUM[parsed.data.type] : null,
    externalTxnId:
      (parsed.success && 'txnId' in parsed.data ? parsed.data.txnId : undefined) ??
      (typeof raw.txnId === 'string' ? raw.txnId.slice(0, 128) : null),
    externalSessionId:
      (parsed.success ? parsed.data.sessionId : undefined) ??
      (typeof raw.sessionId === 'string' ? raw.sessionId.slice(0, 128) : null),
    signatureValid,
    amount: null,
    currency:
      parsed.success && parsed.data.currency ? parsed.data.currency.toUpperCase() : null,
    payload: (isRecord(input.body) || Array.isArray(input.body) ? input.body : {}) as Prisma.InputJsonValue,
    ip: input.ip ?? null,
  };

  try {
    if (!signatureValid) {
      throw Errors.forbidden('Invalid provider signature', 'SIGNATURE_INVALID');
    }
    if (!parsed.success) {
      throw Errors.badRequest('Provider callback body is invalid', 'CALLBACK_MALFORMED', {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    const payload = parsed.data;

    const currency = (payload.currency ?? provider.currency).toUpperCase();
    audit.currency = currency;
    if (currency !== provider.currency.toUpperCase()) {
      throw Errors.badRequest(
        `Provider settles in ${provider.currency}`,
        'CURRENCY_MISMATCH',
      );
    }

    const session = await prisma.providerSession.findUnique({
      where: { externalSessionId: payload.sessionId },
      include: {
        game: true,
        user: { select: { id: true, phoneVerifiedAt: true, status: true } },
      },
    });
    if (!session || session.providerId !== provider.id) throw Errors.notFound('Game session');
    if (session.status !== 'OPEN' || session.expiresAt <= new Date()) {
      throw Errors.conflict('Game session is closed', 'SESSION_CLOSED');
    }
    if (session.user.status !== 'ACTIVE') {
      throw Errors.forbidden('Account is not active', 'ACCOUNT_INACTIVE');
    }
    if (!session.user.phoneVerifiedAt) {
      throw Errors.forbidden('Phone verification required', 'PHONE_VERIFICATION_REQUIRED');
    }

    const context: SessionContext = {
      id: session.id,
      userId: session.userId,
      gameId: session.gameId,
      game: session.game,
    };

    if (payload.type === 'balance') {
      const wallet = await prisma.wallet.findUnique({
        where: { userId: session.userId },
        select: { available: true },
      });
      const available = wallet?.available ?? 0n;
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = payload.nonce ?? randomUUID();
      await writeCallbackLog(audit, 200);
      return {
        status: 200,
        data: {
          currency: provider.currency,
          balance: available.toString(),
          timestamp,
          nonce,
          signature: signBalance(provider.webhookSecret!, {
            sessionId: payload.sessionId,
            currency: provider.currency,
            balance: available,
            timestamp,
            nonce,
          }),
        },
      };
    }

    const amount = BigInt(payload.amount);
    audit.amount = amount;

    if (payload.type === 'rollback') {
      const replayed = await rollbackProviderMovement({
        provider,
        session: context,
        payload,
        amount,
      });
      await writeCallbackLog(audit, replayed ? 200 : 201);
      return { status: replayed ? 200 : 201, data: { accepted: true, replayed } };
    }

    if (payload.type === 'win') {
      const cap = await resolveMaxWin(provider, context.game);
      if (amount > cap) {
        throw Errors.conflict(
          `Win exceeds the ${cap.toString()} minor-unit ceiling`,
          'WIN_LIMIT_EXCEEDED',
        );
      }
    }

    const replayed = await applyProviderMovement({
      provider,
      session: context,
      payload,
      amount,
    });
    await writeCallbackLog(audit, replayed ? 200 : 201);
    return { status: replayed ? 200 : 201, data: { accepted: true, replayed } };
  } catch (error) {
    const appError = error instanceof AppError ? error : Errors.internal('Provider callback failed');
    await writeCallbackLog(audit, appError.status, `${appError.code}: ${appError.message}`);
    throw appError;
  }
}

