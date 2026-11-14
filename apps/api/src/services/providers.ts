/**
 * Deposit provider catalogue.
 *
 * The DB is the source of truth for which rails are on, their limits and the
 * inputs they need. Parsers are selected by the `parser` key, so several
 * providers can share one parser (the eBirr tenants). An admin can change the
 * non-behavioural fields; the parser key and the endpoint host stay constrained
 * by the code that ships with the API (see receipts/http.ts).
 */
import type { DepositProvider, PaymentMethod, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { Errors } from '../lib/errors';
import { minorToWire } from '../lib/money';
import { createParser } from './receipts/parsers';

export function serializeProvider(provider: DepositProvider) {
  return {
    code: provider.code,
    name: provider.name,
    method: provider.method,
    requiresPhone: provider.requiresPhone,
    accountDigits: provider.accountDigits,
    opaqueReference: provider.opaqueReference,
    clientSide: provider.clientSide,
    supported: provider.supported,
    enabled: provider.enabled,
    sortOrder: provider.sortOrder,
    instructions: provider.instructions,
    refHint: provider.refHint,
    refPattern: provider.refPattern,
    minAmount: minorToWire(provider.minAmount),
    maxAmount: minorToWire(provider.maxAmount),
    parser: provider.parser,
    endpoint: provider.endpoint,
  };
}

/** Enabled rails the Mini App may offer. */
export async function listEnabledProviders(method?: PaymentMethod) {
  return prisma.depositProvider.findMany({
    where: { enabled: true, ...(method ? { method } : {}) },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

/** Every row, for the admin console. */
export async function listAllProviders() {
  return prisma.depositProvider.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
}

export async function getProvider(code: string, options: { requireEnabled?: boolean } = {}) {
  const provider = await prisma.depositProvider.findUnique({ where: { code } });
  if (!provider) throw Errors.notFound('Deposit provider');
  if (options.requireEnabled && !provider.enabled) {
    throw Errors.conflict('This deposit method is not available right now', 'PROVIDER_DISABLED');
  }
  return provider;
}

/** True when the provider has a parser that ships with this API. */
export function hasParser(provider: Pick<DepositProvider, 'code' | 'parser' | 'supported'>): boolean {
  return !!createParser(provider);
}

export interface ProviderPatch {
  name?: string;
  enabled?: boolean;
  supported?: boolean;
  requiresPhone?: boolean;
  accountDigits?: number | null;
  opaqueReference?: boolean;
  clientSide?: boolean;
  sortOrder?: number;
  instructions?: string | null;
  refPattern?: string | null;
  refHint?: string | null;
  minAmount?: bigint | null;
  maxAmount?: bigint | null;
  endpoint?: string | null;
}

export async function updateProvider(code: string, patch: ProviderPatch) {
  const current = await getProvider(code);

  if (patch.enabled && !hasParser({ ...current, supported: patch.supported ?? current.supported })) {
    throw Errors.badRequest(
      'Only providers with a receipt parser can be enabled. Leave this one for manual agent confirmation.',
      'PROVIDER_NOT_SUPPORTED',
    );
  }
  if (patch.supported === false && (patch.enabled ?? current.enabled)) {
    throw Errors.badRequest('Disable the provider before marking it unsupported.', 'PROVIDER_STILL_ENABLED');
  }
  if (patch.refPattern) {
    try {
      new RegExp(patch.refPattern);
    } catch {
      throw Errors.badRequest('The reference pattern is not a valid regular expression.', 'INVALID_REF_PATTERN');
    }
  }
  if (patch.endpoint && !/^https:\/\/[^\s]+$/.test(patch.endpoint)) {
    throw Errors.badRequest('The endpoint must be an https URL.', 'INVALID_ENDPOINT');
  }
  if (patch.accountDigits !== undefined && patch.accountDigits !== null && (patch.accountDigits < 1 || patch.accountDigits > 12)) {
    throw Errors.badRequest('Account digits must be between 1 and 12.', 'INVALID_ACCOUNT_DIGITS');
  }
  if (patch.minAmount !== undefined && patch.minAmount !== null && patch.minAmount <= 0n) {
    throw Errors.badRequest('The minimum amount must be positive.', 'INVALID_MIN_AMOUNT');
  }
  if (patch.maxAmount !== undefined && patch.maxAmount !== null && patch.maxAmount <= 0n) {
    throw Errors.badRequest('The maximum amount must be positive.', 'INVALID_MAX_AMOUNT');
  }
  const min = patch.minAmount !== undefined ? patch.minAmount : current.minAmount;
  const max = patch.maxAmount !== undefined ? patch.maxAmount : current.maxAmount;
  if (min !== null && max !== null && min > max) {
    throw Errors.badRequest('The minimum amount cannot be greater than the maximum.', 'INVALID_AMOUNT_RANGE');
  }

  const data: Prisma.DepositProviderUpdateInput = {};
  for (const key of [
    'name',
    'enabled',
    'supported',
    'requiresPhone',
    'accountDigits',
    'opaqueReference',
    'clientSide',
    'sortOrder',
    'instructions',
    'refPattern',
    'refHint',
    'minAmount',
    'maxAmount',
    'endpoint',
  ] as const) {
    if (patch[key] !== undefined) (data as Record<string, unknown>)[key] = patch[key];
  }

  return prisma.depositProvider.update({ where: { code }, data });
}
