import { randomUUID } from 'node:crypto';
import type { ClientPlatform, User } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { sha256Hex } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from './jwt';

export interface SessionMeta {
  platform: ClientPlatform;
  ip?: string;
  userAgent?: string;
  deviceId?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  refreshExpiresAt: Date;
}

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function durationToMs(value: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(value.trim());
  if (!match) throw new Error(`Unsupported duration: ${value}`);
  return Number(match[1]) * UNIT_MS[match[2]!]!;
}

function refreshExpiry(): Date {
  return new Date(Date.now() + durationToMs(env.JWT_REFRESH_TTL));
}

export async function issueSession(
  user: Pick<User, 'id' | 'role'>,
  meta: SessionMeta,
): Promise<TokenPair> {
  const sessionId = randomUUID();
  const refreshToken = signRefreshToken({ sub: user.id, sid: sessionId, jti: randomUUID() });
  const refreshExpiresAt = refreshExpiry();

  await prisma.authSession.create({
    data: {
      id: sessionId,
      userId: user.id,
      refreshTokenHash: sha256Hex(refreshToken),
      platform: meta.platform,
      ip: meta.ip,
      userAgent: meta.userAgent,
      deviceId: meta.deviceId,
      expiresAt: refreshExpiresAt,
    },
  });

  return {
    accessToken: signAccessToken({ sub: user.id, role: user.role, sid: sessionId }),
    refreshToken,
    sessionId,
    refreshExpiresAt,
  };
}

export async function rotateSession(refreshToken: string, meta: Partial<SessionMeta>): Promise<TokenPair> {
  const claims = verifyRefreshToken(refreshToken);
  const session = await prisma.authSession.findUnique({
    where: { id: claims.sid },
    include: { user: { select: { id: true, role: true, status: true } } },
  });

  if (!session || session.userId !== claims.sub || session.revokedAt || session.expiresAt <= new Date()) {
    throw new AppError(401, 'SESSION_EXPIRED', 'Session is no longer valid, sign in again');
  }
  if (session.user.status !== 'ACTIVE') {
    throw new AppError(403, 'ACCOUNT_INACTIVE', 'Account is not active');
  }

  // A valid JWT with a stale hash means the token was already rotated: treat as theft.
  if (session.refreshTokenHash !== sha256Hex(refreshToken)) {
    await prisma.authSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
    throw new AppError(401, 'REFRESH_TOKEN_REUSED', 'Refresh token reuse detected, sign in again');
  }

  const nextRefreshToken = signRefreshToken({
    sub: session.userId,
    sid: session.id,
    jti: randomUUID(),
  });
  const refreshExpiresAt = refreshExpiry();

  await prisma.authSession.update({
    where: { id: session.id },
    data: {
      refreshTokenHash: sha256Hex(nextRefreshToken),
      expiresAt: refreshExpiresAt,
      lastUsedAt: new Date(),
      ...(meta.ip ? { ip: meta.ip } : {}),
      ...(meta.userAgent ? { userAgent: meta.userAgent } : {}),
    },
  });

  return {
    accessToken: signAccessToken({
      sub: session.userId,
      role: session.user.role,
      sid: session.id,
    }),
    refreshToken: nextRefreshToken,
    sessionId: session.id,
    refreshExpiresAt,
  };
}

export async function revokeSession(sessionId: string, userId: string): Promise<void> {
  await prisma.authSession.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
