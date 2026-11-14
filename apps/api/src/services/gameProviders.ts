import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  GameProvider,
  Prisma,
  ProviderGame,
  ProviderKind,
  ProviderSession,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { Errors } from '../lib/errors';
import { minorToWire } from '../lib/money';
import { postLedger } from './ledger';
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
  enabled: boolean;
  sortOrder?: number;
  config?: unknown;
}

export async function upsertProvider(input: ProviderInput): Promise<GameProvider> {
  const code = input.code.trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,32}$/.test(code)) {
    throw Errors.badRequest('Provider code must be 2-32 lowercase letters, digits, - or _');
  }
  return prisma.gameProvider.upsert({
    where: { code },
    create: {
      code,
      name: input.name,
      kind: input.kind,
      apiBaseUrl: input.apiBaseUrl ?? null,
      webhookSecret: input.webhookSecret ?? null,
      enabled: input.enabled,
      sortOrder: input.sortOrder ?? 0,
      config: (input.config ?? undefined) as Prisma.InputJsonValue | undefined,
    },
    update: {
      name: input.name,
      kind: input.kind,
      apiBaseUrl: input.apiBaseUrl ?? null,
      ...(input.webhookSecret !== undefined ? { webhookSecret: input.webhookSecret } : {}),
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

export interface WalletCallback {
  sessionId: string;
  type: 'bet' | 'win' | 'rollback';
  txnId: string;
  amount: string;
  currency?: string;
  roundId?: string;
}

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

/**
 * Wallet movement from a provider. Every callback is idempotent on
 * (provider, txnId); bets debit the player into platform suspense, wins and
 * rollbacks move the opposite way.
 */
export async function applyWalletCallback(
  providerCode: string,
  payload: WalletCallback,
): Promise<{ replayed: boolean }> {
  const provider = await prisma.gameProvider.findUnique({ where: { code: providerCode } });
  if (!provider || !provider.enabled) throw Errors.notFound('Provider');
  if (!/^\d+$/.test(payload.amount) || BigInt(payload.amount) <= 0n) {
    throw Errors.badRequest('amount must be a positive integer in minor units', 'INVALID_AMOUNT');
  }
  const amount = BigInt(payload.amount);
  const session = await prisma.providerSession.findUnique({
    where: { externalSessionId: payload.sessionId },
    include: { user: { select: { id: true, phoneVerifiedAt: true, status: true } } },
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

  const idempotencyKey = `provider:${provider.code}:${payload.txnId}`;

  if (payload.type === 'rollback') {
    const original = await prisma.transactionLedger.findUnique({
      where: { idempotencyKey },
      include: { entries: { include: { account: true } } },
    });
    if (!original) throw Errors.notFound('Original transaction');
    const direction = original.entries.find((entry) => entry.account.ownerKind === 'USER');
    if (!direction) throw Errors.conflict('Original transaction is not reversible', 'ROLLBACK_INVALID');
    const reversed = -direction.amount;

    const rolled = await withTxRetry(() =>
      runTransaction(async (tx) => {
        const existing = await tx.transactionLedger.findUnique({
          where: { idempotencyKey: `provider:${provider.code}:rollback:${payload.txnId}` },
          select: { id: true },
        });
        if (existing) return true;
        await postLedger(tx, {
          idempotencyKey: `provider:${provider.code}:rollback:${payload.txnId}`,
          kind: 'PROVIDER_ROLLBACK',
          refType: 'ProviderSession',
          refId: session.id,
          memo: `Rollback ${payload.txnId} on ${provider.code}`,
          instructions: [
            { ownerKind: 'USER', ownerId: session.userId, code: 'AVAILABLE', delta: reversed },
            { ownerKind: 'PLATFORM', ownerId: 'platform', code: 'SUSPENSE', delta: -reversed },
          ],
        });
        return false;
      }),
    );
    return { replayed: rolled };
  }

  const replayed = await withTxRetry(() =>
    runTransaction(async (tx) => {
      const existing = await tx.transactionLedger.findUnique({
        where: { idempotencyKey },
        select: { id: true },
      });
      if (existing) return true;
      const isBet = payload.type === 'bet';
      await postLedger(tx, {
        idempotencyKey,
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
      return false;
    }),
  );
  return { replayed };
}
