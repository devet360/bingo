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

export const PATTERN_LABELS: Record<string, string> = {
  HORIZONTAL: 'Line',
  VERTICAL: 'Column',
  DIAGONAL: 'Diagonal',
  FOUR_CORNERS: 'Four corners',
  FULL_HOUSE: 'Full house',
};
