/** Payout in minor units: stake × multiplier(hundredths), floored, capped. */
export function payoutFor(stake: bigint, multiplier: number, maxWin: bigint): bigint {
  if (!Number.isFinite(multiplier) || multiplier < 1) {
    throw new Error(`Invalid cashout multiplier: ${multiplier}`);
  }
  const hundredths = BigInt(Math.round(multiplier * 100));
  const raw = (stake * hundredths) / 100n;
  return raw > maxWin ? maxWin : raw;
}

export function parseStakeToMinor(text: string): bigint | null {
  const cleaned = text.trim().replace(/,/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ''] = cleaned.split('.');
  const minor = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  return minor > 0n ? minor : null;
}

export function formatMinor(minor: bigint): string {
  const whole = (minor / 100n).toString();
  const fraction = (minor % 100n).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
}
