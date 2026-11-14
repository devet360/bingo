/**
 * Receipt reference handling, ported from cheki (MIT) and narrowed for the
 * deposit flow: a reference is either typed by the player or taken out of the
 * receipt link, never fetched as given.
 */
import { ReferenceError, type ReceiptProvider } from './types';

const SEPARATORS_RE = /[\s\u200B-\u200D\u2060\uFEFF\-\u2010-\u2015\u2212]/g;
const ALNUM_RE = /^[A-Za-z0-9]+$/;
const MAX_REF_LENGTH = 512;

interface CaseRule {
  shape: RegExp;
  only?: RegExp;
}

const CASE_RULES: Record<string, CaseRule> = {
  cbe: { shape: /^FT[A-Z0-9]{8,12}$/, only: /^FT[A-Z0-9]{8,12}$/i },
  boa: { shape: /^[A-Z]{2}[A-Z0-9]{4,30}$/ },
  telebirr: { shape: /^[A-Z0-9]{10}$/ },
  mpesa: { shape: /^[A-Z0-9]{6,20}$/ },
  dashen: { shape: /^[A-Z0-9]{16}$/ },
  cbebirr: { shape: /^[A-Z0-9]{10,11}$/ },
};

/** One canonical Bunna token: URL-decoded, base64url mapped to base64, padded. */
export function canonicalBunnaToken(value: string): string {
  const trimmed = value.trim();
  let s = trimmed;
  if (s.includes('%')) {
    try {
      s = decodeURIComponent(s);
    } catch {
      return trimmed;
    }
  }
  s = s.replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
  const m = /^([A-Za-z0-9+/]+)={0,2}$/.exec(s);
  if (!m || m[1].length % 4 === 1) return trimmed;
  return m[1] + '='.repeat((4 - (m[1].length % 4)) % 4);
}

function compact(value: string): string {
  return value.replace(SEPARATORS_RE, '');
}

/** The same case rules as cheki: only known uppercase-reference banks are touched. */
export function canonicalReference(code: string, reference: string, opts: { compact?: boolean } = {}): string {
  const trimmed = reference.trim();
  if (!trimmed) return trimmed;
  if (code === 'bunna') return canonicalBunnaToken(trimmed);
  if (code === 'zamzam') {
    if (opts.compact === false) return trimmed;
    const c = compact(trimmed);
    return /^\d+$/.test(c) ? c : trimmed;
  }
  const rule = CASE_RULES[code];
  if (!rule) return trimmed;
  if (opts.compact !== false) {
    const c = compact(trimmed).toUpperCase();
    if (c !== trimmed.toUpperCase() && rule.shape.test(c)) return c;
  }
  if (!ALNUM_RE.test(trimmed)) return trimmed;
  if (rule.only && !rule.only.test(trimmed)) return trimmed;
  return trimmed.toUpperCase();
}

/** Pull the reference out of a full receipt link, when one was pasted. */
export function referenceFromUrl(code: string, raw: string): string | null {
  if (!/^https?:\/\//i.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.host.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));

  switch (code) {
    case 'telebirr':
      return parts[0] === 'receipt' && parts[1] ? parts[1] : null;
    case 'cbe':
      // mbreciept.cbe.com.et/receipt/{id}, or /{id} on the API host.
      return host.startsWith('mb.cbe.com.et')
        ? parts[parts.length - 1] ?? null
        : parts[0] === 'receipt' && parts[1]
          ? parts[1]
          : null;
    case 'boa': {
      // /slip/?trx=REF12345
      const trx = url.searchParams.get('trx');
      if (trx) return trx;
      return parts[parts.length - 1] ?? null;
    }
    case 'dashen':
      return parts[0] === 'receipt' && parts[1] ? parts[1] : null;
    case 'awash': {
      const last = parts[parts.length - 1];
      return last ? last.replace(/^-/, '') : null;
    }
    case 'cbebirr': {
      const tid = url.searchParams.get('TID');
      return tid ?? null;
    }
    case 'siinqee':
    case 'nib':
    case 'wegagen':
    case 'ahadu':
    case 'kaafimf':
      return parts.length >= 2 ? parts[parts.length - 1] : null;
    case 'ebirr':
      // The eBirr receipt key is "tenant/token"; the link is .../{tenant}/{token}.
      return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : null;
    case 'bunna': {
      // /receipt/#/{token}: the token is in the fragment, not the path.
      const hash = url.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
      if (hash[0] === 'receipt' || hash[0] === 'receipt-v2') hash.shift();
      return hash.length ? decodeURIComponent(hash.join('/')) : null;
    }
    case 'zamzam':
      return parts[0] === 'receipt' && parts[1] ? parts[1] : null;
    case 'zemen':
      return parts[0] === 'rt' && parts[1] ? parts[1] : null;
    case 'mpesa': {
      const trx = url.searchParams.get('trxNo');
      return trx ?? null;
    }
    default:
      return null;
  }
}

export function checkAccountSuffix(input: string, digits: number): string {
  const cleaned = input.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(cleaned) || cleaned.length > 32) {
    throw new ReferenceError('The account number can only contain digits.');
  }
  if (cleaned.length < digits) {
    throw new ReferenceError(`Enter at least the last ${digits} digits of the receiving account.`);
  }
  return cleaned.slice(-digits);
}

