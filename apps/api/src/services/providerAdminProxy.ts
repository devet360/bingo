import { createHmac } from 'node:crypto';
import type { GameProvider } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AppError, Errors } from '../lib/errors';
import { env } from '../config/env';
import { upsertProvider } from './gameProviders';

type ProviderAdminMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';

interface ProviderAdminRequest {
  hostCode: string;
  actorId: string;
  path: string;
  method?: ProviderAdminMethod;
  body?: unknown;
}

export interface ProviderOperatorSummary {
  code: string;
  name: string;
  currency: string;
  status: 'PENDING' | 'ACTIVE' | 'SUSPENDED';
  limits: { maxWin: string };
}

export interface ProviderHost {
  code: string;
  apiBaseUrl: string;
}

function providerBaseUrl(apiBaseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(apiBaseUrl);
  } catch {
    throw Errors.conflict('Configure a valid Games Provider API base URL first', 'PROVIDER_URL_INVALID');
  }
  const localHttp = url.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.search || url.hash) {
    throw Errors.conflict(
      'Games Provider API URLs must use HTTPS and cannot contain credentials, query strings, or fragments',
      'PROVIDER_URL_INVALID',
    );
  }
  if (env.isProd && !url.protocol.startsWith('https')) {
    throw Errors.conflict('Use HTTPS for Games Provider API URLs in production', 'PROVIDER_URL_INVALID');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url;
}

export async function getProviderHost(hostCode: string): Promise<ProviderHost> {
  const provider = await prisma.gameProvider.findUnique({
    where: { code: hostCode },
    select: { code: true, apiBaseUrl: true },
  });
  if (!provider) throw Errors.notFound('Games Provider connection');
  if (!provider.apiBaseUrl) {
    throw Errors.conflict('Configure this provider API base URL first', 'PROVIDER_URL_REQUIRED');
  }
  providerBaseUrl(provider.apiBaseUrl);
  return { code: provider.code, apiBaseUrl: provider.apiBaseUrl };
}

function consoleToken(actorId: string): string {
  const payload = {
    type: 'provider_console',
    actorId,
    role: 'superadmin',
    operatorCode: '*',
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', env.consoleTokenSecret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export async function providerAdminRequest<T = unknown>(
  input: ProviderAdminRequest,
): Promise<T> {
  if (!input.path.startsWith('/api/admin/')) {
    throw Errors.internal('Invalid Games Provider admin path');
  }
  const host = await getProviderHost(input.hostCode);
  const url = new URL(input.path.slice(1), providerBaseUrl(host.apiBaseUrl));
  let response: Response;
  try {
    response = await fetch(url, {
      method: input.method ?? 'GET',
      headers: {
        authorization: `Bearer ${consoleToken(input.actorId)}`,
        ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new AppError(502, 'PROVIDER_ADMIN_UNAVAILABLE', 'Could not reach the Games Provider admin API');
  }

  const text = response.status === 204 ? '' : await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = typeof payload === 'object' && payload !== null && 'error' in payload
      ? payload.error
      : null;
    const remoteError = typeof error === 'object' && error !== null ? error : null;
    const code = remoteError && 'code' in remoteError && typeof remoteError.code === 'string'
      ? remoteError.code
      : 'PROVIDER_ADMIN_ERROR';
    const message = remoteError && 'message' in remoteError && typeof remoteError.message === 'string'
      ? remoteError.message.slice(0, 300)
      : `Games Provider returned HTTP ${response.status}`;
    const status = response.status >= 400 && response.status < 500 ? response.status : 502;
    throw new AppError(status, code, message);
  }
  if (typeof payload !== 'object' || payload === null || !('data' in payload)) {
    throw new AppError(502, 'PROVIDER_ADMIN_RESPONSE_INVALID', 'Games Provider returned an invalid admin response');
  }
  return payload.data as T;
}

export async function syncProviderOperatorToBingo(
  host: ProviderHost,
  operator: ProviderOperatorSummary,
  options: { webhookSecret?: string; preservePreviousSecret?: boolean } = {},
): Promise<GameProvider> {
  const existing = await prisma.gameProvider.findUnique({ where: { code: operator.code } });
  const config = existing?.config && typeof existing.config === 'object' && !Array.isArray(existing.config)
    ? { ...(existing.config as Record<string, unknown>) }
    : {};
  if (options.preservePreviousSecret && existing?.webhookSecret) {
    config.previousWebhookSecret = existing.webhookSecret;
  }

  return upsertProvider({
    code: operator.code,
    name: operator.name,
    kind: 'AGGREGATOR',
    apiBaseUrl: host.apiBaseUrl,
    ...(options.webhookSecret === undefined ? {} : { webhookSecret: options.webhookSecret }),
    currency: operator.currency,
    maxWin: BigInt(operator.limits.maxWin),
    enabled: operator.status === 'ACTIVE',
    sortOrder: existing?.sortOrder ?? 0,
    ...(options.preservePreviousSecret ? { config } : {}),
  });
}
