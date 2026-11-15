import type { PaymentMethod } from './types';

export function formatCredits(
  value: string | number | bigint | null | undefined,
  options: { cents?: boolean } = {},
): string {
  if (value === null || value === undefined) return '—';
  const { cents = true } = options;
  const amount = BigInt(value);
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const whole = (abs / 100n).toString();
  const fraction = (abs % 100n).toString().padStart(2, '0');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = cents ? `${grouped}.${fraction}` : grouped;
  return `${negative ? '−' : ''}${body}`;
}

/** Compact credits: drops a `.00` tail so stakes read "10" instead of "10.00". */
export function formatStake(value: string | null | undefined): string {
  const text = formatCredits(value);
  return text.endsWith('.00') ? text.slice(0, -3) : text;
}

/** Parses a credits input ("12.5") into integer minor units, or null when invalid. */
export function creditsToMinor(input: string): number | null {
  const text = input.trim().replace(/,/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const minor = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(minor);
}

export function minorToCreditsInput(value: string | null | undefined): string {
  if (!value) return '';
  const amount = BigInt(value);
  const whole = amount / 100n;
  const fraction = amount % 100n;
  return fraction === 0n ? whole.toString() : `${whole}.${fraction.toString().padStart(2, '0')}`;
}

export function formatCountdown(
  target: string | number | Date | null | undefined,
  now: number = Date.now(),
): string {
  if (target === null || target === undefined) return '—';
  const end = typeof target === 'number' ? target : new Date(target).getTime();
  const remaining = Math.max(0, end - now);
  const totalSeconds = Math.ceil(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function formatClock(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function timeAgo(value: string | null | undefined): string {
  if (!value) return '—';
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function initials(name: string | null | undefined): string {
  if (!name) return '·';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
}

export const PAYMENT_METHODS = [
  { value: 'MOBILE_MONEY', label: 'Mobile money' },
  { value: 'BANK_TRANSFER', label: 'Bank transfer' },
  { value: 'CASH', label: 'Cash agent' },
  { value: 'CARD', label: 'Card' },
  { value: 'CRYPTO', label: 'Crypto' },
] as const;

export interface PaymentProvider {
  /** Stored on `AgentPaymentAccount.provider` and matched against `DepositProvider.code`. */
  code: string;
  label: string;
  method: PaymentMethod;
}

/** Named rails an agent can accept money on. Mirrors the seeded `DepositProvider` catalogue. */
export const PAYMENT_PROVIDERS: PaymentProvider[] = [
  { code: 'telebirr', label: 'Telebirr', method: 'MOBILE_MONEY' },
  { code: 'mpesa', label: 'M-Pesa', method: 'MOBILE_MONEY' },
  { code: 'cbebirr', label: 'CBE Birr', method: 'MOBILE_MONEY' },
  { code: 'siinqee', label: 'Siinqee Bank', method: 'MOBILE_MONEY' },
  { code: 'nib', label: 'Nib International Bank', method: 'MOBILE_MONEY' },
  { code: 'wegagen', label: 'Wegagen Bank', method: 'MOBILE_MONEY' },
  { code: 'ahadu', label: 'Ahadu Bank', method: 'MOBILE_MONEY' },
  { code: 'kaafimf', label: 'KAAFI Microfinance', method: 'MOBILE_MONEY' },
  { code: 'cbe', label: 'CBE', method: 'BANK_TRANSFER' },
  { code: 'boa', label: 'Bank of Abyssinia', method: 'BANK_TRANSFER' },
  { code: 'dashen', label: 'Dashen Bank', method: 'BANK_TRANSFER' },
  { code: 'awash', label: 'Awash Bank', method: 'BANK_TRANSFER' },
  { code: 'bunna', label: 'Bunna International Bank', method: 'BANK_TRANSFER' },
  { code: 'zamzam', label: 'ZamZam Bank', method: 'BANK_TRANSFER' },
  { code: 'zemen', label: 'Zemen Bank', method: 'BANK_TRANSFER' },
  { code: 'abay', label: 'Abay Bank', method: 'BANK_TRANSFER' },
  { code: 'addis', label: 'Addis International Bank', method: 'BANK_TRANSFER' },
  { code: 'amhara', label: 'Amhara Bank', method: 'BANK_TRANSFER' },
  { code: 'berhan', label: 'Berhan International Bank', method: 'BANK_TRANSFER' },
  { code: 'enat', label: 'Enat Bank', method: 'BANK_TRANSFER' },
  { code: 'global', label: 'Global Bank Ethiopia', method: 'BANK_TRANSFER' },
  { code: 'lion', label: 'Lion International Bank', method: 'BANK_TRANSFER' },
  { code: 'oromia', label: 'Oromia International Bank', method: 'BANK_TRANSFER' },
  { code: 'hibret', label: 'Hibret Bank', method: 'BANK_TRANSFER' },
  { code: 'hijra', label: 'Hijra Bank', method: 'BANK_TRANSFER' },
  { code: 'shabelle', label: 'Shabelle Bank', method: 'BANK_TRANSFER' },
  { code: 'goh', label: 'Goh Betoch Bank', method: 'BANK_TRANSFER' },
  { code: 'tsedey', label: 'Tsedey Bank', method: 'BANK_TRANSFER' },
  { code: 'gadaa', label: 'Gadaa Bank', method: 'BANK_TRANSFER' },
  { code: 'rammis', label: 'Rammis Bank', method: 'BANK_TRANSFER' },
  { code: 'cash', label: 'Cash agent', method: 'CASH' },
];

const PROVIDER_CODES = new Set(PAYMENT_PROVIDERS.map((provider) => provider.code));

export function findPaymentProvider(code: string | null | undefined): PaymentProvider | null {
  if (!code) return null;
  return PAYMENT_PROVIDERS.find((provider) => provider.code === code) ?? null;
}

/** Human label for a stored provider code; free-text values pass through unchanged. */
export function providerLabel(code: string | null | undefined): string {
  if (!code) return '';
  return findPaymentProvider(code)?.label ?? code;
}

export function isPaymentProviderCode(value: string | null | undefined): boolean {
  return Boolean(value && PROVIDER_CODES.has(value));
}

export const PATTERN_LABELS: Record<string, string> = {
  HORIZONTAL: 'Line',
  VERTICAL: 'Column',
  DIAGONAL: 'Diagonal',
  FOUR_CORNERS: 'Four corners',
  FULL_HOUSE: 'Full house',
};
