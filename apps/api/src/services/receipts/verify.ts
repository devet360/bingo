/**
 * Receipt verification orchestrator.
 *
 * One entry point for every provider: validate the input, fetch through the
 * allowlisted client, parse, then run the shared gate. The result is never
 * thrown; the caller gets a VerifyOutcome it can persist and show.
 *
 * `verifyClientPayload` runs the same parser and gate over bytes supplied by
 * the client (the Mini App fetches Telebirr/M-Pesa from an Ethiopian IP and
 * posts the body). Such bytes are forgeable, so callers must treat a CLIENT or
 * RELAY result as one input among several: an exact amount, a deduplicated
 * reference and the agent's threshold still apply.
 */
import { createParser, parserKey } from './parsers';
import { NotFoundError } from './parsers/base';
import { gateFailureMessage, verificationGate } from './gate';
import { normalizeInput, type NormalizedInput } from './reference';
import { assertAllowedUrl, BROWSER_UA, describeFetchError, safeFetch, type SafeResponse } from './http';
import {
  ReferenceError,
  type ParsedReceipt,
  type ReceiptProvider,
  type ReceiptSource,
  type VerifyInput,
  type VerifyOutcome,
} from './types';

const MAX_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 500;

function fail(
  status: VerifyOutcome['status'],
  message: string,
  source: ReceiptSource,
  url?: string,
  reference?: string,
): VerifyOutcome {
  return { status, message, source, ...(url ? { url } : {}), ...(reference ? { reference } : {}) };
}

function parseOutcome(
  parsed: ParsedReceipt,
  provider: ReceiptProvider,
  input: NormalizedInput,
  source: ReceiptSource,
  url: string,
): VerifyOutcome {
  if (!parsed.verified) {
    return {
      status: 'NOT_VERIFIED',
      message: 'The bank answered, but the response does not look like a receipt for this provider.',
      source,
      parsed,
      url,
      reference: input.reference,
    };
  }

  const gate = verificationGate(parsed, { provider, requestedReference: input.reference });
  if (!gate.ok) {
    return {
      status: gate.reason === 'reference' ? 'NOT_MATCHED' : 'FAILED',
      message: gateFailureMessage(gate),
      source,
      parsed,
      url,
      reference: input.reference,
    };
  }

  return {
    status: 'VERIFIED',
    message: 'Receipt verified by the bank.',
    source,
    parsed,
    url,
    reference: input.reference,
  };
}

/** Server-side fetch and verification. */
export async function verifyReceipt(
  provider: ReceiptProvider,
  rawInput: VerifyInput,
  source: ReceiptSource = 'SERVER',
): Promise<VerifyOutcome> {
  const parser = createParser(provider);
  if (!parser) {
    return fail('UNSUPPORTED', 'This deposit method is confirmed by the agent, not automatically.', source);
  }

  let input: NormalizedInput;
  try {
    input = normalizeInput(provider, rawInput);
  } catch (e) {
    if (e instanceof ReferenceError) return fail('INVALID_REFERENCE', e.message, source);
    throw e;
  }

  const key = parserKey(provider);
  let url: string;
  try {
    url = parser.buildUrl(input);
    assertAllowedUrl(key, url);
  } catch (e) {
    return fail('UNREACHABLE', describeFetchError(e), source, undefined, input.reference);
  }

  let lastRetryable = false;
  let lastReason = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp: SafeResponse;
    try {
      resp = await safeFetch(key, url, {
        headers: { 'User-Agent': BROWSER_UA, ...parser.requestHeaders() },
        timeoutMs: parser.timeoutMs,
        maxBytes: parser.maxBytes,
      });
    } catch (e) {
      lastRetryable = true;
      lastReason = describeFetchError(e);
      if (parser.geoBlocked) break;
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_BACKOFF_MS);
      continue;
    }

    if (parser.notFoundStatuses.includes(resp.status) || parser.isNotFoundResponse(resp)) {
      return fail('NOT_FOUND', parser.notFoundMessage, source, url, input.reference);
    }
    if (resp.status >= 500) {
      lastRetryable = true;
      lastReason = `${provider.name} is currently unavailable (HTTP ${resp.status}).`;
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_BACKOFF_MS);
      continue;
    }
    if (resp.status < 200 || resp.status >= 300) {
      return fail('UNREACHABLE', `${provider.name} refused the request (HTTP ${resp.status}).`, source, url, input.reference);
    }

    try {
      const parsed = await parser.parse(resp, input);
      return parseOutcome(parsed, provider, input, source, url);
    } catch (e) {
      if (e instanceof NotFoundError) {
        return fail('NOT_FOUND', e.message || parser.notFoundMessage, source, url, input.reference);
      }
      return fail(
        'NOT_VERIFIED',
        'The bank answered, but its response could not be read as a receipt.',
        source,
        url,
        input.reference,
      );
    }
  }

  const message = parser.geoBlocked
    ? `${provider.name} only answers Ethiopian IPs, so it could not be checked from our server.`
    : lastRetryable
      ? `${provider.name} did not answer. ${lastReason}`.trim()
      : lastReason || `${provider.name} did not answer.`;
  return fail('UNREACHABLE', message, source, url, input.reference);
}

/**
 * Verify bytes supplied by the client (Mini App background fetch from an
 * Ethiopian IP, or a configured relay). The body is parsed and gate-checked
 * exactly like a server response; the source is recorded so a forged payload
 * can be traced.
 */
export async function verifyClientPayload(
  provider: ReceiptProvider,
  rawInput: VerifyInput,
  payload: { contentType?: string; bodyBase64: string },
  source: ReceiptSource = 'CLIENT',
): Promise<VerifyOutcome> {
  const parser = createParser(provider);
  if (!parser) {
    return fail('UNSUPPORTED', 'This deposit method is confirmed by the agent, not automatically.', source);
  }

  let input: NormalizedInput;
  try {
    input = normalizeInput(provider, rawInput);
  } catch (e) {
    if (e instanceof ReferenceError) return fail('INVALID_REFERENCE', e.message, source);
    throw e;
  }

  let body: Buffer;
  try {
    body = Buffer.from(payload.bodyBase64, 'base64');
  } catch {
    return fail('NOT_VERIFIED', 'The submitted receipt could not be decoded.', source, undefined, input.reference);
  }
  if (body.length === 0) return fail('NOT_VERIFIED', 'The submitted receipt is empty.', source, undefined, input.reference);

  const url = (() => {
    try {
      return parser.buildUrl(input);
    } catch {
      return undefined;
    }
  })();

  if (body.length > parser.maxBytes) {
    return fail('NOT_VERIFIED', 'The submitted receipt is larger than expected.', source, url, input.reference);
  }

  try {
    const resp: SafeResponse = { status: 200, contentType: payload.contentType ?? '', body, url: url ?? '' };
    const parsed = await parser.parse(resp, input);
    return parseOutcome(parsed, provider, input, source, url ?? '');
  } catch (e) {
    if (e instanceof NotFoundError) return fail('NOT_FOUND', e.message || parser.notFoundMessage, source, url, input.reference);
    return fail('NOT_VERIFIED', 'The submitted receipt could not be read as a receipt.', source, url, input.reference);
  }
}

/** Map an internal failure to the deposit record's verification status. */
export function isVerified(outcome: VerifyOutcome): boolean {
  return outcome.status === 'VERIFIED';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
