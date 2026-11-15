import { calculateBps } from '../lib/money';

export interface RoundEconomics {
  grossPot: bigint;
  rakeAmount: bigint;
  prizePool: bigint;
}

export function computeEconomics(grossPot: bigint, rakeBps: number): RoundEconomics {
  const rakeAmount = calculateBps(grossPot, rakeBps);
  return { grossPot, rakeAmount, prizePool: grossPot - rakeAmount };
}

/**
 * MAIN rooms pay a guaranteed prize. The rake is whatever the pot leaves over;
 * a shortfall is negative and funded by treasury.
 */
export function computeFixedEconomics(grossPot: bigint, fixedPrize: bigint): RoundEconomics {
  return { grossPot, rakeAmount: grossPot - fixedPrize, prizePool: fixedPrize };
}

/**
 * Equal shares; the first `remainder` winners receive one extra minor unit so
 * the payouts always sum exactly to the prize pool.
 */
export function splitPrize(prizePool: bigint, winnerCount: number): bigint[] {
  if (!Number.isInteger(winnerCount) || winnerCount <= 0) {
    throw new Error('winnerCount must be a positive integer');
  }
  const count = BigInt(winnerCount);
  const base = prizePool / count;
  const remainder = Number(prizePool % count);
  return Array.from({ length: winnerCount }, (_, index) =>
    index < remainder ? base + 1n : base,
  );
}
