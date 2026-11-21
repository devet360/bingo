import type { BotConfig, OperatorLimits, OperatorRecord, OperatorStatus } from '../domain/types';
import { OperatorError, type OperatorRegistry } from './operatorRegistry';
import type { Store } from './store';

const CODE_RE = /^[a-z0-9_-]{2,32}$/;
const OPERATOR_STATUSES: readonly OperatorStatus[] = ['PENDING', 'ACTIVE', 'SUSPENDED'];
const DEFAULT_LIMITS: OperatorLimits = { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 200 };
const DEFAULT_BOT_CONFIG: BotConfig = {
  enabled: false,
  count: 0,
  stakeMin: 100n,
  stakeMax: 10_000n,
  roundPayoutCap: 0n,
  dayPayoutCap: 0n,
  disclose: false,
};

export interface NewOperatorInput {
  code: string;
  name: string;
  callbackUrl: string;
  allowedOrigins: string[];
  currency?: string;
  localeDefault?: 'en' | 'am';
  limits?: OperatorLimits;
  enabledGames?: string[];
  theme?: Record<string, unknown> | null;
  botConfig?: BotConfig;
}

export interface UpdateOperatorInput {
  name?: string;
  callbackUrl?: string;
  allowedOrigins?: string[];
  localeDefault?: 'en' | 'am';
  limits?: OperatorLimits;
  enabledGames?: string[];
  theme?: Record<string, unknown> | null;
  maintenance?: boolean;
  botConfig?: BotConfig;
}

/**
 * Creates a PENDING operator and mints its first secret. The secret value is
 * returned exactly once, here; every other response only exposes metadata.
 */
export async function createOperator(store: Store, registry: OperatorRegistry, input: NewOperatorInput) {
  const code = input.code.trim();
  if (!CODE_RE.test(code)) {
    throw new OperatorError(400, 'OPERATOR_CODE_INVALID', 'Operator code must be 2-32 lowercase letters, digits, - or _');
  }
  if ((await store.getOperator(code)) !== null) {
    throw new OperatorError(409, 'OPERATOR_EXISTS', `Operator ${code} already exists`);
  }
  const operator: OperatorRecord = {
    code,
    name: requireName(input.name),
    callbackUrl: parseAbsoluteUrl(input.callbackUrl, 'CALLBACK_URL_INVALID'),
    currency: (input.currency ?? 'ETB').toUpperCase(),
    status: 'PENDING',
    allowedOrigins: parseOrigins(input.allowedOrigins),
    localeDefault: input.localeDefault ?? 'en',
    limits: validateLimits(input.limits ?? DEFAULT_LIMITS),
    enabledGames: requireGames(input.enabledGames ?? ['crash']),
    theme: input.theme ?? null,
    botConfig: input.botConfig ?? DEFAULT_BOT_CONFIG,
    maintenance: false,
    probeOkAt: null,
    createdAt: new Date(),
  };
  await store.upsertOperator(operator);
  const rotated = await registry.rotateSecret(code);
  return { operator, secret: rotated.secret, secretVersion: rotated.version };
}

/**
 * Guarded read-modify-write. `upsertOperator` rewrites every column, so the
 * spread carries code, currency, status, probeOkAt and createdAt forward; only
 * the fields the admin may edit are replaced.
 */
export async function updateOperator(store: Store, code: string, patch: UpdateOperatorInput): Promise<OperatorRecord> {
  const existing = await store.getOperator(code);
  if (existing === null) throw new OperatorError(404, 'OPERATOR_NOT_FOUND', `Unknown operator ${code}`);
  const next: OperatorRecord = {
    ...existing,
    name: patch.name !== undefined ? requireName(patch.name) : existing.name,
    callbackUrl: patch.callbackUrl !== undefined
      ? parseAbsoluteUrl(patch.callbackUrl, 'CALLBACK_URL_INVALID')
      : existing.callbackUrl,
    allowedOrigins: patch.allowedOrigins !== undefined
      ? parseOrigins(patch.allowedOrigins)
      : existing.allowedOrigins,
    localeDefault: patch.localeDefault ?? existing.localeDefault,
    limits: patch.limits !== undefined ? validateLimits(patch.limits) : existing.limits,
    enabledGames: patch.enabledGames !== undefined ? requireGames(patch.enabledGames) : existing.enabledGames,
    theme: patch.theme !== undefined ? patch.theme : existing.theme,
    maintenance: patch.maintenance !== undefined ? patch.maintenance : existing.maintenance,
    botConfig: patch.botConfig !== undefined ? patch.botConfig : existing.botConfig,
  };
  await store.upsertOperator(next);
  return next;
}

