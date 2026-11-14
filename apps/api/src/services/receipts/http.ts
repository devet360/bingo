/**
 * The only HTTP client used to fetch bank receipts.
 *
 * Ported from cheki (MIT). The allowlist is static and keyed by parser, not
 * derived from the admin-editable endpoint column: an admin typo or a crafted
 * reference can never turn the API into an open proxy (SSRF).
 *
 *   - https only, no credentials in the URL
 *   - every redirect hop is re-checked (max 3)
 *   - one total deadline, body included
 *   - the body is read with a byte cap
 *   - error text is fixed, so a failure is not a port-scan oracle
 */
const MAX_REDIRECTS = 3;

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_PDF_BYTES = 5 * 1024 * 1024;
/** JSON envelope carrying a base64 PDF (M-Pesa). */
export const MAX_ENVELOPE_BYTES = Math.ceil(MAX_PDF_BYTES / 3) * 4 + 64 * 1024;

export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

/** Every host a parser may contact, by parser key. */
const ALLOWED_HOSTS: Record<string, readonly string[]> = {
  telebirr: ['transactioninfo.ethiotelecom.et'],
  mpesa: ['m-pesabusiness.safaricom.et'],
  cbe: ['mb.cbe.com.et'],
  boa: ['cs.bankofabyssinia.com'],
  dashen: ['receipts.dashenbanksc.com'],
  awash: ['awashpay.awashbank.com:8225'],
  cbebirr: ['cbepay1.cbe.com.et'],
  ebirr: ['receipt.ebirr.com'],
  siinqee: ['receipt.ebirr.com'],
  bunna: ['online.bunnabanksc.com'],
  zamzam: ['receipt-backend.zamzambank.com.et'],
  zemen: ['share.zemenbank.com'],
};

export class HostNotAllowedError extends Error {
  constructor() {
    super('Refusing to contact a host that is not a known bank receipt endpoint.');
    this.name = 'HostNotAllowedError';
  }
}

export class ResponseTooLargeError extends Error {
  constructor() {
    super('The bank response was larger than expected.');
    this.name = 'ResponseTooLargeError';
  }
}

export interface SafeResponse {
  status: number;
  contentType: string;
  body: Buffer;
  url: string;
}

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
}

function isAllowed(parser: string, input: string): boolean {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const hosts = ALLOWED_HOSTS[parser];
  return !!hosts && hosts.includes(url.host.toLowerCase());
}

export function assertAllowedUrl(parser: string, input: string): void {
  if (!isAllowed(parser, input)) throw new HostNotAllowedError();
}

/** Read a fetch body into a Buffer, aborting past `maxBytes`. */
async function readCapped(resp: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(resp.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await resp.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError();
  }
  if (!resp.body) return Buffer.alloc(0);
  const reader = resp.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ResponseTooLargeError();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** A copy of `headers` without Authorization, Cookie or Proxy-Authorization. */
function withoutCredentials(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!/^(authorization|proxy-authorization|cookie)$/i.test(k)) out[k] = v;
  }
  return out;
}

export async function safeFetch(parser: string, url: string, opts: SafeFetchOptions): Promise<SafeResponse> {
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let current = url;
  let headers = opts.headers;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertAllowedUrl(parser, current);
    const resp = await fetch(current, { headers, redirect: 'manual', signal });
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      await resp.body?.cancel().catch(() => {});
      if (!location) {
        return { status: resp.status, contentType: '', body: Buffer.alloc(0), url: current };
      }
      const next = new URL(location, current);
      // Like a browser: credentials never follow a redirect to another origin.
      if (headers && next.origin !== new URL(current).origin) headers = withoutCredentials(headers);
      current = next.href;
      continue;
    }
    const body = await readCapped(resp, opts.maxBytes);
    return {
      status: resp.status,
      contentType: resp.headers.get('content-type') ?? '',
      body,
      url: current,
    };
  }
  throw new Error('Too many redirects.');
}

/** Fixed, non-leaky description of a fetch failure. */
export function describeFetchError(e: unknown): string {
  if (e instanceof HostNotAllowedError) return e.message;
  if (e instanceof ResponseTooLargeError) return e.message;
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError' || /timeout/i.test(e.message))) {
    return 'The bank did not answer in time.';
  }
  return 'Could not connect to the bank.';
}
