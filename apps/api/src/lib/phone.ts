export const PHONE_RE = /^\+[1-9]\d{7,14}$/;

/** Normalises a phone number shared by Telegram into E.164, or returns null. */
export function normalizePhone(raw: string): string | null {
  const cleaned = raw.trim().replace(/[\s()\-.]/g, '');
  const candidate = cleaned.startsWith('+')
    ? cleaned
    : `+${cleaned.startsWith('00') ? cleaned.slice(2) : cleaned}`;
  return PHONE_RE.test(candidate) ? candidate : null;
}