/** CBE Birr wants the payer phone as 2519XXXXXXXX (or 2517XXXXXXXX). */
export function normalizeCbeBirrPhone(input: string): string {
  const digits = input.replace(/[\s()+-]/g, '');
  if (!/^\d+$/.test(digits)) throw new ReferenceError("Enter the payer's phone number using digits only.");
  let local: string | undefined;
  if (digits.length === 12 && digits.startsWith('251')) local = digits.slice(3);
  else if (digits.length === 10 && digits.startsWith('0')) local = digits.slice(1);
  else if (digits.length === 9) local = digits;
  if (!local || !/^[79]\d{8}$/.test(local)) {
    throw new ReferenceError("Enter the payer's CBE Birr number, e.g. 09XXXXXXXX.");
  }
  return `251${local}`;
}

export function checkPhone(input: string): string {
  const cleaned = input.replace(/[\s()-]/g, '');
  if (!/^\+?\d{9,15}$/.test(cleaned)) {
    throw new ReferenceError("Enter the payer's phone number using digits only.");
  }
  return cleaned;
}

export interface NormalizedInput {
  reference: string;
  accountNumber?: string;
  phoneNumber?: string;
}

/**
 * Validate a provider's reference (and the extra inputs it needs) before any
 * request is made. Rejects traversal/attribute tricks, not just bad shapes.
 */
export function normalizeInput(provider: ReceiptProvider, input: { reference?: string; accountNumber?: string; phoneNumber?: string }): NormalizedInput {
  const raw = (input.reference ?? '').trim();
  if (!raw) throw new ReferenceError('Receipt reference is required.');
  if (raw.length > MAX_REF_LENGTH) throw new ReferenceError('That reference is too long to be a receipt number.');

  const fromUrl = referenceFromUrl(provider.code, raw);
  const value = canonicalReference(provider.code, fromUrl ?? raw, { compact: !fromUrl });

  if (value.length > MAX_REF_LENGTH) throw new ReferenceError('That reference is too long to be a receipt number.');

  if (provider.code === 'bunna') {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
      throw new ReferenceError('Paste the full Bunna receipt link or scan its QR code.');
    }
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length < 16 || bytes.length > 256 || bytes.toString('base64') !== value) {
      throw new ReferenceError('Paste the full Bunna receipt link or scan its QR code.');
    }
  } else if (provider.code === 'zamzam') {
    if (!/^\d{1,12}$/.test(value)) {
      throw new ReferenceError('Enter the receipt number from the ZamZam receipt link.');
    }
  } else if (provider.code === 'ebirr') {
    if (!/^[A-Za-z0-9_-]{2,40}\/[A-Za-z0-9_-]{4,128}$/.test(value)) {
      throw new ReferenceError('Paste the full eBirr receipt link (receipt.ebirr.com/{tenant}/{token}).');
    }
  } else if (['siinqee', 'nib', 'wegagen', 'ahadu', 'kaafimf', 'awash'].includes(provider.code)) {
    if (!/^[A-Za-z0-9_-]{4,128}$/.test(value)) {
      throw new ReferenceError(`Paste the full ${provider.name} receipt link.`);
    }
  } else {
    if (/[/\\?#%&\s]/.test(value) || value.includes('..') || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) {
      throw new ReferenceError(
        'A reference can only contain letters, digits, dots, dashes and underscores. Paste the full receipt link or just the reference.',
      );
    }
  }

  if (provider.refPattern) {
    let re: RegExp;
    try {
      re = new RegExp(provider.refPattern);
    } catch {
      throw new ReferenceError('This deposit method is misconfigured. Contact the agent.');
    }
    if (!re.test(value)) {
      throw new ReferenceError(provider.refHint ?? `That does not look like a ${provider.name} reference.`);
    }
  }

  const accountNumber = provider.accountDigits
    ? checkAccountSuffix(input.accountNumber ?? '', provider.accountDigits)
    : undefined;

  let phoneNumber: string | undefined;
  if (provider.requiresPhone) {
    if (!input.phoneNumber?.trim()) throw new ReferenceError(`Enter the payer's phone number for ${provider.name}.`);
    phoneNumber = provider.code === 'cbebirr' ? normalizeCbeBirrPhone(input.phoneNumber) : checkPhone(input.phoneNumber);
  }

  return { reference: value, accountNumber, phoneNumber };
}
