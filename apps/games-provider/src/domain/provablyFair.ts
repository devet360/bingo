import { createHash } from 'node:crypto';

export const DEFAULT_CLIENT_SEEDS: readonly string[] = [
  'stratos_slot_1_00000001',
  'stratos_slot_2_00000002',
  'stratos_slot_3_00000003',
];

export const TWO_POW_52 = 4503599627370496; // 2^52

/**
 * Multiplier growth curve matching classic Aviator pacing:
 * M(t) = e^(0.00006 * t_ms)
 * ~11.55s -> 2.00x | ~26.82s -> 5.00x | ~38.38s -> 10.00x
 */
export function multiplierAtElapsedMs(elapsedMs: number): number {
  if (elapsedMs <= 0) return 1.0;
  const raw = Math.exp(0.00006 * elapsedMs);
  return Math.max(1.0, Math.floor(raw * 100) / 100);
}

export function elapsedMsForMultiplier(multiplier: number): number {
  if (multiplier <= 1.0) return 0;
  return Math.ceil(Math.log(multiplier) / 0.00006);
}

/**
 * Canonical 97% RTP Provably Fair crash point derivation from a SHA-512 hex digest.
 * Uses the first 52 bits (13 hex chars) of the SHA-512 hash.
 * 1 in 33 rounds (~3.03% house edge -> ~96.97% RTP) crashes instantly at 1.00x.
 */
export function deriveCrashPointFromSha512Hex(sha512Hex: string): {
  hexSlice52Bit: string;
  decimalValue: number;
  crashPoint: number;
} {
  const hexSlice52Bit = sha512Hex.slice(0, 13);
  const decimalValue = Number.parseInt(hexSlice52Bit, 16);

  if (!Number.isFinite(decimalValue)) {
    return { hexSlice52Bit, decimalValue: 0, crashPoint: 1.0 };
  }

  // Instant crash check (3.03% probability -> 96.97% theoretical RTP)
  if (decimalValue % 33 === 0) {
    return { hexSlice52Bit, decimalValue, crashPoint: 1.0 };
  }

  const raw = Math.floor((100 * TWO_POW_52 - decimalValue) / (TWO_POW_52 - decimalValue)) / 100;
  const crashPoint = Math.max(1.0, Math.min(raw, 100000.0));
  return { hexSlice52Bit, decimalValue, crashPoint };
}

export function buildCombinedSeedInput(
  serverSeed: string,
  clientSeeds: readonly string[]
): string {
  const s1 = clientSeeds[0] ?? DEFAULT_CLIENT_SEEDS[0];
  const s2 = clientSeeds[1] ?? DEFAULT_CLIENT_SEEDS[1];
  const s3 = clientSeeds[2] ?? DEFAULT_CLIENT_SEEDS[2];
  return `${serverSeed}:${s1}:${s2}:${s3}`;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function sha512Hex(input: string): string {
  return createHash('sha512').update(input).digest('hex');
}

export function deriveCrashPoint(digestHex: string): number {
  return deriveCrashPointFromSha512Hex(digestHex).crashPoint;
}
