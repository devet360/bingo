/**
 * Receipt relay client.
 *
 * Telebirr and M-Pesa only answer Ethiopian IPs. When RECEIPT_RELAY_URL points
 * at the PHP relay deployed on Ethio Telecom hosting, those two rails are
 * fetched through it; the relay returns the bank's raw body and the local
 * parser and gate still decide the outcome. The result is recorded with
 * source RELAY, so a compromised relay can be traced, never trusted blindly.
 *
 * With no RECEIPT_RELAY_URL the API behaves exactly as before.
 */
import { createParser } from './parsers';
import { normalizeInput } from './reference';
import type { ReceiptProvider, ReceiptSource, VerifyInput, VerifyOutcome } from './types';
import { verifyClientPayload } from './verify';

const RELAY_PROVIDERS = new Set(['telebirr', 'mpesa']);
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;

export type RelayFetch = typeof fetch;

export function relayUrl(): string | null {
  const url = (process.env.RECEIPT_RELAY_URL ?? '').trim();
  return url ? url.replace(/\/+$/, '') : null;
}

export function relayTimeoutMs(): number {
  const configured = Number(process.env.RECEIPT_RELAY_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(configured, MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
}

/** Only the geo-blocked rails this relay serves. */
export function relayEnabled(provider: ReceiptProvider): boolean {
  return !!relayUrl() && RELAY_PROVIDERS.has(provider.code);
}

export interface RelayPayload {
  contentType?: string;
  bodyBase64: string;
}

export type RelayResult = { ok: true; payload: RelayPayload } | { ok: false; message: string };

/** Base64 inflates the bank's answer by 4/3, plus the JSON envelope. */
function payloadLimit(provider: ReceiptProvider): number {
  const maxBytes = createParser(provider)?.maxBytes ?? 2 * 1024 * 1024;
  return Math.ceil(maxBytes / 3) * 4 + 64 * 1024;
}

/** Ask the relay for the bank's own answer. No parsing happens here. */
export async function relayFetchPayload(
  provider: ReceiptProvider,
  input: VerifyInput,
  fetchImpl: RelayFetch = fetch,
  baseUrl: string | null = relayUrl(),
): Promise<RelayResult> {
  if (!baseUrl || !RELAY_PROVIDERS.has(provider.code)) {
    return { ok: false, message: 'No receipt relay is configured for this provider.' };
  }

  const url = `${baseUrl}/receipts/${encodeURIComponent(provider.code)}/${encodeURIComponent(input.reference)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(relayTimeoutMs()),
    });
  } catch {
    return { ok: false, message: 'The receipt service did not answer.' };
  }

  if (!response.ok) {
    return { ok: false, message: `The receipt service refused the request (HTTP ${response.status}).` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, message: 'The receipt service answered with an unreadable response.' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'The receipt service answered with an unreadable response.' };
  }

  const record = body as Record<string, unknown>;
  if (record.ok !== true || typeof record.bodyBase64 !== 'string' || record.bodyBase64 === '') {
    return { ok: false, message: 'The receipt service could not read the bank receipt.' };
  }
  if (record.bodyBase64.length > payloadLimit(provider)) {
    return { ok: false, message: 'The bank response was larger than expected.' };
  }

  return {
    ok: true,
    payload: {
      contentType: typeof record.contentType === 'string' && record.contentType ? record.contentType : undefined,
      bodyBase64: record.bodyBase64,
    },
  };
}

/**
 * Fetch through the relay, then run the same parser and gate as a direct bank
 * answer. An unreachable relay yields UNREACHABLE so callers can fall back.
 */
export async function verifyViaRelay(
  provider: ReceiptProvider,
  rawInput: VerifyInput,
  source: ReceiptSource = 'RELAY',
  fetchImpl: RelayFetch = fetch,
  baseUrl: string | null = relayUrl(),
): Promise<VerifyOutcome> {
  const result = await relayFetchPayload(provider, rawInput, fetchImpl, baseUrl);
  if (result.ok) {
    return verifyClientPayload(provider, rawInput, result.payload, source);
  }

  let reference: string | undefined;
  let url: string | undefined;
  try {
    const input = normalizeInput(provider, rawInput, { requireAccount: false });
    reference = input.reference;
    try {
      url = createParser(provider)?.buildUrl(input);
    } catch {
      url = undefined;
    }
  } catch {
    // The reference is invalid for this provider; the caller's UNREACHABLE
    // result carries the relay's message either way.
  }

  return {
    status: 'UNREACHABLE',
    message: result.message,
    source,
    ...(url ? { url } : {}),
    ...(reference ? { reference } : {}),
  };
}
