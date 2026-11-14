import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import type { UserRole } from '@prisma/client';
import { env } from '../config/env';
import { AppError } from '../lib/errors';

const ISSUER = 'bingo-api';
const AUDIENCE = 'bingo-client';
const ALGORITHM = 'HS256';

export interface AccessClaims {
  sub: string;
  role: UserRole;
  sid: string;
}

export interface RefreshClaims {
  sub: string;
  sid: string;
  jti: string;
}

function expiresIn(value: string): SignOptions['expiresIn'] {
  return value as SignOptions['expiresIn'];
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    algorithm: ALGORITHM,
    expiresIn: expiresIn(env.JWT_ACCESS_TTL),
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

export function signRefreshToken(claims: RefreshClaims): string {
  return jwt.sign(claims, env.JWT_REFRESH_SECRET, {
    algorithm: ALGORITHM,
    expiresIn: expiresIn(env.JWT_REFRESH_TTL),
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

function verify(token: string, secret: string, label: string): JwtPayload {
  try {
    return jwt.verify(token, secret, {
      algorithms: [ALGORITHM],
      issuer: ISSUER,
      audience: AUDIENCE,
      clockTolerance: 5,
    }) as JwtPayload;
  } catch {
    throw new AppError(401, `INVALID_${label}_TOKEN`, `${label.toLowerCase()} token is invalid or expired`);
  }
}

export function verifyAccessToken(token: string): AccessClaims {
  const payload = verify(token, env.JWT_ACCESS_SECRET, 'ACCESS');
  if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string' || typeof payload.role !== 'string') {
    throw new AppError(401, 'INVALID_ACCESS_TOKEN', 'Access token payload is malformed');
  }
  return { sub: payload.sub, sid: payload.sid, role: payload.role as UserRole };
}

export function verifyRefreshToken(token: string): RefreshClaims {
  const payload = verify(token, env.JWT_REFRESH_SECRET, 'REFRESH');
  if (
    typeof payload.sub !== 'string' ||
    typeof payload.sid !== 'string' ||
    typeof payload.jti !== 'string'
  ) {
    throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token payload is malformed');
  }
  return { sub: payload.sub, sid: payload.sid, jti: payload.jti };
}
