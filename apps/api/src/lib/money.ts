// Money never becomes a float. Inputs are validated integers in minor units
// (1 credit = 100 minor units) and converted to bigint at the edge.

export const BPS_DENOMINATOR = 10_000n;

/** Floor(bps share). Rounds in favour of the platform, never the payer. */
export function calculateBps(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error(`Invalid bps value: ${bps}`);
  }
  if (amount < 0n) throw new Error('amount must be non-negative');
  return (amount * BigInt(bps)) / BPS_DENOMINATOR;
}

export interface WithdrawalSplit {
  fee: bigint;
  net: bigint;
}

export function splitWithdrawalFee(amount: bigint, feeBps: number): WithdrawalSplit {
  const fee = calculateBps(amount, feeBps);
  return { fee, net: amount - fee };
}

/** JSON-safe representation: minor units are sent as decimal strings. */
export function minorToWire(amount: bigint | null | undefined): string | null {
  if (amount === null || amount === undefined) return null;
  return amount.toString();
}