/**
 * PENDING -> ACTIVE is probe-gated: activation needs a recorded successful
 * probe and at least one active secret to sign callbacks with.
 */
export async function setOperatorStatus(store: Store, code: string, status: OperatorStatus): Promise<OperatorRecord> {
  if (!OPERATOR_STATUSES.includes(status)) {
    throw new OperatorError(400, 'STATUS_INVALID', `Unknown operator status ${String(status)}`);
  }
  const operator = await store.getOperator(code);
  if (operator === null) throw new OperatorError(404, 'OPERATOR_NOT_FOUND', `Unknown operator ${code}`);
  if (status === 'ACTIVE') {
    if (operator.probeOkAt === null) throw new OperatorError(409, 'PROBE_REQUIRED', 'Run a successful probe first');
    const active = (await store.listOperatorSecrets(code)).filter((row) => row.retiredAt === null);
    if (active.length === 0) throw new OperatorError(409, 'SECRET_REQUIRED', 'Operator has no active secret');
  }
  const next = { ...operator, status };
  await store.upsertOperator(next);
  return next;
}

/**
 * Signs and sends one probe to the operator's callback URL. A 2xx answer proves
 * the peer holds the shared secret, so the probe timestamp is recorded and the
 * operator may then be activated.
 */
export async function runProbe(
  store: Store,
  registry: OperatorRegistry,
  code: string,
  fetchImpl: typeof fetch = fetch,
) {
  const operator = await store.getOperator(code);
  if (operator === null) throw new OperatorError(404, 'OPERATOR_NOT_FOUND', `Unknown operator ${code}`);
  const raw = JSON.stringify({ type: 'probe', operator: code, timestamp: Math.floor(Date.now() / 1000) });
  const signature = await registry.signOutbound(code, raw);
  const url = new URL(operator.callbackUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/probe`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-provider-signature': signature },
      body: raw,
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new OperatorError(502, 'PROBE_FAILED', `Probe request failed: ${(error as Error).message}`);
  }
  if (!response.ok) throw new OperatorError(502, 'PROBE_FAILED', `Probe answered ${response.status}`);
  const checkedAt = new Date();
  await store.upsertOperator({ ...operator, probeOkAt: checkedAt });
  return { ok: true as const, checkedAt };
}

function requireName(value: string): string {
  const name = value.trim();
  if (name.length === 0) throw new OperatorError(400, 'OPERATOR_NAME_INVALID', 'Operator name must not be empty');
  return name;
}

function requireGames(value: string[]): string[] {
  const games = value.map((game) => game.trim());
  if (games.length === 0 || games.some((game) => game.length === 0)) {
    throw new OperatorError(400, 'GAMES_INVALID', 'enabledGames must be a non-empty list of game ids');
  }
  return games;
}

function validateLimits(limits: OperatorLimits): OperatorLimits {
  if (limits.minStake < 1n || limits.maxStake < 1n || limits.maxWin < 1n || limits.maxBetsPerRound < 1) {
    throw new OperatorError(400, 'LIMITS_INVALID', 'Limits must be positive');
  }
  if (limits.minStake > limits.maxStake) throw new OperatorError(400, 'LIMITS_INVALID', 'minStake exceeds maxStake');
  return limits;
}

function parseOrigins(origins: string[]): string[] {
  if (origins.length === 0) throw new OperatorError(400, 'ORIGIN_INVALID', 'At least one allowed origin is required');
  return origins.map((origin) => parseAbsoluteUrl(origin, 'ORIGIN_INVALID'));
}

/** Origins land in CSP headers; only absolute http(s) URLs are safe there. */
function parseAbsoluteUrl(value: string, code: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OperatorError(400, code, `${value} is not an absolute URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new OperatorError(400, code, 'Only http(s) URLs are allowed');
  }
  return parsed.toString();
}
